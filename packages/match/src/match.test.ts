import { expect, test } from "bun:test";
import { FRAME_MS, Input, Piece, Rng, type GameState } from "@42tris/core";
import { GarbageQueue, GARBAGE_DELAY_MS, type Packet, type QueueRecord } from "./garbage";
import { Match, type MatchInput } from "./match";

const options = { players: ["a", "b"], seed: 108, firstTo: 2 };
const packet = (id: number, lines: number, atMs = 0): Packet =>
  ({ id, from: "a", to: "b", lines, kind: "normal", atMs, eligibleAtMs: atMs + GARBAGE_DELAY_MS });

function quad(game: GameState, allClear = true) {
  game.board.fill(0);
  Object.assign(game.state, { piece: Piece.I, rot: 1, x: 2, y: 18 });
  for (let y = 36; y < 40; y++) {
    game.board.fill(Piece.L, y * 10, (y + 1) * 10);
    game.board[y * 10 + 4] = 0;
  }
  if (!allClear) game.board[350] = Piece.L;
}

function die(game: GameState) {
  Object.assign(game.state, { piece: Piece.O, rot: 0, x: 4, y: 38 });
  game.board.fill(Piece.L, 180, 200);
  game.board[180] = game.board[190] = 0;
}

function input(match: Match, player: string, frame = 0, subframe = 0, order = 0, key: MatchInput["input"] = Input.HardDrop) {
  match.submit({ player, frame, subframe, order, input: key });
}

test("held movement at frame 99 round-trips a pending core frame boundary", () => {
  const match = new Match(options);
  input(match, "a", 81, 0, 0, Input.LeftDown);
  match.advanceToFrame(99);
  const restored = Match.fromState(JSON.parse(JSON.stringify(match.saveState())));
  for (const m of [match, restored]) m.advanceToFrame(101);
  expect(restored.saveState()).toEqual(match.saveState());
});

test("fractional reset does not auto-lock before an input exactly 30 frames later", () => {
  for (const key of [Input.HardDrop, Input.LeftUp]) {
    const state = new Match(options).saveState();
    Object.assign(state.players[0].game.state, { piece: Piece.O, x: 4, y: 38 });
    const match = Match.fromState(state);
    input(match, "a", 2, 0.2, 0, Input.RotateCw);
    input(match, "a", 32, 0.2, 0, key);
    match.advanceToFrame(3);
    const restored = Match.fromState(JSON.parse(JSON.stringify(match.saveState())));
    for (const m of [match, restored]) {
      m.advanceToFrame(33);
      expect(m.playerState("a").lastResult?.stats.pieces ?? 0).toBe(key === Input.HardDrop ? 1 : 0);
    }
    expect(restored.saveState()).toEqual(match.saveState());
  }
});

test("right-edge rounding is rejected before mutation and cannot strand later inputs or checkpoints", () => {
  const match = new Match(options);
  const before = match.saveState();
  expect(() => input(match, "a", 1, 0.9999999999999999)).toThrow();
  expect(match.saveState()).toEqual(before);
  input(match, "b", 2, 0.5);
  const restored = Match.fromState(JSON.parse(JSON.stringify(match.saveState())));
  for (const m of [match, restored]) {
    m.advanceToFrame(3);
    expect(m.saveState().inputs).toEqual([]);
    expect(m.playerState("b").lastResult?.stats.pieces).toBe(1);
  }
  expect(restored.saveState()).toEqual(match.saveState());

  const invalid = new Match(options).saveState();
  invalid.inputs = [
    { player: "a", frame: 1, subframe: 0.9999999999999999, order: 0, input: Input.HardDrop },
    { player: "b", frame: 2, subframe: 0.5, order: 0, input: Input.HardDrop },
  ];
  expect(() => Match.fromState(JSON.parse(JSON.stringify(invalid)))).toThrow();
  invalid.inputs.shift();
  invalid.frame = 3;
  expect(() => Match.fromState(invalid)).toThrow();
});

test("scheduler fails explicitly on a corrupted stale queue head", () => {
  const match = new Match(options);
  match.advanceToFrame(2);
  // Simulate an internal invariant violation independently of checkpoint validation.
  Object.assign(match, { inputs: [
    { player: "a", frame: 1, subframe: 0.5, order: 0, input: Input.HardDrop },
    { player: "b", frame: 2, subframe: 0.5, order: 0, input: Input.HardDrop },
  ] });
  const before = match.saveState();
  expect(() => match.advanceToFrame(3)).toThrow("Stale or unrepresentable queued input");
  expect(match.saveState()).toEqual(before);
});

