import { expect, test } from "bun:test";
import { COLS, ROWS } from "./board";
import { Game, Input, UNDO_LIMIT } from "./game";
import { DEFAULT_HANDLING } from "./handling";
import { Piece, SPAWN_Y } from "./pieces";

function state(g: Game) {
  return {
    board: g.board.slice(), previews: g.previews.slice(), piece: g.piece, rot: g.rot, x: g.x, y: g.y,
    held: g.held, holdUsed: g.holdUsed, dealt: g.dealt, topOut: g.topOut, stats: g.stats, lastClear: g.lastClear,
  };
}
function quad(g: Game) {
  g.board.fill(0);
  Object.assign(g, { piece: Piece.I, rot: 1, x: 2, y: SPAWN_Y });
  for (let y = 36; y < ROWS; y++) {
    g.board.fill(Piece.L, y * COLS, (y + 1) * COLS);
    g.board[y * COLS + 4] = 0;
  }
}

test("undo restores the turn before hold and discards current-piece movement", () => {
  const g = new Game(108);
  g.setZen(true);
  const before = state(g);
  g.apply(Input.Hold, 0);
  expect(g.undo(0)).toBe(false);
  g.apply(Input.HardDrop, 0);
  g.apply(Input.LeftDown, 0);
  g.apply(Input.Hold, 0);
  expect(g.undoCount).toBe(1);
  expect(g.undo(5000)).toBe(true);
  expect(state(g)).toEqual(before);
  g.tick(5001);
  expect(g.x).toBe(before.x);
  expect(g.y).toBe(before.y);
  expect(g.undo(5001)).toBe(false);
});

test("checkpoints restore queue and bag RNG across repeated shuffles", () => {
  const g = new Game(108);
  g.setZen(true);
  const before = state(g);
  const deals = [];
  for (let i = 0; i < 20; i++) {
    // Remove the stack between placements to exercise several bags without top-out.
    g.board.fill(0);
    deals.push([g.piece, ...g.previews]);
    g.apply(Input.HardDrop, 0);
  }
  for (let i = 0; i < 20; i++) expect(g.undo(100)).toBe(true);
  expect(state(g)).toEqual(before);
  for (let i = 0; i < 20; i++) {
    g.board.fill(0);
    expect([g.piece, ...g.previews]).toEqual(deals[i]);
    g.apply(Input.HardDrop, 100);
  }
});

test("undo restores clears, B2B, all-clear attacks and feedback without emitting old attacks", () => {
  const g = new Game(108);
  quad(g);
  g.setZen(true);
  const before = state(g);
  g.apply(Input.HardDrop, 0);
  const result = g.lastClear!;
  expect(result.allClear).toBe(true);
  expect(result.attacks).toEqual([{ kind: "normal", lines: 4 }, { kind: "allClear", lines: 5 }]);
  expect(g.undo(100)).toBe(true);
  expect(state(g)).toEqual(before);
  expect(g.drainEvents()).toEqual([{ type: "restored", sequence: 2, atMs: 100 }]);
  expect(g.drainEvents()).toEqual([]);
  g.apply(Input.HardDrop, 100);
  expect(g.lastClear?.attacks).toEqual(result.attacks);
  expect(g.lastClear?.sequence).toBe(3);
  expect(g.drainEvents()).toHaveLength(1);
});

test("undo a Surge release restores its charge and allows a different continuation", () => {
  const g = new Game(108);
  for (let i = 0; i < 5; i++) {
    quad(g);
    g.apply(Input.HardDrop, 0);
  }
  expect(g.stats.surge).toBe(4);
  Object.assign(g, { piece: Piece.O, rot: 0, x: 4, y: SPAWN_Y });
  g.board.fill(Piece.L, 39 * COLS);
  g.board[39 * COLS + 4] = g.board[39 * COLS + 5] = 0;
  g.setZen(true);
  const before = state(g);
  g.apply(Input.HardDrop, 0);
  expect(g.lastClear?.attacks.slice(0, 3)).toEqual([
    { kind: "surge", lines: 1 }, { kind: "surge", lines: 1 }, { kind: "surge", lines: 2 },
  ]);
  expect(g.stats.surge).toBe(0);
  g.undo(100);
  expect(state(g)).toEqual(before);
  g.apply(Input.LeftDown, 100);
  g.apply(Input.LeftUp, 100);
  g.apply(Input.HardDrop, 100);
  expect(g.lastClear?.rows).toEqual([]);
  expect(g.stats.surge).toBe(4);
  expect(g.lastClear?.attacks).toEqual([]);
});

