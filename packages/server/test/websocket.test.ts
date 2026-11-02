import { afterEach, expect, test } from "bun:test";
import { connect } from "node:net";
import { DEFAULT_HANDLING, Input } from "@42tris/core";
import type { Checkpoint, ClientCommand, ServerMessage } from "@42tris/protocol";
import { createClient } from "../../protocol/src/client";
import { createApp } from "../src/app";
import { Rooms } from "../src/rooms";

const stops: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const stop of stops.splice(0)) await stop(); });

async function server(production = false) {
  let now = 0;
  const rooms = new Rooms(() => now);
  const app = createApp({ rooms, scheduled: false, production, ...(production ? { assets: `${import.meta.dir}/fixtures/public` } : {}) }).listen({ port: 0, hostname: "127.0.0.1" });
  await app.modules;
  stops.push(() => app.stop(true));
  const url = `http://127.0.0.1:${app.server!.port}`;
  return { app, rooms, url, advance(ms: number) { now += ms; rooms.tick(); rooms.snapshots(); } };
}

async function client(url: string, resumeToken?: string) {
  const socket = new WebSocket(url.replace("http", "ws") + "/ws");
  const messages: ServerMessage[] = [];
  socket.addEventListener("message", event => messages.push(JSON.parse(String(event.data))));
  await new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = reject; });
  stops.unshift(async () => { socket.close(); });
  const send = (command: ClientCommand) => socket.send(JSON.stringify(command));
  async function wait<T extends ServerMessage["type"]>(type: T, predicate: (m: Extract<ServerMessage, { type: T }>) => boolean = () => true, after = 0) {
    const end = performance.now() + 2000;
    while (performance.now() < end) {
      const message = messages.slice(after).find(m => m.type === type && predicate(m as Extract<ServerMessage, { type: T }>));
      if (message) return message as Extract<ServerMessage, { type: T }>;
      await Bun.sleep(2);
    }
    throw new Error(`Timed out waiting for ${type}: ${JSON.stringify(messages.slice(-3))}`);
  }
  send({ type: "hello", name: "Socket Guest", ...(resumeToken ? { resumeToken } : {}) });
  const welcome = await wait("welcome");
  let checkpointNonce = 0;
  async function checkpoint() {
    const after = messages.length;
    const nonce = `checkpoint-${++checkpointNonce}`;
    send({ type: "resync" });
    send({ type: "ping", nonce });
    const pong = await wait("pong", m => m.nonce === nonce, after);
    const checkpoint = messages.slice(after, messages.indexOf(pong)).reverse().find(m => m.type === "checkpoint");
    if (!checkpoint || checkpoint.type !== "checkpoint") throw new Error("Missing resync checkpoint before pong");
    return checkpoint;
  }
  async function close() { if (socket.readyState === WebSocket.CLOSED) return; await new Promise<void>(resolve => { socket.addEventListener("close", () => resolve(), { once: true }); socket.close(); }); }
  return { socket, messages, welcome, send, wait, checkpoint, close };
}