test("garbage is eligible at matching subframes twenty frames later, including JSON continuation", () => {
  for (const subframe of [0.25, 0.4, 0.75]) {
    const state = new Match(options).saveState();
    quad(state.players[0].game);
    const match = Match.fromState(state);
    input(match, "a", 0, subframe);
    input(match, "b", 20, subframe - 1e-10);
    input(match, "b", 20, subframe, 1);
    match.advanceToFrame(1);
    const restored = Match.fromState(JSON.parse(JSON.stringify(match.saveState())));
    for (const m of [match, restored]) m.advanceToFrame(21);
    expect(restored.saveState()).toEqual(match.saveState());
    const events = match.drainEvents().filter(e => e.type === "insert");
    expect(events.reduce((n, e) => n + e.holes.length, 0)).toBe(8);
    expect(events.every(e => e.atMs === (20 + subframe) * FRAME_MS)).toBe(true);
    expect(match.saveState().players[1].garbage.packets.map(p => p.lines)).toEqual([1]);
  }
});

test("eligibility tolerance scales with the clock and excludes times outside its rounding bound", () => {
  for (const frame of [0, 60000, 10000000]) {
    for (const subframe of [0.25, 0.4, 0.75]) {
      const q = new GarbageQueue(42);
      const p = packet(1, 1, (frame + subframe) * FRAME_MS);
      q.packets.push(p);
      const boundary = (frame + 20 + subframe) * FRAME_MS;
      const outsideBound = 16 * Number.EPSILON * Math.max(boundary, p.eligibleAtMs, GARBAGE_DELAY_MS);
      const before = q.saveState();
      const records: QueueRecord[] = [];
      expect(q.insert(boundary - outsideBound, records)).toEqual([]);
      expect(records).toEqual([]);
      expect(q.saveState()).toEqual(before);
      expect(q.insert(boundary, records)).toHaveLength(1);
      expect(q.pending).toBe(0);
    }
  }
});

test("full cancellation advances hole RNG once per packet; partial cancellation preserves hole and counts", () => {
  const q = new GarbageQueue(42);
  q.packets.push(packet(1, 2), packet(2, 3), packet(3, 4));
  const records: QueueRecord[] = [];
  const rng = new Rng(42);
  rng.nextBelow(10);
  const nextHole = rng.nextBelow(10);
  expect(q.cancel(5, 1, records)).toBe(0);
  expect(records).toEqual([
    { type: "cancel", packet: 1, lines: 2 },
    { type: "cancel", packet: 2, lines: 3 },
    { type: "cancel", packet: 3, lines: 1 },
  ]);
  expect(q.pending).toBe(3);
  expect(q.saveState()).toEqual({ packets: [packet(3, 3)], rng: rng.save(), hole: nextHole });
  expect(q.insert(GARBAGE_DELAY_MS, [])).toEqual([nextHole, nextHole, nextHole]);
  expect(q.pending).toBe(0);
  expect(q.saveState().hole).toBe(rng.nextBelow(10));
  expect(q.saveState().rng).toBe(rng.save());
});

test("queue checkpoints and insertion records have no mutable aliases", () => {
  const q = new GarbageQueue(42);
  q.packets.push(packet(1, 10));
  const snapshot = q.saveState();
  const restored = GarbageQueue.fromState(snapshot);
  snapshot.packets[0].lines = 99;
  expect(q.pending).toBe(10);
  expect(restored.pending).toBe(10);
  const records: QueueRecord[] = [];
  const holes = restored.insert(GARBAGE_DELAY_MS, records);
  const saved = restored.saveState();
  const record = records[0];
  expect(record.type).toBe("insert");
  if (record.type !== "insert") throw new Error("Expected insertion");
  const original = holes[0];
  record.holes[0] = (original + 1) % 10;
  expect(holes[0]).toBe(original);
  holes[1] = (original + 2) % 10;
  expect(record.holes[1]).toBe(original);
  expect(restored.saveState()).toEqual(saved);
  expect(q.pending).toBe(10);
});

