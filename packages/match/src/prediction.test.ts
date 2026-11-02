import { expect, spyOn, test } from "bun:test";
import { DEFAULT_HANDLING, FRAME_MS, Game, Input, LOCK_RESET_LIMIT, Piece, type GameState } from "@42tris/core";
import { Match, type MatchInput } from "./match";
import { OwnerPrediction } from "./prediction";

const options = { players: ["a", "b"], seed: 108 };
const input = (player: string, frame: number, key: MatchInput["input"], subframe = 0.25, order = 0): MatchInput =>
  ({ player, frame, subframe, order, input: key });

function quad(game: GameState) {
  game.board.fill(0);
  Object.assign(game.state, { piece: Piece.I, rot: 1, x: 2, y: 18 });
  for (let y = 36; y < 40; y++) {
    game.board.fill(Piece.L, y * 10, (y + 1) * 10);
    game.board[y * 10 + 4] = 0;
  }
}

function expectOwner(prediction: OwnerPrediction, match: Match) {
  const owner = match.saveState().players[match.roster.indexOf(prediction.owner)];
  const predicted = prediction.saveState();
  expect(predicted.game).toEqual(owner.game);
  expect(predicted.garbage).toEqual(owner.garbage);
  expect(predicted.sent).toBe(owner.sent);
  expect(predicted.epoch).toBe(owner.epoch);
  expect(predicted.frame).toBe(match.frame);
}

test("authoritative and predicted simulations agree on bounded lock resets", () => {
  const state = new Match(options).saveState();
  Object.assign(state.players[0].game.state, { piece: Piece.O, rot: 0, x: 4, y: 38 });
  const match = Match.fromState(state);
  const predicted = new OwnerPrediction(state, "a");
  for (let i = 0; i < 20; i++) {
    const next = input("a", 2 + i * 2, Input.RotateCw);
    match.submit(next);
    predicted.submit(next);
  }
  match.advanceToFrame(45);
  predicted.advanceToFrame(45);
  expectOwner(predicted, match);
  expect(predicted.gameState().state.lockResets).toBe(LOCK_RESET_LIMIT);
  expect(predicted.gameState().lastResult).toBeNull();
  match.advanceToFrame(70);
  predicted.advanceToFrame(70);
  expectOwner(predicted, match);
  expect(predicted.gameState().lastResult?.stats.pieces).toBe(1);
});

test("owner prediction matches authoritative handling, subframe inputs, timed locks and batching", () => {
  const state = new Match({ ...options, handlingByPlayer: { a: { ...DEFAULT_HANDLING, das: 1, arr: 0.5 } } }).saveState();
  Object.assign(state.players[0].game.state, { piece: Piece.O, rot: 0, x: 4, y: 38 });
  const match = Match.fromState(state);
  const predicted = new OwnerPrediction(state, "a");
  const batched = new OwnerPrediction(JSON.parse(JSON.stringify(state)), "a");
  const inputs = [input("a", 2, Input.LeftDown), input("a", 4, Input.LeftUp, 0.8),
    input("a", 6, Input.RotateCw, 0.4), input("a", 40, Input.HardDrop, 0.75)];
  for (const i of inputs) { match.submit(i); predicted.submit(i); batched.submit(i); }
  match.advanceToFrame(70);
  predicted.advanceToFrame(70);
  for (let frame = 1; frame <= 70; frame++) batched.advanceToFrame(frame);
  expectOwner(predicted, match);
  expect(batched.saveState()).toEqual(predicted.saveState());
  expect(batched.drainEvents()).toEqual(predicted.drainEvents());
});