test("real Elysia sockets: create, join, prepare, inputs, pause/resume, FT result, rematch and invalid commands", async () => {
  const s = await server();
  const a = await client(s.url);
  const b = await client(s.url);
  a.send({ type: "create", requestId: "network", options: { firstTo: 1, mode: "competitive", attacksEnabled: true } });
  const created = await a.wait("roomState");
  b.send({ type: "join", code: created.room.code });
  await b.wait("roomState");
  for (const c of [a, b]) c.send({ type: "ready", ready: true, handling: DEFAULT_HANDLING });
  const prep = await a.wait("checkpoint", m => m.room.phase === "preparing");
  for (const c of [a, b]) c.send({ type: "prepared", matchId: prep.matchId!, preparationId: prep.room.preparationId });
  await a.wait("roomState", m => m.room.phase === "countdown");
  s.advance(3000);
  const playing = await a.wait("checkpoint", m => m.room.phase === "playing");
  a.send({ type: "inputBatch", matchId: playing.matchId!, generation: playing.owner.generation, epoch: playing.owner.epoch,
    items: [{ seq: 1, frame: 0, subframe: 0.25, input: Input.LeftDown }] });
  await a.wait("checkpoint", m => m.owner.pendingAccepted.length === 1);
  s.advance(200);
  expect((await a.checkpoint()).owner.resolvedThroughSeq).toBe(1);
  await b.close();
  await a.wait("roomState", m => m.room.phase === "paused");
  const frozenFrame = (await a.checkpoint()).state!.frame;
  s.advance(1000);
  expect((await a.checkpoint()).state!.frame).toBe(frozenFrame);
  const resumed = await client(s.url, b.welcome.resumeToken);
  expect(resumed.welcome.playerId).toBe(b.welcome.playerId);
  expect(resumed.welcome.resumeToken).toBe(b.welcome.resumeToken);
  const resumePrep = await resumed.wait("checkpoint", m => m.room.phase === "preparing");
  for (const c of [a, resumed]) c.send({ type: "prepared", matchId: resumePrep.matchId!, preparationId: resumePrep.room.preparationId });
  await resumed.wait("roomState", m => m.room.phase === "countdown");
  s.advance(3000);
  await resumed.wait("checkpoint", m => m.room.phase === "playing");
  // Repeated hard drops top out one real board and exercise Match's round/set scoring.
  let snapshot = await resumed.checkpoint();
  for (let i = 0; i < 20 && snapshot.room.phase === "playing"; i++) {
    resumed.send({ type: "inputBatch", matchId: snapshot.matchId!, generation: snapshot.owner.generation, epoch: snapshot.owner.epoch,
      items: [{ seq: snapshot.owner.nextSeq, frame: snapshot.clock.currentTargetFrame, subframe: 0.25, input: Input.HardDrop }] });
    const accepted = await resumed.checkpoint();
    expect(accepted.owner.pendingAccepted.some(input => input.seq === snapshot.owner.nextSeq)).toBe(true);
    s.advance(120);
    snapshot = await resumed.checkpoint();
  }
  expect(snapshot.room.phase).toBe("setResult");
  expect(snapshot.state!.scores[snapshot.state!.roster.indexOf(a.welcome.playerId)]).toBe(1);
  expect(snapshot.events.some(e => e.event.type === "setEnd" && e.event.reason === "firstTo")).toBe(true);
  const oldId = snapshot.matchId;
  for (const c of [a, resumed]) c.send({ type: "ready", ready: true, handling: DEFAULT_HANDLING });
  const rematch = await resumed.wait("checkpoint", m => m.room.phase === "preparing" && m.matchId !== oldId);
  expect(rematch.state!.scores).toEqual([0, 0]);
  for (const c of [a, resumed]) c.send({ type: "prepared", matchId: rematch.matchId!, preparationId: rematch.room.preparationId });
  await resumed.wait("roomState", m => m.room.phase === "countdown" && m.room.matchId === rematch.matchId);
  s.advance(3000);
  expect((await a.checkpoint()).room.phase).toBe("playing");
  a.socket.send(JSON.stringify({ type: "inputBatch", playerId: b.welcome.playerId }));
  expect((await a.wait("error")).code).toBe("INVALID_MESSAGE");
  const after = a.messages.length;
  a.socket.send("not JSON");
  expect((await a.wait("error", () => true, after)).code).toBe("INVALID_MESSAGE");
  a.send({ type: "ping", nonce: "clock" });
  expect((await a.wait("pong", m => m.nonce === "clock")).nonce).toBe("clock");
});

test("sockets receive the same automatic next round after the result countdown", async () => {
  const s = await server();
  const a = await client(s.url);
  const b = await client(s.url);
  a.send({ type: "create", requestId: "automatic-round", options: { firstTo: 2, mode: "competitive", attacksEnabled: true } });
  const created = await a.wait("roomState");
  b.send({ type: "join", code: created.room.code });
  await b.wait("roomState");
  for (const c of [a, b]) c.send({ type: "ready", ready: true, handling: DEFAULT_HANDLING });
  const prep = await a.wait("checkpoint", m => m.room.phase === "preparing");
  for (const c of [a, b]) c.send({ type: "prepared", matchId: prep.matchId!, preparationId: prep.room.preparationId });
  await a.wait("roomState", m => m.room.phase === "countdown");
  s.advance(3000);
  let snapshot = await b.checkpoint();
  for (let i = 0; i < 25 && snapshot.room.phase === "playing"; i++) {
    b.send({ type: "inputBatch", matchId: snapshot.matchId!, generation: snapshot.owner.generation, epoch: snapshot.owner.epoch,
      items: [{ seq: snapshot.owner.nextSeq, frame: snapshot.clock.currentTargetFrame, subframe: 0.25, input: Input.HardDrop }] });
    await b.checkpoint();
    s.advance(120);
    snapshot = await b.checkpoint();
  }
  expect(snapshot.room.phase).toBe("roundResult");
  expect((await a.checkpoint()).room.startsAt).toBe(snapshot.room.startsAt);
  s.advance(2999);
  expect((await a.checkpoint()).state!.round).toBe(1);
  s.advance(1);
  const [first, second] = await Promise.all([a.checkpoint(), b.checkpoint()]);
  expect([first.room.phase, second.room.phase]).toEqual(["playing", "playing"]);
  expect([first.state!.round, second.state!.round]).toEqual([2, 2]);
  expect(first.state).toEqual(second.state);
});