test("received packet state is detached from checkpoints and send/queue event records", () => {
  const state = new Match(options).saveState();
  quad(state.players[0].game);
  const match = Match.fromState(state);
  input(match, "a");
  match.advanceToFrame(1);
  const snapshot = match.saveState();
  const restored = Match.fromState(snapshot);
  const before = restored.saveState();
  snapshot.players[1].garbage.packets[0].lines = 99;
  snapshot.players[1].garbage.packets.length = 0;
  expect(restored.saveState()).toEqual(before);
  expect(match.saveState()).toEqual(before);
  const events = match.drainEvents();
  const send = events.find(e => e.type === "send");
  const queued = events.find(e => e.type === "queue");
  if (send?.type !== "send" || queued?.type !== "queue") throw new Error("Expected packet events");
  send.packet.lines = 88;
  expect(queued.packet.lines).toBe(4);
  queued.packet.lines = 77;
  expect(match.saveState().players[1].garbage.packets.map(p => p.lines)).toEqual([4, 5]);
});

test("FIFO cancellation preserves partial packets; hole progresses even for fully canceled packets", () => {
  const q = new GarbageQueue(42);
  q.packets.push(packet(1, 3), packet(2, 12));
  const records: QueueRecord[] = [];
  const initial = q.saveState();
  expect(q.cancel(4, 0, records)).toBe(0);
  expect(q.packets.map(p => [p.id, p.lines])).toEqual([[2, 11]]);
  expect(q.saveState().rng).not.toBe(initial.rng);
  expect(q.insert(GARBAGE_DELAY_MS - 0.001, records)).toEqual([]);
  const first = q.insert(GARBAGE_DELAY_MS, records);
  expect(first).toHaveLength(8);
  expect(new Set(first).size).toBe(1);
  const resumed = GarbageQueue.fromState(q.saveState());
  expect(resumed.insert(500, [])).toEqual(q.insert(500, records));
  expect(q.pending).toBe(0);
  expect(records[0]).toEqual({ type: "cancel", packet: 1, lines: 3 });
  expect(records[1]).toEqual({ type: "cancel", packet: 2, lines: 1 });
});

test("defensive bonus is spent after normal attack and cannot become outgoing attack", () => {
  for (const [pending, expected] of [[2, 2], [4, 0], [6, 0], [10, 0]]) {
    const q = new GarbageQueue(1);
    q.packets.push(packet(1, pending));
    expect(q.cancel(4, 4, [])).toBe(expected);
    expect(q.pending).toBe(Math.max(0, pending - 8));
  }
});

test("same-frame opposing bundles cancel before delivery, including subframes and packet remainders", () => {
  const state = new Match(options).saveState();
  quad(state.players[0].game);
  quad(state.players[1].game, false);
  const match = Match.fromState(state);
  input(match, "a", 0, 0.1, 0);
  input(match, "b", 0, 0.9, 1);
  match.advanceToFrame(1);
  const saved = match.saveState();
  expect(saved.players[0].garbage.packets).toEqual([]);
  expect(saved.players[1].garbage.packets.map(p => p.lines)).toEqual([5]);
  const events = match.drainEvents();
  expect(events.filter(e => e.type === "crossCancel").map(e => e.lines)).toEqual([4]);
  expect(events.filter(e => e.type === "queue").map(e => e.packet.lines)).toEqual([5]);
});

test("actual subframe send time gates insertion, clears block, cap is eight", () => {
  const state = new Match(options).saveState();
  quad(state.players[0].game);
  const match = Match.fromState(state);
  input(match, "a", 0, 0.75);
  input(match, "b", 20, 0.5);
  input(match, "b", 20, 0.75, 1);
  match.advanceToFrame(21);
  const inserted = match.drainEvents().filter(e => e.type === "insert");
  expect(inserted.reduce((sum, e) => sum + e.holes.length, 0)).toBe(8);
  expect(inserted.every(e => e.atMs === 20.75 * FRAME_MS)).toBe(true);
  expect(match.saveState().players[1].garbage.packets.map(p => p.lines)).toEqual([1]);

  const blocked = new Match(options).saveState();
  quad(blocked.players[1].game, false);
  blocked.players[1].garbage.packets.push(packet(1, 20, -GARBAGE_DELAY_MS));
  const clear = Match.fromState(blocked);
  input(clear, "b");
  clear.advanceToFrame(1);
  expect(clear.drainEvents().filter(e => e.type === "insert")).toEqual([]);
  expect(clear.saveState().players[1].garbage.packets[0].lines).toBe(12);
});