test("shared placement rules preserve pending packet cancellation, opener defense and informational outgoing", () => {
  for (const mode of ["competitive", "practice"] as const) {
    for (const attacksEnabled of mode === "practice" ? [false, true] : [true]) {
      const state = new Match({ ...options, mode, attacksEnabled }).saveState();
      quad(state.players[0].game);
      state.players[0].garbage.packets.push({ id: 1, from: "b", to: "a", lines: 12,
        kind: "normal", atMs: 0, eligibleAtMs: 20 * FRAME_MS });
      state.packetSequence = 1;
      const match = Match.fromState(state);
      const predicted = new OwnerPrediction(state, "a");
      const i = input("a", 1, Input.HardDrop);
      match.submit(i);
      predicted.submit(i);
      match.advanceToFrame(2);
      predicted.advanceToFrame(2);
      expectOwner(predicted, match);
      const events = predicted.drainEvents();
      expect(events.filter(e => e.type === "cancel").map(e => e.lines)).toEqual([8, 4]);
      expect(events.filter(e => e.type === "outgoing").map(e => e.attack.lines)).toEqual(attacksEnabled ? [1] : []);
      expect(events.some(e => "packet" in e && typeof e.packet === "object")).toBe(false);
    }
  }
});

test("known queued arrivals retain subframe eligibility, cap, partial packets and hole progression", () => {
  const state = new Match(options).saveState();
  state.players[0].garbage.packets.push({ id: 1, from: "b", to: "a", lines: 10,
    kind: "normal", atMs: 0.25 * FRAME_MS, eligibleAtMs: 0.25 * FRAME_MS + 20 * FRAME_MS });
  state.packetSequence = 1;
  const match = Match.fromState(state);
  const predicted = new OwnerPrediction(state, "a");
  for (const i of [input("a", 20, Input.HardDrop, 0.25 - 1e-10), input("a", 20, Input.HardDrop, 0.25, 1)]) {
    match.submit(i);
    predicted.submit(i);
  }
  match.advanceToFrame(21);
  predicted.advanceToFrame(21);
  expectOwner(predicted, match);
  expect(predicted.saveState().garbage.packets[0].lines).toBe(2);
  const inserted = predicted.drainEvents().filter(e => e.type === "insert");
  expect(inserted).toHaveLength(1);
  expect(inserted[0].atMs).toBe(20.25 * FRAME_MS);
  expect(inserted[0].holes).toHaveLength(8);
});

test("prediction constructs only the owner Game and never runs queued opponent attacks", () => {
  const state = new Match(options).saveState();
  quad(state.players[1].game);
  state.inputs = [input("b", 0, Input.HardDrop), input("a", 21, Input.HardDrop)];
  const original = structuredClone(state);
  const restore = spyOn(Game, "fromState");
  try {
    const predicted = new OwnerPrediction(state, "a");
    expect(restore).toHaveBeenCalledTimes(1);
    predicted.advanceToFrame(22);
    expect(predicted.saveState().garbage.packets).toEqual([]);
    expect(predicted.gameState().board.some(cell => cell === 8)).toBe(false);
    expect(predicted.drainEvents().every(e => e.owner === "a")).toBe(true);
    expect(state).toEqual(original);
  } finally {
    restore.mockRestore();
  }
});

test("authoritative correction replaces unknown interactions, then replays unresolved owner inputs", () => {
  const state = new Match(options).saveState();
  quad(state.players[1].game);
  const authoritative = Match.fromState(state);
  const previous = new OwnerPrediction(state, "a");
  const unresolved = input("a", 21, Input.HardDrop);
  previous.submit(unresolved);
  authoritative.submit(input("b", 0, Input.HardDrop));
  authoritative.advanceToFrame(1);
  previous.advanceToFrame(22);
  expect(previous.gameState().board.some(cell => cell === 8)).toBe(false);
  const corrected = new OwnerPrediction(JSON.parse(JSON.stringify(authoritative.saveState())), "a");
  corrected.submit(unresolved);
  authoritative.submit(unresolved);
  corrected.advanceToFrame(22);
  authoritative.advanceToFrame(22);
  expectOwner(corrected, authoritative);
  expect(corrected.gameState().board.some(cell => cell === 8)).toBe(true);
});

