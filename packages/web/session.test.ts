import { describe, expect, test } from "bun:test";
import { Input, FRAME_MS } from "@42tris/core";
import { Match } from "@42tris/match";
import type { Checkpoint, ClientCommand, ServerMessage } from "@42tris/protocol";
import { Session, type SessionOptions } from "./src/session";

function storage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
}
function checkpoint(): Checkpoint {
  const match = new Match({ players: ["a", "b"], seed: 123 });
  return { type: "checkpoint", serverSequence: 1, serverNow: 0, matchId: "match", state: match.saveState(),
    room: { code: "ABCDEF", revision: 1, ownerId: "a", options: { firstTo: 3, maxPlayers: 4, mode: "competitive", attacksEnabled: true },
      phase: "playing", matchId: "match", preparationId: 1, startsAt: null, prepareDeadline: null,
      players: ["a", "b"].map(playerId => ({ playerId, name: playerId, skin: "classic", connected: true, ready: true, prepared: true, deadline: null, withdrawn: false })) },
    owner: { generation: 0, epoch: 0, nextSeq: 1, resolvedThroughSeq: 0, pendingAccepted: [], rejections: [] },
    clock: { currentTargetFrame: 0, simulationNow: 0, origin: 0, pausedTotal: 0, commitDelayMs: 100, frozen: false }, roundDurations: [], events: [] };
}
function harness() {
  let now = 0, clears = 0;
  const sent: ClientCommand[] = [];
  const sockets: Parameters<SessionOptions["connect"]>[0][] = [];
  const credentials = storage();
  const session = new Session({ now: () => now, storage: credentials, profile: storage(), clearKeys: () => { clears++; },
    connect(callbacks) { sockets.push(callbacks); return { send: command => { sent.push(command); }, close() {} }; } });
  session.start();
  sockets[0].open();
  const welcome = () => session.receive({ type: "welcome", guestSessionId: "a", playerId: "a", resumeToken: "token", name: "A", room: null, generation: 0, serverNow: now });
  welcome();
  const cp = checkpoint();
  session.receive(cp);
  return { session, sent, sockets, credentials, cp, welcome, time: (value: number) => { now = value; }, clears: () => clears,
    receive: (message: ServerMessage) => session.receive(message) };
}

describe("invitation links", () => {
  function invited(code: string) {
    const sent: ClientCommand[] = [];
    const sockets: Parameters<SessionOptions["connect"]>[0][] = [];
    const session = new Session({ now: () => 0, storage: storage(), profile: storage(), clearKeys() {},
      connect(callbacks) { sockets.push(callbacks); return { send: command => sent.push(command), close() {} }; } });
    session.joinInvite(code);
    session.start();
    const welcome = (room: Checkpoint["room"] | null = null) => sockets.at(-1)!.message({ type: "welcome", guestSessionId: "a", playerId: "a", resumeToken: "token", name: "A", room, generation: 0, serverNow: 0 });
    return { session, sockets, sent, welcome };
  }
  test("waits for welcome and sends only one join on the connection", () => {
    const h = invited("abcdef");
    h.sockets[0].open();
    expect(h.sent.map(c => c.type)).toEqual(["hello"]);
    h.welcome(); h.welcome();
    expect(h.sent.filter(c => c.type === "join")).toEqual([{ type: "join", code: "ABCDEF" }]);
  });
  test.each(["ROOM_NOT_FOUND", "ROOM_FULL", "ROOM_BUSY"] as const)("shows a useful %s error and permits manual joining", code => {
    const h = invited("ABCDEF");
    h.welcome();
    h.sockets[0].message({ type: "error", code, message: code });
    expect(h.session.status).toMatch(/Room (not found|is full|is unavailable)/);
    h.welcome();
    h.session.send({ type: "join", code: "ZZZZZZ" });
    expect(h.sent.filter(c => c.type === "join")).toEqual([{ type: "join", code: "ABCDEF" }, { type: "join", code: "ZZZZZZ" }]);
  });
  test("rejects malformed codes without sending a join", () => {
    const h = invited("bad");
    h.welcome();
    expect(h.session.notice).toContain("Invalid invitation code");
    expect(h.sent.some(c => c.type === "join")).toBe(false);
  });
  test("resumes existing membership and retries only an unacknowledged join after reconnect", () => {
    const h = invited("ABCDEF");
    h.welcome();
    h.session.stop(); h.session.start(); h.welcome(checkpoint().room);
    expect(h.sent.filter(c => c.type === "join")).toHaveLength(1);
    h.session.stop(); h.session.start(); h.welcome();
    expect(h.sent.filter(c => c.type === "join")).toHaveLength(1);
    const retry = invited("ABCDEF");
    retry.welcome(); retry.session.stop(); retry.session.start(); retry.welcome();
    expect(retry.sent.filter(c => c.type === "join")).toHaveLength(2);
  });
  test("keeps a different restored room instead of switching rooms", () => {
    const h = invited("ZZZZZZ");
    h.welcome(checkpoint().room);
    expect(h.sent.some(c => c.type === "join")).toBe(false);
    expect(h.session.notice).toContain("already in room ABCDEF");
  });
});