test("resync waits past snapshots already queued on the socket", async () => {
  const s = await server();
  const a = await client(s.url);
  a.send({ type: "create", requestId: "queued-snapshot", options: { firstTo: 1, mode: "competitive", attacksEnabled: true } });
  await a.wait("roomState");
  s.rooms.snapshots();
  s.advance(123);
  expect((await a.checkpoint()).serverNow).toBe(123);
});

test("three sockets: late disconnect deadlines forfeit seats and preserve remaining FFA Match", async () => {
  const s = await server();
  const clients = await Promise.all([client(s.url), client(s.url), client(s.url)]);
  const [a, b, c] = clients;
  a.send({ type: "create", requestId: "ffa", options: { firstTo: 3, mode: "competitive", attacksEnabled: true } });
  const created = await a.wait("roomState");
  for (const guest of [b, c]) { guest.send({ type: "join", code: created.room.code }); await guest.wait("roomState"); }
  for (const guest of clients) guest.send({ type: "ready", ready: true, handling: DEFAULT_HANDLING });
  const prep = await a.wait("checkpoint", m => m.room.phase === "preparing");
  for (const guest of clients) guest.send({ type: "prepared", matchId: prep.matchId!, preparationId: prep.room.preparationId });
  await a.wait("roomState", m => m.room.phase === "countdown");
  s.advance(3000);
  const match = [...s.rooms.rooms.values()][0].match;
  await b.close();
  await a.wait("roomState", m => m.room.phase === "paused");
  s.advance(20_000);
  await c.close();
  await a.wait("roomState", m => m.room.players.filter(p => !p.connected).length === 2);
  s.advance(20_000);
  const state = await a.checkpoint();
  expect(state.state!.players[state.state!.roster.indexOf(b.welcome.playerId)].withdrawn).toBe(true);
  expect(state.room.phase).toBe("paused");
  expect([...s.rooms.rooms.values()][0].match).toBe(match);
  s.advance(20_000);
  expect((await a.checkpoint()).room.phase).toBe("setResult");
});

test("Eden exports type the real health and websocket routes", async () => {
  const s = await server();
  const eden = createClient(s.url);
  const health = await eden.api.health.get();
  expect(health.data?.ok).toBe(true);
  const socket = eden.ws.subscribe();
  const response = await new Promise<ServerMessage>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Eden timeout")), 2000);
    socket.on("open", () => socket.send({ type: "hello", name: "Eden" }));
    socket.subscribe(message => { clearTimeout(timeout); resolve(message.data); });
  });
  expect(response.type).toBe("welcome");
  socket.close();
});

test("production serves only enumerated build files and rejects foreign origins", async () => {
  const s = await server(true);
  expect(await (await fetch(s.url + "/")).text()).toContain("server-static-fixture");
  expect((await fetch(s.url + "/api/health")).status).toBe(200);
  for (const path of ["/%2e%2e/package.json", "/..%2f..%2fpackage.json", "/%2e%2e%5cpackage.json", "/.env"]) {
    expect((await fetch(s.url + path)).status).toBe(404);
  }
  const response = await fetch(s.url + "/ws", { headers: { Origin: "https://untrusted.example", Upgrade: "websocket" } });
  expect(response.status).toBe(403);
});

test("native websocket ping/pong leaves an idle browser-style client connected beyond six seconds", async () => {
  const app = createApp().listen({ port: 0, hostname: "127.0.0.1" });
  stops.push(() => app.stop(true));
  const a = await client(`http://127.0.0.1:${app.server!.port}`);
  await Bun.sleep(6500);
  expect(a.socket.readyState).toBe(WebSocket.OPEN);
  a.send({ type: "ping", nonce: "after-heartbeat" });
  expect((await a.wait("pong")).nonce).toBe("after-heartbeat");
}, 10_000);