test("render advancement includes only deadlines at or before the requested time", () => {
  const state = new Match(options).saveState();
  Object.assign(state.players[0].game.state, { piece: Piece.O, rot: 0, x: 4, y: 38 });
  const predicted = new OwnerPrediction(state, "a");
  predicted.submit(input("a", 35, Input.HardDrop));
  predicted.advanceToTime(30.5 * FRAME_MS);
  expect(predicted.gameState().lastResult).toBeNull();
  expect(predicted.frame).toBe(30);
  expect(predicted.atMs).toBe(30.5 * FRAME_MS);
  expect(predicted.gameState().state.observedNow).toBe(predicted.atMs);
  predicted.advanceToTime(31 * FRAME_MS);
  expect(predicted.gameState().lastResult?.atMs).toBe(31 * FRAME_MS);
  expect(predicted.saveState().inputs).toHaveLength(1);
  expect(predicted.drainEvents().every(e => e.atMs <= predicted.atMs)).toBe(true);
  expect(() => predicted.advanceToTime(30 * FRAME_MS)).toThrow();
  expect(() => predicted.advanceToFrame(30)).toThrow();
});

test("same-time local inputs keep order and reject wrong owners, epochs and rounded frame edges", () => {
  const state = new Match(options).saveState();
  const predicted = new OwnerPrediction(state, "a");
  const before = predicted.saveState();
  for (const i of [input("b", 0, Input.LeftDown), { ...input("a", 0, Input.HardDrop), epoch: 99 },
    input("a", 1, Input.HardDrop, 0.9999999999999999)]) expect(() => predicted.submit(i)).toThrow();
  expect(predicted.saveState()).toEqual(before);
  predicted.submit(input("a", 0, Input.LeftDown, 0.25, 0));
  predicted.advanceToTime(0.25 * FRAME_MS);
  expect(() => predicted.submit(input("a", 0, Input.LeftUp, 0.25, 0))).toThrow();
  predicted.submit(input("a", 0, Input.LeftUp, 0.25, 1));
  predicted.advanceToTime(0.25 * FRAME_MS);
  expect(predicted.gameState().state.leftHeld).toBe(false);
  expect(() => predicted.submit(input("a", 0, Input.LeftDown, 0.1, 2))).toThrow();
});

test("practice reset correction retains epoch, shifted phase origin and frozen handling without aliases", () => {
  const match = new Match({ ...options, mode: "practice", attacksEnabled: false,
    handlingByPlayer: { a: { ...DEFAULT_HANDLING, arr: 0 } } });
  match.advanceToFrame(37);
  match.practiceReset("a");
  const checkpoint = match.saveState();
  const predicted = new OwnerPrediction(checkpoint, "a");
  expect(predicted.epoch).toBe(1);
  expect(predicted.mode).toBe("practice");
  expect(predicted.attacksEnabled).toBe(false);
  expect(Object.isFrozen(predicted.handling)).toBe(true);
  checkpoint.players[0].game.board.fill(8);
  checkpoint.handlingByPlayer.a.arr = 5;
  const i = { ...input("a", 38, Input.LeftDown), epoch: 1 };
  match.submit(i);
  predicted.submit(i);
  match.advanceToFrame(40);
  predicted.advanceToFrame(40);
  expectOwner(predicted, match);
  const view = predicted.gameState();
  view.board.fill(8);
  expect(predicted.gameState().board).not.toEqual(view.board);
});

test("withdrawn and ended authoritative snapshots do not predict further play", () => {
  const match = new Match(options);
  match.forfeit("a");
  for (const owner of options.players) {
    const predicted = new OwnerPrediction(match.saveState(), owner);
    const before = predicted.saveState();
    expect(() => predicted.submit(input(owner, 0, Input.HardDrop))).toThrow();
    predicted.advanceToTime(1000);
    predicted.advanceToFrame(60);
    expect(predicted.saveState()).toEqual(before);
  }
});

test("release at a completed-frame boundary preserves the pending league phase and drops stale controls", () => {
  const match = new Match({ ...options, mode: "practice" });
  match.submit(input("a", 0, Input.LeftDown));
  match.submit(input("a", 4, Input.HardDrop));
  match.advanceToFrame(4);
  const before = match.playerState("a");
  match.releaseControls("a");
  const after = match.playerState("a");
  expect(after.state.leagueOriginMs).toBe(before.state.leagueOriginMs);
  expect(after.state.leagueFrame).toBe(before.state.leagueFrame);
  expect(after.state.lastNow).toBe(before.state.lastNow);
  expect(after.state.observedNow).toBe(before.state.observedNow);
  expect(match.saveState().inputs).toEqual([]);
  const predicted = new OwnerPrediction(match.saveState(), "a");
  const atBoundary = input("a", 4, Input.RightDown, 0);
  match.submit(atBoundary);
  predicted.submit(atBoundary);
  match.advanceToFrame(5);
  predicted.advanceToFrame(5);
  expectOwner(predicted, match);
  expect(predicted.gameState().lastResult).toBeNull();
});

