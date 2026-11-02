import { expect, test } from "bun:test";
import { DEFAULT_HANDLING, FRAME_MS, Input, LEAGUE_LOCK, Piece, type GameState } from "@42tris/core";
import { Match, type MatchInput, type MatchOptions } from "./match";
import type { Packet } from "./garbage";

const options: MatchOptions = { players: ["a", "b"], seed: 108, mode: "practice" };

function submit(match: Match, player: string, key = Input.HardDrop as MatchInput["input"], frame = match.frame, order = 0) {
  match.submit({ player, frame, subframe: 0.25, order, input: key });
}

function quad(game: GameState) {
  game.board.fill(0);
  Object.assign(game.state, { piece: Piece.I, rot: 1, x: 2, y: 18 });
  for (let y = 36; y < 40; y++) {
    game.board.fill(Piece.L, y * 10, (y + 1) * 10);
    game.board[y * 10 + 4] = 0;
  }
}

function incoming(id = 1, lines = 4): Packet {
  return { id, lines, from: "a", to: "b", kind: "normal", atMs: 0, eligibleAtMs: 0 };
}

test("handling is validated, copied, frozen per player and preserved by restoration and reset", () => {
  const handling = { ...DEFAULT_HANDLING, das: 0, arr: 0 };
  const match = new Match({ ...options, handlingByPlayer: { a: handling } });
  handling.das = 20;
  expect(match.handlingByPlayer.a.das).toBe(0);
  expect(Object.isFrozen(match.handlingByPlayer)).toBe(true);
  expect(Object.isFrozen(match.handlingByPlayer.a)).toBe(true);
  expect(match.handlingByPlayer.b).toEqual(DEFAULT_HANDLING);
  submit(match, "a", Input.LeftDown);
  submit(match, "b", Input.LeftDown, 0, 1);
  match.advanceToFrame(1);
  expect(match.playerState("a").state.x).toBeLessThan(match.playerState("b").state.x);
  const snapshot = JSON.parse(JSON.stringify(match.saveState()));
  const restored = Match.fromState(snapshot);
  expect(restored.saveState()).toEqual(match.saveState());
  snapshot.handlingByPlayer.a.das = 30;
  expect(restored.handlingByPlayer.a.das).toBe(0);
  restored.practiceReset("a");
  expect(restored.playerState("a").config.handling).toEqual(match.handlingByPlayer.a);
  expect(() => new Match({ ...options, handlingByPlayer: { unknown: DEFAULT_HANDLING } })).toThrow();
  expect(() => new Match({ ...options, handlingByPlayer: { a: { ...DEFAULT_HANDLING, arr: -1 } } })).toThrow();
  const inconsistent = match.saveState();
  inconsistent.players[0].game.config.handling.das = 19;
  expect(() => Match.fromState(inconsistent)).toThrow("Checkpoint handling differs");
});

test("practice undo preserves sent attacks and a new placement can send again", () => {
  const state = new Match(options).saveState();
  quad(state.players[0].game);
  const match = Match.fromState(state);
  submit(match, "a");
  match.advanceToFrame(1);
  const beforeUndo = match.saveState();
  expect(beforeUndo.players[0].sent).toBe(9);
  expect(match.practiceUndo("a")).toBe(true);
  const afterUndo = match.saveState();
  expect(afterUndo.players[0].game.board).toEqual(state.players[0].game.board);
  expect(afterUndo.players[0].sent).toBe(9);
  expect(afterUndo.players[1]).toEqual(beforeUndo.players[1]);
  expect(afterUndo.players[0].epoch).toBe(1);
  expect(afterUndo.players[0].game.state.observedNow).toBe(FRAME_MS);
  expect(() => match.submit({ player: "a", frame: 1, subframe: 0, order: 0, input: Input.HardDrop, epoch: 0 })).toThrow();
  submit(match, "a");
  match.advanceToFrame(2);
  expect(match.saveState().players[0].sent).toBe(18);
  expect(match.saveState().players[1].garbage.packets.map(p => p.lines)).toEqual([4, 5, 4, 5]);
  const events = match.drainEvents();
  expect(events.filter(e => e.type === "lock").map(e => e.epoch)).toEqual([0, 1]);
  expect(events.filter(e => e.type === "lock").map(e => e.result.sequence)).toEqual([1, 3]);
});

