import { expect, test } from "bun:test";
import { canPlace, clearRows, createBoard } from "./board";
import { finessePlacement } from "./finesse";
import { Game, Input, type SettlePlacement } from "./game";
import { DEFAULT_HANDLING } from "./handling";
import { Piece, SPAWN_Y, spawnX } from "./pieces";

const game = (width: number, settlement: SettlePlacement | null = null) =>
  new Game(108, 500, 5, DEFAULT_HANDLING, 0, settlement, undefined, width);

test("all supported widths spawn every piece, including the I, within the field", () => {
  for (let width = 4; width <= 12; width++) {
    const board = createBoard(width);
    for (let piece = 1; piece <= 7; piece++) {
      expect(canPlace(board, piece as 1, 0, spawnX(piece as 1, width), SPAWN_Y)).toBe(true);
    }
  }
  expect(game(10).saveState().config.width).toBe(10);
  for (const width of [3, 13, 4.5, NaN]) expect(() => game(width)).toThrow();
});

test("four-wide walls, kicks, drops and clears use the board dimensions", () => {
  const g = game(4);
  Object.assign(g, { piece: Piece.I, x: 0, y: SPAWN_Y });
  g.apply(Input.LeftDown, 0);
  expect(g.x).toBe(0);
  g.apply(Input.RotateCw, 0);
  expect(g.rot).toBe(1);
  g.apply(Input.LeftUp, 0);
  g.apply(Input.LeftDown, 0);
  g.tick(1000);
  expect(canPlace(g.board, g.piece, g.rot, g.x - 1, g.y)).toBe(false);
  g.apply(Input.Rotate180, 1000);
  expect(g.rot).toBe(3);
  g.apply(Input.HardDrop, 1000);
  expect(g.board.length).toBe(160);
  const board = createBoard(4);
  board.fill(1, 39 * 4);
  expect(clearRows(board).rows).toEqual([39]);
  expect(board.every(cell => cell === 0)).toBe(true);
});

test("garbage validates holes and overflow, and four-wide snapshots continue deterministically", () => {
  const g = game(4, () => [3]);
  const restored = Game.fromState(JSON.parse(JSON.stringify(g.saveState())), () => [3]);
  for (const instance of [g, restored]) instance.apply(Input.HardDrop, 0);
  expect(restored.saveState()).toEqual(g.saveState());
  expect([...g.board.slice(-4)]).toEqual([8, 8, 8, 0]);
  const bad = game(4, () => [4]);
  expect(() => bad.apply(Input.HardDrop, 0)).toThrow();
  const overflow = game(4, () => [0]);
  overflow.board[0] = 1;
  overflow.apply(Input.HardDrop, 0);
  expect(overflow.topOut).toBe(true);
  const blocked = game(4);
  blocked.board.fill(1, 18 * 4, 21 * 4);
  blocked.apply(Input.Hold, 0);
  expect(blocked.topOut).toBe(true);
  const state = g.saveState();
  state.config.width = 5;
  expect(() => Game.fromState(state, () => [])).toThrow();
});

test("four-wide finesse and Zen undo retain placement statistics", () => {
  const board = createBoard(4);
  expect(finessePlacement(board, Piece.T, 0, 0, 38, 0, false, false, false)).toBe(5);
  expect(finessePlacement(board, Piece.T, 0, 0, 38, 1, false, false, false)).toBe(2);
  const g = game(4);
  g.setZen(true);
  g.apply(Input.HardDrop, 0);
  expect(g.finesse).toEqual({ evaluated: 1, faults: 0, points: 5 });
  expect(g.undo(0)).toBe(true);
  expect(g.finesse.evaluated).toBe(0);
  expect(g.width).toBe(4);
});

test.each([11, 12])("%i-wide movement, finesse, garbage and restoration", width => {
  const rotated = game(width);
  Object.assign(rotated, { piece: Piece.I, x: spawnX(Piece.I, width) });
  rotated.apply(Input.RotateCw, 0);
  rotated.apply(Input.RightDown, 0);
  rotated.tick(2000);
  rotated.apply(Input.Rotate180, 2000);
  expect(rotated.rot).toBe(3);
  expect(canPlace(rotated.board, rotated.piece, rotated.rot, rotated.x, rotated.y)).toBe(true);
  expect(Game.fromState(rotated.saveState(), null).saveState()).toEqual(rotated.saveState());
  const g = game(width, () => [width - 1]);
  Object.assign(g, { piece: Piece.O, x: spawnX(Piece.O, width) });
  g.apply(Input.RightDown, 0);
  g.tick(2000);
  g.apply(Input.RightUp, 2000);
  expect(g.x).toBe(width - 2);
  const restored = Game.fromState(JSON.parse(JSON.stringify(g.saveState())), () => [width - 1]);
  for (const instance of [g, restored]) instance.apply(Input.HardDrop, 2000);
  expect(restored.saveState()).toEqual(g.saveState());
  expect(g.board.slice(-width)[width - 1]).toBe(0);
  expect(g.board.slice(-width).filter(cell => cell === 8)).toHaveLength(width - 1);
  const board = createBoard(width);
  const x = spawnX(Piece.T, width);
  expect(finessePlacement(board, Piece.T, 0, x, 38, 0, false, false, false)).toBe(5);
  expect(finessePlacement(board, Piece.T, 0, x, 38, 1, false, false, false)).toBe(2);
  expect(finessePlacement(board, Piece.T, 0, width - 3, 38, 1, false, false, true)).toBe(5);
});
