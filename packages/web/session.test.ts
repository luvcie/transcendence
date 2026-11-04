import { describe, expect, test } from "bun:test";
import { boardEdges, copyBoardEdges, createBoard, Input, FRAME_MS, Piece, place } from "@42tris/core";
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
  const timers = new Map<object, { at: number; callback: () => void }>();
  const sent: ClientCommand[] = [];
  const sockets: Parameters<SessionOptions["connect"]>[0][] = [];
  const credentials = storage();
  const session = new Session({ now: () => now, storage: credentials, profile: storage(), clearKeys: () => { clears++; },
    schedule(callback, delay) {
      const key = {};
      timers.set(key, { at: now + delay, callback });
      return () => { timers.delete(key); };
    },
    connect(callbacks) { sockets.push(callbacks); return { send: command => { sent.push(command); }, close() {} }; } });
  session.start();
  sockets[0].open();
  const welcome = () => session.receive({ type: "welcome", guestSessionId: "a", playerId: "a", resumeToken: "token", name: "A", room: null, generation: 0, serverNow: now });
  welcome();
  const cp = checkpoint();
  session.receive(cp);
  return { session, sent, sockets, credentials, cp, welcome, time: (value: number) => { now = value; }, clears: () => clears,
    receive: (message: ServerMessage) => session.receive(message), timers,
    advance(value: number) {
      for (;;) {
        const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > value) break;
        now = next[1].at;
        timers.delete(next[0]);
        next[1].callback();
      }
      now = value;
    } };
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
  test("flushes rapid press and release at the throttle boundary without a frame", () => {
    const h = harness();
    h.time(5); h.session.input(Input.LeftDown);
    h.time(6); h.session.input(Input.LeftUp); h.session.input(Input.RightDown); h.session.input(Input.RightUp);
    expect(h.timers.size).toBe(1);
    h.advance(38);
    expect(h.sent.filter(c => c.type === "inputBatch")).toHaveLength(1);
    h.advance(39);
    const batches = h.sent.filter(c => c.type === "inputBatch");
    expect(batches.map(b => b.items.map(i => i.input))).toEqual([[Input.LeftDown], [Input.LeftUp, Input.RightDown, Input.RightUp]]);
    expect(batches.flatMap(b => b.items.map(i => i.seq))).toEqual([1, 2, 3, 4]);
    expect(h.timers.size).toBe(0);
  });
  test.each(["tick", "input"] as const)("%s flush cancels the trailing timer", trigger => {
    const h = harness();
    h.session.input(Input.LeftDown);
    h.time(1); h.session.input(Input.LeftUp);
    h.time(34);
    if (trigger === "tick") h.session.tick();
    else h.session.input(Input.RightDown);
    expect(h.timers.size).toBe(0);
    const before = h.sent.filter(c => c.type === "inputBatch").length;
    h.advance(100);
    expect(h.sent.filter(c => c.type === "inputBatch")).toHaveLength(before);
  });
  test.each(["disconnect", "stop", "release", "phase", "generation", "round", "gap", "reconnect"] as const)("%s cancels a pending flush", action => {
    const h = harness();
    h.session.input(Input.LeftDown);
    h.time(1); h.session.input(Input.LeftUp);
    expect(h.timers.size).toBe(1);
    if (action === "disconnect") h.sockets[0].close();
    if (action === "stop") h.session.stop();
    if (action === "release") h.session.release();
    if (action === "phase") h.receive({ type: "roomState", room: { ...h.cp.room, phase: "paused" } });
    if (action === "generation" || action === "round") {
      h.cp.serverSequence++;
      if (action === "generation") h.cp.owner.generation++;
      else h.cp.state!.round++;
      h.receive(h.cp);
    }
    if (action === "gap") h.receive({ type: "error", code: "SEQ_GAP", message: "Gap" });
    if (action === "reconnect") h.session.retry();
    expect(h.timers.size).toBe(0);
    h.advance(100);
    expect(h.sent.filter(c => c.type === "inputBatch")).toHaveLength(1);
  });
  test("a timer checks eligibility again after checkpoints become stale", () => {
    const h = harness();
    h.time(1990); h.session.input(Input.LeftDown);
    h.time(1991); h.session.input(Input.LeftUp);
    h.advance(2024);
    expect(h.sent.filter(c => c.type === "inputBatch")).toHaveLength(1);
    expect(h.timers.size).toBe(0);
  });
  test("timer flushes a large burst in bounded batches", () => {
    const h = harness();
    h.session.input(Input.LeftDown);
    h.time(1);
    for (let i = 0; i < 40; i++) h.session.input(i % 2 ? Input.LeftDown : Input.LeftUp);
    h.advance(34);
    expect(h.sent.filter(c => c.type === "inputBatch").map(b => b.items.length)).toEqual([1, 32]);
    expect(h.timers.size).toBe(1);
    h.advance(68);
    expect(h.sent.filter(c => c.type === "inputBatch").map(b => b.items.length)).toEqual([1, 32, 8]);
    expect(h.timers.size).toBe(0);
  });
  test("reconnect cannot send an old timer's inputs through the new socket", () => {
    const h = harness();
    h.session.input(Input.LeftDown);
    h.time(1); h.session.input(Input.LeftUp);
    const oldTimer = [...h.timers.values()][0].callback;
    h.sockets[0].close();
    h.time(700); h.session.tick(); h.sockets[1].open(); h.welcome();
    h.cp.owner.generation++; h.cp.serverSequence++;
    h.sockets[1].message(h.cp);
    oldTimer();
    expect(h.sent.filter(c => c.type === "inputBatch")).toHaveLength(1);
    h.session.input(Input.RightDown);
    expect(h.sent.filter(c => c.type === "inputBatch").at(-1)).toMatchObject({ generation: 1, items: [{ seq: 1, input: Input.RightDown }] });
  });
  test("predicts immediately, batches at 34ms, and restores accepted inputs only once", () => {
    const h = harness();
    h.time(5); h.session.input(Input.LeftDown); h.session.input(Input.LeftUp);
    expect(h.session.prediction!.gameState().state.x).toBe(2);
    expect(h.sent.filter(c => c.type === "inputBatch")).toHaveLength(1);
    h.session.tick();
    const batch = h.sent.find(c => c.type === "inputBatch");
    expect(batch?.type === "inputBatch" && batch.items.map(i => i.input)).toEqual([Input.LeftDown]);
    h.time(39); h.session.tick();
    const items = h.session.pending.map((i, index) => ({ seq: i.seq, frame: i.frame, subframe: i.subframe, input: i.input, order: index + 1 }));
    h.cp.owner.pendingAccepted = items;
    h.cp.owner.nextSeq = 3;
    h.cp.state!.inputs = items.map(i => ({ ...i, player: "a", epoch: 0 }));
    h.cp.serverSequence++;
    h.receive(h.cp);
    expect(h.session.prediction!.gameState().state.x).toBe(2);
    expect(h.sent.filter(c => c.type === "inputBatch")).toHaveLength(2);
    h.time(40); h.session.input(Input.RightDown); h.session.tick();
    expect(h.sent.filter(c => c.type === "inputBatch")).toHaveLength(2);
    h.time(73); h.session.tick();
    expect(h.sent.filter(c => c.type === "inputBatch")).toHaveLength(3);
  });
  test("flushes on input when permitted and bounds ordered bursts", () => {
    const h = harness();
    h.time(5); h.session.input(Input.LeftDown);
    expect(h.sent.filter(c => c.type === "inputBatch")).toHaveLength(1);
    h.time(6);
    for (let i = 0; i < 40; i++) h.session.input(i % 2 ? Input.LeftDown : Input.LeftUp);
    expect(h.sent.filter(c => c.type === "inputBatch")).toHaveLength(1);
    h.time(39); h.session.input(Input.LeftUp);
    let batches = h.sent.filter(c => c.type === "inputBatch");
    expect(batches.map(b => b.items.length)).toEqual([1, 32]);
    expect(batches.flatMap(b => b.items.map(i => i.seq))).toEqual(Array.from({ length: 33 }, (_, i) => i + 1));
    h.time(73); h.session.tick();
    batches = h.sent.filter(c => c.type === "inputBatch");
    expect(batches.map(b => b.items.length)).toEqual([1, 32, 9]);
    expect(batches.flatMap(b => b.items.map(i => i.seq))).toEqual(Array.from({ length: 42 }, (_, i) => i + 1));
  });
  test("old connections cannot flush queued inputs after reconnect", () => {
    const h = harness();
    h.time(5); h.session.input(Input.LeftDown);
    h.time(6); h.session.input(Input.LeftUp);
    h.sockets[0].close();
    expect(h.session.pending).toHaveLength(0);
    h.time(700); h.session.tick();
    h.sockets[1].open(); h.welcome();
    h.cp.serverSequence++; h.cp.owner.generation++;
    h.sockets[1].message(h.cp);
    h.sockets[0].message({ type: "error", code: "SEQ_GAP", message: "old" });
    h.session.input(Input.RightDown);
    const batches = h.sent.filter(c => c.type === "inputBatch");
    expect(batches).toHaveLength(2);
    expect(batches[1]).toMatchObject({ generation: 1, items: [{ seq: 1, input: Input.RightDown }] });
  });
  test("sustained input stays within the batch throttle", () => {
    const h = harness();
    const flushes: number[] = [];
    for (let now = 0; now < 600; now += 10) {
      h.time(now);
      const before = h.sent.filter(c => c.type === "inputBatch").length;
      h.session.input(now % 20 ? Input.LeftUp : Input.LeftDown);
      if (h.sent.filter(c => c.type === "inputBatch").length > before) flushes.push(now);
    }
    expect(flushes.length).toBeGreaterThan(1);
    expect(flushes.every((at, i) => i === 0 || at - flushes[i - 1] >= 34)).toBe(true);
    const batches = h.sent.filter(c => c.type === "inputBatch");
    expect(batches.every(b => b.items.length <= 32)).toBe(true);
    expect(batches.flatMap(b => b.items.map(i => i.seq))).toEqual(Array.from({ length: 57 }, (_, i) => i + 1));
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

test("checkpoint visual edges survive JSON transport and prediction without changing game state", () => {
  const h = harness(), board = createBoard();
  place(board, Piece.S, 1, 0, 24);
  place(board, Piece.S, 3, 0, 25);
  h.cp.state!.players[0].game.board = copyBoardEdges(board, [...board]);
  const cp: Checkpoint = JSON.parse(JSON.stringify({ ...h.cp, serverSequence: 2,
    boardEdges: h.cp.state!.players.map(player => btoa(String.fromCharCode(...boardEdges(player.game.board)))),
  }));
  expect(boardEdges(cp.state!.players[0].game.board).some(Boolean)).toBe(false);
  const json = JSON.stringify(cp.state);
  h.receive(cp);
  expect(boardEdges(cp.state!.players[0].game.board)).toEqual(boardEdges(board));
  expect(boardEdges(h.session.prediction!.gameState().board)).toEqual(boardEdges(board));
  expect(JSON.stringify(cp.state)).toBe(json);
  const before = h.session.checkpoint;
  expect(() => h.receive({ ...cp, serverSequence: 3, boardEdges: cp.boardEdges!.slice(0, 1) })).toThrow("roster");
  expect(() => h.receive({ ...cp, serverSequence: 3, boardEdges: [btoa("wrong length"), cp.boardEdges![1]] })).toThrow("dimensions");
  expect(h.session.checkpoint).toBe(before);
});