test("undo correction invalidates the old epoch backlog and releases controls at the same boundary", () => {
  const match = new Match({ ...options, mode: "practice" });
  match.submit(input("a", 0, Input.HardDrop));
  match.submit(input("a", 1, Input.LeftDown));
  match.submit(input("b", 1, Input.RightDown, 0.25, 1));
  match.advanceToFrame(1);
  expect(match.practiceUndo("a")).toBe(true);
  expect(match.saveState().inputs.map(i => i.player)).toEqual(["b"]);
  const before = match.playerState("a");
  match.releaseControls("a");
  expect(match.playerState("a")).toEqual(before);
  const predicted = new OwnerPrediction(match.saveState(), "a");
  const stale = { ...input("a", 1, Input.LeftDown, 0), epoch: 0 };
  expect(() => predicted.submit(stale)).toThrow();
  expect(() => match.submit(stale)).toThrow();
  const current = { ...stale, epoch: match.playerEpoch("a") };
  match.submit(current);
  predicted.submit(current);
  match.advanceToFrame(2);
  predicted.advanceToFrame(2);
  expectOwner(predicted, match);
});

test("FFA withdrawal stops only that owner's prediction and preserves remaining owner inputs", () => {
  const match = new Match({ ...options, players: ["a", "b", "c"] });
  match.submit(input("a", 2, Input.HardDrop));
  match.submit(input("b", 2, Input.HardDrop, 0.25, 1));
  match.forfeit("a");
  expect(match.ended).toBe(false);
  const withdrawn = new OwnerPrediction(match.saveState(), "a");
  const before = withdrawn.saveState();
  withdrawn.advanceToTime(1000);
  expect(withdrawn.saveState()).toEqual(before);
  const remaining = new OwnerPrediction(match.saveState(), "b");
  remaining.advanceToFrame(3);
  match.advanceToFrame(3);
  expectOwner(remaining, match);
});

test("four-wide prediction shares garbage holes and survives checkpoint restoration", () => {
  const state = new Match({ ...options, width: 4 }).saveState();
  state.players[0].garbage.packets.push({ id: 1, from: "b", to: "a", lines: 3,
    kind: "normal", atMs: 0, eligibleAtMs: 0 });
  const match = Match.fromState(state);
  const prediction = new OwnerPrediction(state, "a");
  const action = input("a", 1, Input.HardDrop);
  match.submit(action); prediction.submit(action);
  match.advanceToFrame(2); prediction.advanceToFrame(2);
  expectOwner(prediction, match);
  const inserted = prediction.drainEvents().filter(e => e.type === "insert");
  expect(inserted).toHaveLength(1);
  expect(inserted[0].holes.every(hole => hole >= 0 && hole < 4)).toBe(true);
  expect(Match.fromState(match.saveState()).saveState()).toEqual(match.saveState());
  expect(() => new Match({ ...options, width: 3 })).toThrow();
});

test.each([11, 12])("%i-wide prediction and match restoration agree", width => {
  const state = new Match({ ...options, width }).saveState();
  state.players[0].garbage.packets.push({ id: 1, from: "b", to: "a", lines: 3,
    kind: "normal", atMs: 0, eligibleAtMs: 0 });
  const match = Match.fromState(state);
  const prediction = new OwnerPrediction(state, "a");
  const action = input("a", 1, Input.HardDrop);
  match.submit(action); prediction.submit(action);
  match.advanceToFrame(2); prediction.advanceToFrame(2);
  expectOwner(prediction, match);
  const inserted = prediction.drainEvents().filter(e => e.type === "insert");
  expect(inserted).toHaveLength(1);
  expect(inserted[0].holes.every(hole => hole >= 0 && hole < width)).toBe(true);
  expect(Match.fromState(match.saveState()).saveState()).toEqual(match.saveState());
});