test("opposing attack cancels prior-frame in-flight packets before eligibility", () => {
  const state = new Match(options).saveState();
  quad(state.players[0].game, false);
  quad(state.players[1].game, false);
  const match = Match.fromState(state);
  input(match, "a", 0);
  input(match, "b", 1);
  match.advanceToFrame(2);
  expect(match.saveState().players.every(p => p.garbage.packets.length === 0)).toBe(true);
  const events = match.drainEvents();
  expect(events.filter(e => e.type === "cancel").map(e => e.lines)).toEqual([4]);
  expect(events.filter(e => e.type === "insert")).toEqual([]);
  expect(events.filter(e => e.type === "send").map(e => e.packet.from)).toEqual(["a"]);
});

test("opener boundary is inclusive placement 14 and pending >= sent, not a flat attack multiplier", () => {
  for (const [pieces, sent, remaining] of [[13, 10, 2], [14, 10, 6], [13, 11, 6]]) {
    const state = new Match(options).saveState();
    quad(state.players[1].game, false);
    state.players[1].sent = sent;
    state.players[1].garbage.packets.push(packet(1, 10));
    state.players[1].game.state.sequence = pieces;
    state.players[1].game.lastResult = { type: "lock", sequence: pieces, atMs: 0,
      piece: Piece.O, rows: [], spin: "none", allClear: false, attacks: [], finesse: { evaluated: 0, faults: 0, points: 0 },
      stats: { pieces, lines: 0, combo: -1, chainLength: 0, b2b: 0, surge: 0, attack: 0 } };
    const match = Match.fromState(state);
    input(match, "b");
    match.advanceToFrame(1);
    expect(match.saveState().players[1].garbage.packets[0].lines).toBe(remaining);
  }
});

test("canonical stepping, batching and JSON continuation preserve exact states and events", () => {
  const state = new Match(options).saveState();
  quad(state.players[0].game);
  const all = Match.fromState(state);
  const chunks = Match.fromState(state);
  for (const match of [all, chunks]) {
    input(match, "a", 0, 0.25);
    input(match, "b", 21, 0.8);
    input(match, "a", 30, 0.3, 0, Input.LeftDown);
    input(match, "a", 31, 0.7, 0, Input.LeftUp);
  }
  all.advanceToFrame(100);
  chunks.advanceToFrame(13);
  const resumed = Match.fromState(JSON.parse(JSON.stringify(chunks.saveState())));
  for (let frame = 14; frame <= 100; frame++) resumed.advanceToFrame(frame);
  expect(resumed.saveState()).toEqual(all.saveState());
  expect(resumed.drainEvents()).toEqual(all.drainEvents());
});

test("timed locks interleave globally and continue identically through a checkpoint", () => {
  const state = new Match(options).saveState();
  for (const p of state.players) {
    p.game.config.gravityMs = 10;
    Object.assign(p.game.state, { piece: Piece.O, rot: 0, x: 4, y: 38 });
  }
  const a = Match.fromState(state);
  let b = Match.fromState(state);
  a.advanceToFrame(200);
  for (let frame = 1; frame <= 200; frame++) {
    b.advanceToFrame(frame);
    if (frame === 35) b = Match.fromState(JSON.parse(JSON.stringify(b.saveState())));
  }
  expect(a.saveState()).toEqual(b.saveState());
  const locks = a.drainEvents().filter(e => e.type === "lock");
  expect(locks.length).toBeGreaterThan(4);
  expect(locks.map(e => e.atMs)).toEqual(locks.map(e => e.atMs).sort((x, y) => x - y));
});

test("FFA routes a bundle to exactly one living opponent, independent of supplied roster order", () => {
  const build = (players: string[]) => {
    const state = new Match({ ...options, players }).saveState();
    quad(state.players[0].game);
    state.players[3].game.state.topOut = true;
    const match = Match.fromState(state);
    input(match, "a");
    match.advanceToFrame(1);
    return match;
  };
  const a = build(["d", "c", "b", "a"]);
  const b = build(["a", "b", "c", "d"]);
  expect(a.saveState()).toEqual(b.saveState());
  const queues = a.drainEvents().filter(e => e.type === "queue");
  expect(queues.map(e => e.packet.lines)).toEqual([4, 5]);
  expect(new Set(queues.map(e => e.packet.to)).size).toBe(1);
  expect(queues[0].packet.to).not.toBe("d");
});