test("real scheduler starts after countdown, commits behind wall time and publishes 20Hz checkpoints", async () => {
  const app = createApp().listen({ port: 0, hostname: "127.0.0.1" });
  stops.push(() => app.stop(true));
  const url = `http://127.0.0.1:${app.server!.port}`;
  const a = await client(url);
  const b = await client(url);
  a.send({ type: "create", requestId: "scheduled", options: { firstTo: 1, mode: "competitive", attacksEnabled: true } });
  const created = await a.wait("roomState");
  b.send({ type: "join", code: created.room.code });
  await b.wait("roomState");
  for (const c of [a, b]) c.send({ type: "ready", ready: true, handling: DEFAULT_HANDLING });
  const prep = await a.wait("checkpoint", m => m.room.phase === "preparing");
  for (const c of [a, b]) c.send({ type: "prepared", matchId: prep.matchId!, preparationId: prep.room.preparationId });
  await a.wait("roomState", m => m.room.phase === "countdown");
  await Bun.sleep(3300);
  const cp = await a.checkpoint();
  expect(cp.room.phase).toBe("playing");
  expect(cp.state!.frame).toBeGreaterThan(5);
  expect(cp.clock.currentTargetFrame - cp.state!.frame).toBeGreaterThanOrEqual(5);
  const snapshots = a.messages.filter(m => m.type === "checkpoint" && m.room.phase === "playing");
  expect(snapshots.length).toBeGreaterThanOrEqual(4);
  expect(snapshots.length).toBeLessThan(12);
}, 6000);

test("transport bounds oversized messages and connection attempts", async () => {
  const s = await server();
  const a = await client(s.url);
  const closed = new Promise<void>(resolve => a.socket.addEventListener("close", () => resolve(), { once: true }));
  a.socket.send(JSON.stringify({ type: "ping", nonce: "x".repeat(4096) }));
  await closed;
  expect(a.socket.readyState).toBe(WebSocket.CLOSED);
  let status = 0;
  for (let i = 0; i < 21; i++) status = (await fetch(s.url + "/ws", { headers: { Origin: "http://localhost:5173", Upgrade: "websocket" } })).status;
  expect(status).toBe(429);
});

test("native heartbeat closes a lease whose TCP connection stops answering pings", async () => {
  const app = createApp().listen({ port: 0, hostname: "127.0.0.1" });
  stops.push(() => app.stop(true));
  const tcp = connect({ port: app.server!.port!, host: "127.0.0.1" });
  stops.unshift(async () => { tcp.destroy(); });
  let bytes = Buffer.alloc(0);
  let upgraded = false;
  const closedByHeartbeat = new Promise<void>((resolve, reject) => {
    tcp.on("error", reject);
    tcp.on("data", data => {
      bytes = Buffer.concat([bytes, typeof data === "string" ? Buffer.from(data) : data]);
      if (!upgraded && bytes.includes("\r\n\r\n")) {
        upgraded = true;
        const message = Buffer.from(JSON.stringify({ type: "hello", name: "No pong" }));
        const mask = Buffer.from([1, 2, 3, 4]);
        const frame = Buffer.alloc(6 + message.length);
        frame[0] = 0x81;
        frame[1] = 0x80 | message.length;
        mask.copy(frame, 2);
        for (let i = 0; i < message.length; i++) frame[6 + i] = message[i] ^ mask[i % 4];
        tcp.write(frame);
      }
      if (bytes.includes("HEARTBEAT_TIMEOUT")) resolve();
    });
  });
  tcp.write(`GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${app.server!.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64")}\r\n\r\n`);
  await closedByHeartbeat;
  expect(bytes.includes('"type":"welcome"')).toBe(true);
}, 9000);

test("malformed-message spam consumes transport rate budget", async () => {
  const s = await server();
  const a = await client(s.url);
  const reason = new Promise<string>(resolve => a.socket.addEventListener("close", event => resolve(event.reason), { once: true }));
  for (let i = 0; i < 100; i++) a.socket.send("invalid JSON");
  expect(await reason).toBe("RATE_LIMIT");
});