test("practice undo removes inserted board garbage without rewinding the external queue", () => {
  const state = new Match(options).saveState();
  state.players[1].garbage.packets.push(incoming());
  state.packetSequence = 1;
  const match = Match.fromState(state);
  submit(match, "b");
  match.advanceToFrame(1);
  expect(match.playerState("b").board.filter(cell => cell === 8)).toHaveLength(36);
  const queue = match.saveState().players[1].garbage;
  expect(queue.packets).toEqual([]);
  expect(match.practiceUndo("b")).toBe(true);
  expect(match.playerState("b").board).toEqual(state.players[1].game.board);
  expect(match.saveState().players[1].garbage).toEqual(queue);
  submit(match, "b");
  match.advanceToFrame(2);
  expect(match.playerState("b").board.filter(cell => cell === 8)).toHaveLength(0);
});

test("disabled practice attacks block new sends but retain defense and existing incoming garbage", () => {
  const state = new Match({ ...options, attacksEnabled: false }).saveState();
  quad(state.players[0].game);
  state.players[0].garbage.packets.push({ ...incoming(), from: "b", to: "a", lines: 2 });
  state.players[1].garbage.packets.push(incoming(2));
  state.packetSequence = 2;
  const match = Match.fromState(state);
  submit(match, "a");
  submit(match, "b", Input.HardDrop, 0, 1);
  match.advanceToFrame(1);
  expect(match.saveState().players[0].sent).toBe(0);
  expect(match.saveState().players[0].garbage.packets).toEqual([]);
  expect(match.playerState("b").board.filter(cell => cell === 8)).toHaveLength(36);
  expect(match.drainEvents().filter(e => e.type === "send")).toEqual([]);
  expect(match.practiceUndo("a")).toBe(true);
  match.setAttacksEnabled(true);
  submit(match, "a");
  match.advanceToFrame(2);
  expect(match.saveState().players[0].sent).toBe(9);
  const restored = Match.fromState(JSON.parse(JSON.stringify(match.saveState())));
  expect(restored.attacksEnabled).toBe(true);
  expect(() => new Match({ ...options, mode: "competitive", attacksEnabled: false })).toThrow();
});

test("practice topout does not eliminate, score or end; undo and reset recover the board", () => {
  const state = new Match(options).saveState();
  Object.assign(state.players[1].game.state, { piece: Piece.O, rot: 0, x: 4, y: 38 });
  state.players[1].game.board.fill(Piece.L, 180, 200);
  state.players[1].game.board[180] = state.players[1].game.board[190] = 0;
  const match = Match.fromState(state);
  submit(match, "b");
  match.advanceToFrame(1);
  expect(match.playerState("b").state.topOut).toBe(true);
  expect(match.ended).toBe(false);
  expect(match.complete).toBe(false);
  expect(match.scores).toEqual({ a: 0, b: 0 });
  expect(match.saveState().players[1].eliminated).toBe(false);
  expect(match.practiceUndo("b")).toBe(true);
  expect(match.playerState("b").state.topOut).toBe(false);
  submit(match, "b");
  match.advanceToFrame(2);
  expect(match.playerState("b").state.topOut).toBe(true);
  match.practiceReset("b");
  expect(match.playerState("b").state.topOut).toBe(false);
  expect(match.playerState("b").board.every(cell => cell === 0)).toBe(true);
  expect(match.drainEvents().some(e => e.type === "roundEnd" || e.type === "eliminated" || e.type === "setEnd")).toBe(false);
});