test("undo recovers a topped-out board", () => {
  const g = new Game(108);
  g.board.fill(Piece.J, 19 * COLS + 3, 19 * COLS + 7);
  g.y = 30;
  g.setZen(true);
  const before = state(g);
  g.apply(Input.HardDrop, 0);
  expect(g.topOut).toBe(true);
  expect(g.undo(10000)).toBe(true);
  expect(state(g)).toEqual(before);
});

test("enabling Zen mid-turn preserves remaining lock time, even after a long wait", () => {
  const g = new Game(108, 500, 5, { ...DEFAULT_HANDLING, sdarr: 0 });
  g.apply(Input.SoftDropDown, 0);
  g.tick(600);
  g.setZen(true);
  g.tick(1000);
  expect(g.stats.pieces).toBe(1);
  g.undo(10000);
  g.tick(10399);
  expect(g.stats.pieces).toBe(0);
  g.tick(10400);
  expect(g.stats.pieces).toBe(1);
  expect(g.lastClear?.atMs).toBe(10400);
});

test("undo keeps current handling and pause settings while restoring gravity progress", () => {
  const g = new Game(108);
  g.tick(0);
  g.tick(300);
  g.setZen(true);
  g.apply(Input.HardDrop, 300);
  g.setHandling({ ...DEFAULT_HANDLING, das: 0, arr: 0 });
  g.setPaused(true, 300);
  g.undo(10000);
  expect(g.paused).toBe(true);
  g.tick(20000);
  expect(g.y).toBe(SPAWN_Y);
  g.setPaused(false, 20000);
  g.tick(20199);
  expect(g.y).toBe(SPAWN_Y);
  g.tick(20200);
  expect(g.y).toBe(SPAWN_Y + 1);
  g.apply(Input.LeftDown, 20200);
  expect(g.x).toBe(0);
});

test("Zen starts at the first spawn when enabled during the opening preview", () => {
  const g = new Game(108, 500, 5, DEFAULT_HANDLING, 250);
  g.setZen(true);
  g.tick(0);
  g.tick(250);
  const before = state(g);
  g.apply(Input.HardDrop, 250);
  g.undo(1000);
  expect(g.starting).toBe(false);
  expect(state(g)).toEqual(before);
});

test("checkpoints precede charged sideways and soft-drop input on the new piece", () => {
  const g = new Game(108, 500, 5, { ...DEFAULT_HANDLING, das: 0, arr: 0, sdarr: 0 });
  g.setZen(true);
  g.apply(Input.LeftDown, 0);
  g.apply(Input.SoftDropDown, 0);
  g.tick(2001);
  expect(g.stats.pieces).toBe(2);
  expect(g.undo(10000)).toBe(true);
  expect(g.y).toBe(SPAWN_Y);
  expect(g.x).toBe(3);
  const before = state(g);
  g.tick(10001);
  expect(state(g)).toEqual(before);
});

test("disabling Zen discards history, enabling it starts from the current position", () => {
  const g = new Game(108);
  g.apply(Input.HardDrop, 0);
  expect(g.undo(0)).toBe(false);
  g.setZen(true);
  const before = state(g);
  g.apply(Input.HardDrop, 0);
  g.setZen(true);
  expect(g.undoCount).toBe(1);
  g.undo(0);
  expect(state(g)).toEqual(before);
  g.apply(Input.HardDrop, 0);
  g.setZen(false);
  expect(g.undoCount).toBe(0);
  expect(g.undo(0)).toBe(false);
  const fresh = new Game(109);
  fresh.setZen(true);
  expect(fresh.undoCount).toBe(0);
  expect(fresh.stats.pieces).toBe(0);
});

test("undo history is bounded and never shares mutable board or queue arrays", () => {
  const g = new Game(108);
  g.setZen(true);
  for (let i = 0; i < UNDO_LIMIT + 2; i++) {
    g.board.fill(0);
    g.apply(Input.HardDrop, 0);
    g.drainEvents();
  }
  expect(g.undoCount).toBe(UNDO_LIMIT);
  for (let i = 0; i < UNDO_LIMIT; i++) expect(g.undo(0)).toBe(true);
  expect(g.stats.pieces).toBe(2);
  expect(g.undo(0)).toBe(false);
});
