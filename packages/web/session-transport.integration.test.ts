import { expect, test } from "bun:test";
import { DEFAULT_HANDLING, Input } from "@42tris/core";
import type { ServerMessage } from "@42tris/protocol";
import { createApp } from "../server/src/app";
import { Rooms } from "../server/src/rooms";
import { Session } from "./src/session";
import { SessionDiagnostics } from "./src/session-diagnostics";
import { connectSession } from "./src/session-transport";

function storage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem(key: string, value: string) { values.set(key, value); },
    removeItem(key: string) { values.delete(key); } };
}

async function wait(predicate: () => boolean) {
  const end = performance.now() + 2000;
  while (!predicate() && performance.now() < end) await Bun.sleep(2);
  expect(predicate()).toBe(true);
}

test("native transport and Session: identity, adaptive pongs, duplicate lease, gameplay, reconnect and resume", async () => {
  let now = 0;
  const rooms = new Rooms(() => now);
  const app = createApp({ rooms, scheduled: false }).listen({ hostname: "127.0.0.1", port: 0 });
  await app.modules;
  const sessions: Session[] = [];
  function client(credentials = storage()) {
    const diagnostics = new SessionDiagnostics(), messages: ServerMessage[] = [], sockets: WebSocket[] = [];
    const session = new Session({ now: () => now, storage: credentials, profile: storage(), clearKeys() {}, diagnostics, inputLeadMs: "auto",
      connect(callbacks) {
        return connectSession(`http://127.0.0.1:${app.server!.port}`, {
          ...callbacks, message(value) { messages.push(value); callbacks.message(value); },
        }, diagnostics, url => { const socket = new WebSocket(url); sockets.push(socket); return socket; });
      } });
    sessions.push(session); session.start();
    return { session, diagnostics, messages, sockets, credentials };
  }
  async function advance(ms: number) {
    now += ms; rooms.tick(); rooms.snapshots();
    for (const session of sessions) if (session.active) session.tick();
    await Bun.sleep(5);
  }
  try {
    const a = client(), b = client();
    await wait(() => a.session.connected && b.session.connected);
    const id = a.session.playerId, token = a.credentials.getItem("42tris.resume");
    expect(id).not.toBe(""); expect(token).not.toBeNull();
    const duplicate = client(a.credentials);
    await wait(() => duplicate.session.duplicate);
    expect(duplicate.messages.some(m => m.type === "error" && m.code === "ALREADY_CONNECTED")).toBe(true);
    expect(a.session.connected).toBe(true); duplicate.session.stop();
    a.session.send({ type: "join", code: "AAAAAA" });
    await wait(() => a.messages.some(m => m.type === "error" && m.code === "ROOM_NOT_FOUND"));
    a.session.send({ type: "create", requestId: "transport", options: { firstTo: 3, width: 10, maxPlayers: 2, mode: "practice", attacksEnabled: false } });
    await wait(() => !!a.session.room);
    b.session.send({ type: "join", code: a.session.room!.code });
    await wait(() => b.session.room?.players.length === 2 && a.session.room?.players.length === 2);
    for (const c of [a, b]) c.session.send({ type: "ready", ready: true, handling: DEFAULT_HANDLING });
    await wait(() => a.session.room?.phase === "countdown" && b.session.room?.phase === "countdown");
    for (let i = 0; i < 60; i++) await advance(100);
    await wait(() => a.session.canPlay && b.session.canPlay);
    expect(a.messages.some(m => m.type === "pong")).toBe(true);
    expect(a.diagnostics.snapshot().rtt.samples).toBeGreaterThanOrEqual(5);
    expect(a.diagnostics.snapshot().clock.calibrated).toBe(true);
    const decision = a.diagnostics.snapshot().adaptive.decisions;
    expect(decision).toHaveLength(1);
    a.session.input(Input.RotateCw);
    expect(a.session.pending[0].seq).toBe(1);
    expect(a.session.pending[0].subframe).toBeGreaterThanOrEqual(0);
    await wait(() => !!a.session.checkpoint?.owner.pendingAccepted.length);
    await advance(200);
    await wait(() => a.session.checkpoint!.owner.resolvedThroughSeq === 1);
    expect(a.session.pending).toEqual([]);
    expect(a.diagnostics.snapshot().corrections.compared).toBeGreaterThan(0);
    expect(a.diagnostics.snapshot().adaptive.decisions).toEqual(decision);
    const generation = a.session.checkpoint!.owner.generation;
    a.sockets[0].close();
    await wait(() => !a.session.connected && b.session.room?.phase === "paused");
    a.session.retry();
    await wait(() => a.session.connected && a.session.room?.phase === "countdown");
    expect(a.session.playerId).toBe(id); expect(a.credentials.getItem("42tris.resume")).toBe(token);
    expect(a.session.checkpoint!.owner.generation).toBeGreaterThan(generation);
    for (let i = 0; i < 60; i++) await advance(100);
    await wait(() => a.session.canPlay && b.session.canPlay);
    a.session.send({ type: "leave" });
    await wait(() => a.session.room === null);
    expect(a.messages.some(m => m.type === "left")).toBe(true);
  } finally {
    for (const session of sessions) session.stop();
    await app.stop(true);
  }
});