test("reset is isolated, drops old queued inputs, increments epoch and preserves the current clock origin", () => {
  const state = new Match(options).saveState();
  quad(state.players[0].game);
  state.players[0].garbage.packets.push({ ...incoming(), from: "b", to: "a", lines: 20, eligibleAtMs: 10000 });
  const match = Match.fromState(state);
  match.advanceToFrame(37);
  submit(match, "a", Input.HardDrop, 40);
  submit(match, "b", Input.LeftDown, 40, 1);
  const before = match.saveState();
  match.practiceReset("a");
  const after = match.saveState();
  expect(after.frame).toBe(37);
  expect(after.players[0].game.state.lastNow).toBe(37 * FRAME_MS);
  expect(after.players[0].game.state.leagueOriginMs).toBe(37 * FRAME_MS);
  expect(after.players[0].game.config.lockProfile).toBe(LEAGUE_LOCK);
  expect(after.players[0].garbage.packets).toEqual([]);
  expect(after.players[0].sent).toBe(before.players[0].sent);
  expect(after.players[0].epoch).toBe(before.players[0].epoch + 1);
  expect(after.players[1]).toEqual(before.players[1]);
  expect(after.inputs.map(i => i.player)).toEqual(["b"]);
  expect(after.players[0].game.previews).toEqual(new Match(options).playerState("a").previews);
  expect(match.practiceUndo("a")).toBe(false);
  const restored = Match.fromState(JSON.parse(JSON.stringify(match.saveState())));
  match.advanceToFrame(100);
  for (let frame = 38; frame <= 100; frame++) restored.advanceToFrame(frame);
  expect(restored.saveState()).toEqual(match.saveState());
  expect(match.playerState("a").lastResult).toBeNull();
});

test("reset does not retract attacks already sent to another board", () => {
  const state = new Match(options).saveState();
  quad(state.players[0].game);
  const match = Match.fromState(state);
  submit(match, "a");
  match.advanceToFrame(1);
  const before = match.saveState();
  match.practiceReset("a");
  expect(match.saveState().players[1]).toEqual(before.players[1]);
  expect(match.saveState().players[0].sent).toBe(9);
  expect(match.practiceUndo("a")).toBe(false);
});

test("release controls clears held and queued inputs without advancing board deadlines or the round", () => {
  const match = new Match({ ...options, mode: "competitive", handlingByPlayer: {
    a: { ...DEFAULT_HANDLING, das: 1, arr: 1 },
  } });
  submit(match, "a", Input.LeftDown);
  submit(match, "a", Input.SoftDropDown, 0, 1);
  submit(match, "b", Input.RightDown, 0, 2);
  match.advanceToFrame(2);
  submit(match, "a", Input.HardDrop, 3);
  submit(match, "b", Input.HardDrop, 3, 1);
  const before = match.saveState();
  match.releaseControls("a");
  const after = match.saveState();
  expect(after.frame).toBe(before.frame);
  expect(after.round).toBe(before.round);
  expect(after.players[0].game.board).toEqual(before.players[0].game.board);
  expect(after.players[0].game.state.x).toBe(before.players[0].game.state.x);
  expect(after.players[0].game.state.y).toBe(before.players[0].game.state.y);
  expect(after.players[0].game.state.leftHeld).toBe(false);
  expect(after.players[0].game.state.softHeld).toBe(false);
  expect(after.players[0].game.state.moveAt).toBeNull();
  expect(after.players[0].game.state.softAt).toBeNull();
  expect(after.players[1]).toEqual(before.players[1]);
  expect(after.inputs.map(i => i.player)).toEqual(["b"]);
  match.releaseControls();
  expect(match.saveState().inputs).toEqual([]);
  expect(match.playerState("b").state.rightHeld).toBe(false);
  expect(match.drainEvents().filter(e => e.type === "controlsReleased").every(e => e.atMs === 2 * FRAME_MS)).toBe(true);
});