test("same-frame deaths draw; FT awards once and requires explicit next round seed", () => {
  const state = new Match(options).saveState();
  state.players.forEach(p => die(p.game));
  const draw = Match.fromState(state);
  input(draw, "a", 0, 0.1);
  input(draw, "b", 0, 0.9, 1);
  draw.advanceToFrame(1);
  expect(draw.scores).toEqual({ a: 0, b: 0 });
  expect(draw.ended).toBe(true);
  expect(draw.complete).toBe(false);
  expect(draw.drainEvents().at(-1)).toMatchObject({ type: "roundEnd", winner: null });
  expect(() => draw.nextRound(108)).toThrow();
  draw.nextRound(109);
  expect(draw.round).toBe(2);
  expect(draw.seed).toBe(109);
  expect(draw.playerState("a").previews).toEqual(draw.playerState("b").previews);
  let match = draw;
  for (let round = 0; round < 2; round++) {
    const s = match.saveState();
    die(s.players[1].game);
    match = Match.fromState(s);
    input(match, "b");
    match.advanceToFrame(1);
    expect(match.scores.a).toBe(round + 1);
    match.advanceToFrame(100);
    expect(match.scores.a).toBe(round + 1);
    if (!round) match.nextRound(110);
  }
  expect(match.complete).toBe(true);
  expect(() => match.nextRound(111)).toThrow();
});

test("garbage overflow tops out before spawn; recipient packets are discarded", () => {
  const state = new Match(options).saveState();
  const b = state.players[1];
  b.game.board[0] = Piece.L;
  b.garbage.packets.push(packet(1, 20, -GARBAGE_DELAY_MS));
  const match = Match.fromState(state);
  input(match, "b");
  match.advanceToFrame(1);
  expect(match.playerState("b").state.topOut).toBe(true);
  expect(match.playerState("b").state.dealt).toBe(1);
  expect(match.saveState().players[1].garbage.packets).toEqual([]);
  expect(match.drainEvents()).toContainEqual({ type: "discard", round: 1, atMs: FRAME_MS, packet: 1, lines: 12 });
});

test("rejects invalid inputs and late frames without mutation", () => {
  const match = new Match(options);
  match.advanceToFrame(1);
  const before = match.saveState();
  expect(() => input(match, "a", 0)).toThrow();
  expect(() => input(match, "a", 1, 1)).toThrow();
  expect(() => input(match, "unknown", 1)).toThrow();
  expect(() => match.advanceToFrame(0)).toThrow();
  expect(match.saveState()).toEqual(before);
});

test("round clock has no ten-minute cutoff", () => {
  const state = new Match(options).saveState();
  for (const p of state.players) p.game.config.gravityMs = 1e9;
  const match = Match.fromState(state);
  match.advanceToFrame(36001);
  expect(match.frame).toBe(36001);
  expect(match.ended).toBe(false);
  expect(match.scores).toEqual({ a: 0, b: 0 });
});

test("an outgoing packet is discarded when its recipient dies later in the same frame", () => {
  const state = new Match(options).saveState();
  quad(state.players[0].game);
  die(state.players[1].game);
  const match = Match.fromState(state);
  input(match, "a", 0, 0.1);
  input(match, "b", 0, 0.9, 1);
  match.advanceToFrame(1);
  const events = match.drainEvents();
  expect(events.filter(e => e.type === "queue")).toEqual([]);
  expect(events.filter(e => e.type === "discard").map(e => e.lines)).toEqual([4, 5]);
  expect(match.scores).toEqual({ a: 1, b: 0 });
});

test("finesse is independent per player and survives a match checkpoint", () => {
  const match = new Match(options);
  input(match, "a", 0, 0.1, 0, Input.LeftDown);
  input(match, "a", 0, 0.2, 1, Input.LeftUp);
  input(match, "a", 0, 0.3, 2, Input.RightDown);
  input(match, "a", 0, 0.4, 3, Input.RightUp);
  match.advanceToFrame(1);
  const restored = Match.fromState(JSON.parse(JSON.stringify(match.saveState())));
  for (const game of [match, restored]) {
    input(game, "a", 1, 0.1, 4);
    input(game, "b", 1, 0.2, 5);
    game.advanceToFrame(2);
    expect(game.playerState("a").lastResult?.finesse).toEqual({ evaluated: 1, faults: 1, points: 1 });
    expect(game.playerState("b").lastResult?.finesse).toEqual({ evaluated: 1, faults: 0, points: 5 });
  }
  expect(restored.saveState()).toEqual(match.saveState());
});