test("renames are normalized, retained on reconnect, and rolled back on server error", () => {
  const h = harness();
  h.session.rename("  New <Name>  ");
  expect(h.sent.at(-1)).toEqual({ type: "rename", name: "New Name" });
  h.session.receive({ type: "roomState", room: { ...h.cp.room, players: h.cp.room.players.map(p => p.playerId === "a" ? { ...p, name: "New Name" } : p) } });
  h.session.stop(); h.session.start(); h.sockets.at(-1)!.open();
  expect(h.sent.at(-1)).toMatchObject({ type: "hello", name: "New Name", resumeToken: "token" });
  h.session.receive({ type: "welcome", guestSessionId: "a", playerId: "a", resumeToken: "token", name: "New Name", room: null, generation: 0, serverNow: 0 });
  h.session.rename("Another");
  h.session.receive({ type: "error", code: "RATE_LIMIT", message: "Try again" });
  expect(h.session.name).toBe("New Name");
  expect(h.session.status).toContain("Try again");
});

describe("owner session", () => {
  test("predicts immediately, batches at 34ms, and restores accepted inputs only once", () => {
    const h = harness();
    h.time(5); h.session.input(Input.LeftDown); h.session.input(Input.LeftUp);
    expect(h.session.prediction!.gameState().state.x).toBe(2);
    expect(h.sent.some(c => c.type === "inputBatch")).toBe(false);
    h.session.tick();
    const batch = h.sent.find(c => c.type === "inputBatch");
    expect(batch?.type === "inputBatch" && batch.items.length).toBe(2);
    const items = h.session.pending.map((i, index) => ({ seq: i.seq, frame: i.frame, subframe: i.subframe, input: i.input, order: index + 1 }));
    h.cp.owner.pendingAccepted = items;
    h.cp.owner.nextSeq = 3;
    h.cp.state!.inputs = items.map(i => ({ ...i, player: "a", epoch: 0 }));
    h.cp.serverSequence++;
    h.receive(h.cp);
    expect(h.session.prediction!.gameState().state.x).toBe(2);
    h.time(10); h.session.input(Input.RightDown); h.session.tick();
    expect(h.sent.filter(c => c.type === "inputBatch")).toHaveLength(1);
    h.time(40); h.session.tick();
    expect(h.sent.filter(c => c.type === "inputBatch")).toHaveLength(2);
  });
  test("drops settled later sequences even when an earlier accepted input is unresolved", () => {
    const h = harness();
    h.session.input(Input.LeftDown); h.session.input(Input.LeftUp);
    const first = h.session.pending[0];
    h.cp.owner.nextSeq = 3;
    h.cp.owner.pendingAccepted = [{ ...first, order: 7 }];
    h.cp.state!.inputs = [{ ...first, order: 7, player: "a" }];
    h.cp.serverSequence++;
    h.receive(h.cp);
    expect(h.session.pending.map(i => i.seq)).toEqual([1]);
    h.session.input(Input.Hold);
    expect(h.session.pending.at(-1)!.seq).toBe(3);
  });
  test("generation invalidates keys and queue, starts at server nextSeq, and freezes pause", () => {
    const h = harness();
    h.session.input(Input.LeftDown);
    const cleared = h.clears();
    h.cp.owner.generation = 8; h.cp.owner.nextSeq = 12;
    h.cp.serverSequence++; h.cp.room.phase = "paused"; h.cp.clock.frozen = true;
    h.receive(h.cp);
    expect(h.session.pending).toHaveLength(0);
    expect(h.clears()).toBeGreaterThan(cleared);
    h.time(1000); h.session.tick();
    expect(h.session.prediction!.atMs).toBe(0);
    h.cp.serverSequence++; h.cp.room.phase = "playing"; h.cp.clock.frozen = false; h.cp.serverNow = 1000;
    h.receive(h.cp); h.session.input(Input.RightDown);
    expect(h.session.pending[0].seq).toBe(12);
  });
  test("rejected late key release releases all controls and waits for a fresh generation", () => {
    const h = harness();
    h.session.input(Input.LeftUp);
    h.cp.owner.rejections = [{ seq: 1, code: "INPUT_REJECTED" }];
    h.cp.owner.nextSeq = 2; h.cp.serverSequence++;
    h.receive(h.cp);
    expect(h.sent.at(-1)).toEqual({ type: "releaseControls" });
    expect(h.session.canPlay).toBe(false);
    h.session.input(Input.HardDrop);
    expect(h.session.pending).toHaveLength(0);
    h.cp.owner.generation++; h.cp.owner.nextSeq = 1; h.cp.serverSequence++;
    h.receive(h.cp);
    expect(h.session.canPlay).toBe(true);
  });
  test("refresh hello keeps credentials; duplicate retry is bounded and new guest is explicit", () => {
    const h = harness();
    h.sockets[0].close();
    expect(h.session.prediction).toBeNull();
    h.time(601); h.session.tick(); h.sockets[1].open();
    expect(h.sent.at(-1)).toMatchObject({ type: "hello", resumeToken: "token" });
    h.receive({ type: "error", code: "ALREADY_CONNECTED", message: "Connected" });
    for (let i = 1; i <= 10; i++) { h.time(i * 5000); h.session.tick(); h.receive({ type: "error", code: "ALREADY_CONNECTED", message: "Connected" }); }
    expect(h.sockets.length).toBeLessThanOrEqual(5);
    expect(h.credentials.getItem("42tris.resume")).toBe("token");
    h.session.anotherGuest(); h.sockets.at(-1)!.open();
    expect(h.sent.at(-1)).toMatchObject({ type: "hello", resumeToken: undefined });
    expect(h.session.room).toBeNull();
  });
  test("refresh automatically resumes after a half-open lease expires at six seconds", () => {
    const h = harness();
    h.session.stop();
    h.session.start();
    const attempts: number[] = [];
    const initialSockets = h.sockets.length;
    for (const now of [0, 600, 1800, 4200, 8200]) {
      h.time(now);
      h.session.tick();
      expect(h.sockets).toHaveLength(initialSockets + attempts.length);
      h.sockets.at(-1)!.open();
      attempts.push(now);
      expect(h.sent.at(-1)).toMatchObject({ type: "hello", resumeToken: "token" });
      if (now < 6000) h.sockets.at(-1)!.message({ type: "error", code: "ALREADY_CONNECTED", message: "Lease still live" });
      else h.welcome();
    }
    expect(attempts.at(-1)).toBe(8200);
    expect(h.session.connected).toBe(true);
    expect(h.session.duplicate).toBe(false);
    expect(h.session.playerId).toBe("a");
    expect(h.credentials.getItem("42tris.resume")).toBe("token");
  });
  test("expired resume clears game and keeps the restart notice after welcome", () => {
    const h = harness();
    h.receive({ type: "error", code: "SESSION_EXPIRED", message: "Unknown" });
    h.welcome();
    expect(h.session.checkpoint).toBeNull();
    expect(h.session.notice).toContain("server restarted");
  });
  test("clock corrections never move prediction backwards; stale snapshots suspend inputs", () => {
    const h = harness();
    h.time(90); h.session.tick();
    const at = h.session.prediction!.atMs;
    h.cp.serverSequence++; h.cp.serverNow = 100; h.cp.clock.simulationNow = 60;
    h.receive(h.cp);
    expect(h.session.prediction!.atMs).toBeGreaterThanOrEqual(at);
    h.session.input(Input.Hold);
    const item = h.session.pending[0];
    expect((item.frame + item.subframe) * FRAME_MS).toBeGreaterThanOrEqual(at - 1e-10);
    h.time(2100); h.session.tick();
    expect(h.session.canPlay).toBe(false);
    expect(h.sent.at(-1)).toEqual({ type: "resync" });
  });
  test("sequence gap retransmits existing sequence rather than creating another", () => {
    const h = harness();
    h.session.input(Input.LeftDown); h.session.tick();
    h.receive({ type: "error", code: "SEQ_GAP", message: "Gap" });
    h.cp.serverSequence++; h.receive(h.cp);
    h.time(40); h.session.tick();
    const batches = h.sent.filter(c => c.type === "inputBatch");
    expect(batches).toHaveLength(2);
    expect(batches[0]).toEqual(batches[1]);
  });
  test("shares the selected skin on hello and when the local selection changes", () => {
    let skin = "four";
    const sent: ClientCommand[] = [];
    const sockets: Parameters<SessionOptions["connect"]>[0][] = [];
    const session = new Session({ now: () => 0, storage: storage(), profile: storage(), clearKeys() {}, skin: () => skin,
      connect(callbacks) { sockets.push(callbacks); return { send: command => { sent.push(command); }, close() {} }; } });
    session.start();
    sockets[0].open();
    expect(sent[0]).toMatchObject({ type: "hello", skin: "four" });
    session.receive({ type: "welcome", guestSessionId: "a", playerId: "a", resumeToken: "token", name: "A", room: null, generation: 0, serverNow: 0 });
    session.tick();
    expect(sent.filter(command => command.type === "skin")).toHaveLength(0);
    skin = "tetrio";
    session.tick();
    expect(sent.filter(command => command.type === "skin")).toEqual([{ type: "skin", skin: "tetrio" }]);
    session.tick();
    expect(sent.filter(command => command.type === "skin")).toHaveLength(1);
  });
  test("a lost sequence cannot cause an endless retransmission loop", () => {
    const h = harness();
    h.session.input(Input.LeftDown); h.session.input(Input.LeftUp);
    h.session.pending.shift();
    h.receive({ type: "error", code: "SEQ_GAP", message: "Gap" });
    h.cp.serverSequence++; h.receive(h.cp);
    expect(h.sent.at(-1)).toEqual({ type: "releaseControls" });
    expect(h.session.canPlay).toBe(false);
  });
});