test("FFA forfeit withdraws a seat across rounds with frozen handling and isolated simulation", () => {
  const match = new Match({ players: ["a", "b", "c", "d"], seed: 108, firstTo: 3,
    handlingByPlayer: { c: { ...DEFAULT_HANDLING, das: 2 } } });
  submit(match, "a", Input.LeftDown, 2);
  match.forfeit("a");
  expect(match.activePlayers).toEqual(["b", "c", "d"]);
  expect(match.ended).toBe(false);
  expect(match.saveState().inputs).toEqual([]);
  expect(() => submit(match, "a")).toThrow();
  match.forfeit("b");
  const state = match.saveState();
  state.players[3].game.state.topOut = true;
  const resumed = Match.fromState(state);
  resumed.advanceToFrame(1);
  expect(resumed.scores).toEqual({ a: 0, b: 0, c: 1, d: 0 });
  expect(resumed.complete).toBe(false);
  resumed.nextRound(109);
  expect(resumed.activePlayers).toEqual(["c", "d"]);
  expect(resumed.playerState("c").config.handling.das).toBe(2);
  expect(resumed.saveState().players.map(p => p.epoch)).toEqual([1, 1, 1, 1]);
  const withdrawn = resumed.playerState("a");
  resumed.advanceToFrame(30);
  expect(resumed.playerState("a")).toEqual(withdrawn);
  resumed.forfeit("d");
  expect(resumed.complete).toBe(true);
  expect(resumed.scores.c).toBe(2);
  expect(() => resumed.nextRound(110)).toThrow();
});

test("duel forfeit completes the set once; the last eligible player's departure aborts", () => {
  const match = new Match({ ...options, mode: "competitive", firstTo: 7 });
  match.forfeit("a");
  expect(match.complete).toBe(true);
  expect(match.scores).toEqual({ a: 0, b: 1 });
  const before = match.saveState();
  match.forfeit("a");
  expect(match.saveState()).toEqual(before);
  expect(() => match.nextRound(109)).toThrow();
  expect(match.drainEvents().at(-1)).toMatchObject({ type: "setEnd", winner: "b", reason: "forfeit" });
  match.forfeit("b");
  expect(match.activePlayers).toEqual([]);
  expect(match.drainEvents().at(-1)).toMatchObject({ type: "setEnd", winner: null, reason: "aborted" });
  expect(match.scores).toEqual({ a: 0, b: 1 });
  expect(Match.fromState(JSON.parse(JSON.stringify(match.saveState()))).saveState()).toEqual(match.saveState());
});

test("boundary operations at frame zero do not introduce negative clocks", () => {
  const match = new Match(options);
  const before = match.saveState();
  expect(match.practiceUndo("a")).toBe(false);
  expect(match.saveState()).toEqual(before);
  match.releaseControls();
  match.practiceReset("a");
  expect(match.playerState("a").state.lastNow).toBe(0);
  expect(match.playerState("a").state.observedNow).toBe(0);
  expect(() => match.forfeit("a")).toThrow();
  const competitive = new Match({ ...options, mode: "competitive" });
  expect(() => competitive.practiceReset("a")).toThrow();
  expect(() => competitive.practiceUndo("a")).toThrow();
  expect(() => competitive.setAttacksEnabled(false)).toThrow();
});

test("forfeit between rounds does not award another point for the ended round", () => {
  const state = new Match({ ...options, mode: "competitive" }).saveState();
  state.players[0].game.state.topOut = true;
  const match = Match.fromState(state);
  match.advanceToFrame(1);
  expect(match.ended).toBe(true);
  expect(match.complete).toBe(false);
  expect(match.scores.b).toBe(1);
  match.forfeit("a");
  expect(match.complete).toBe(true);
  expect(match.scores.b).toBe(1);
  expect(match.drainEvents().filter(e => e.type === "roundEnd")).toHaveLength(1);
});

test("restored practice checkpoints start fresh undo history while retaining mode, epochs and toggle", () => {
  const match = new Match({ ...options, attacksEnabled: false });
  submit(match, "a");
  match.advanceToFrame(1);
  match.practiceReset("b");
  const restored = Match.fromState(JSON.parse(JSON.stringify(match.saveState())));
  expect(restored.saveState()).toEqual(match.saveState());
  expect(restored.mode).toBe("practice");
  expect(restored.attacksEnabled).toBe(false);
  expect(restored.playerEpoch("b")).toBe(1);
  const before = restored.saveState();
  expect(restored.practiceUndo("a")).toBe(false);
  expect(restored.saveState()).toEqual(before);
  submit(restored, "a");
  restored.advanceToFrame(2);
  expect(restored.practiceUndo("a")).toBe(true);
  expect(restored.playerState("a").board).toEqual(before.players[0].game.board);
});
