import { expect, test } from "bun:test";
import { createBoard } from "./board";
import { finesseAccuracy, finessePlacement } from "./finesse";
import { Game, Input } from "./game";
import { DEFAULT_HANDLING } from "./handling";
import { Piece } from "./pieces";

const board = createBoard();

test("reference accounts for piece shape, rotations, wall movement and instant ARR", () => {
  expect(finessePlacement(board, Piece.T, 0, 3, 38, 0, false, false, false)).toBe(5);
  expect(finessePlacement(board, Piece.T, 0, 0, 38, 1, false, false, true)).toBe(5);
  expect(finessePlacement(board, Piece.T, 0, 1, 38, 3, false, false, true)).toBe(2);
  expect(finessePlacement(board, Piece.T, 0, 1, 38, 1, false, false, false)).toBe(5);
  expect(finessePlacement(board, Piece.T, 2, 3, 37, 1, false, false, false)).toBe(5);
  expect(finessePlacement(board, Piece.T, 2, 3, 37, 2, false, false, false)).toBe(2);
  expect(finessePlacement(board, Piece.O, 1, 4, 38, 1, false, false, false)).toBe(2);
  expect(finessePlacement(board, Piece.I, 1, -2, 36, 2, false, false, true)).toBe(5);
});

test("roof, spins and inherited controls are excluded", () => {
  const roof = createBoard();
  roof[20 * 10 + 4] = 1;
  expect(finessePlacement(roof, Piece.T, 0, 3, 38, 5, false, false, false)).toBeNull();
  expect(finessePlacement(board, Piece.T, 0, 3, 38, 5, true, false, false)).toBeNull();
  expect(finessePlacement(board, Piece.T, 0, 3, 38, 5, false, true, false)).toBeNull();
});

test("statistics restore mid-piece, undo and restart without retaining abandoned placements", () => {
  const g = new Game(108);
  g.setZen(true);
  g.apply(Input.LeftDown, 0);
  g.apply(Input.LeftUp, 0);
  g.apply(Input.RightDown, 0);
  g.apply(Input.RightUp, 0);
  const restored = Game.fromState(JSON.parse(JSON.stringify(g.saveState())), null);
  for (const game of [g, restored]) game.apply(Input.HardDrop, 0);
  expect(g.finesse).toEqual({ evaluated: 1, faults: 1, points: 1 });
  expect(restored.finesse).toEqual(g.finesse);
  expect(finesseAccuracy(g.finesse)).toBe(20);
  expect(g.undo(0)).toBe(true);
  expect(g.finesse.evaluated).toBe(0);
  g.apply(Input.HardDrop, 0);
  expect(g.finesse).toEqual({ evaluated: 1, faults: 0, points: 5 });
  expect(finesseAccuracy(g.finesse)).toBe(100);
  expect(new Game(108).finesse.evaluated).toBe(0);
});

test("soft drop and zero DAS are excluded; ordinary custom handling counts logical inputs", () => {
  const soft = new Game(1);
  soft.apply(Input.SoftDropDown, 0);
  soft.apply(Input.HardDrop, 0);
  expect(soft.finesse.evaluated).toBe(0);
  const instant = new Game(1, 500, 5, { ...DEFAULT_HANDLING, das: 0 });
  instant.apply(Input.HardDrop, 0);
  expect(instant.finesse.evaluated).toBe(0);
  const custom = new Game(1, 500, 5, { ...DEFAULT_HANDLING, das: 4.9, arr: 0 });
  custom.apply(Input.HardDrop, 0);
  expect(custom.finesse).toEqual({ evaluated: 1, faults: 0, points: 5 });
});

test("several placements aggregate the Techmino weighted rate", () => {
  const game = new Game(2);
  game.apply(Input.HardDrop, 0);
  game.board.fill(0);
  game.apply(Input.LeftDown, 0);
  game.apply(Input.LeftUp, 0);
  game.apply(Input.RightDown, 0);
  game.apply(Input.RightUp, 0);
  game.apply(Input.HardDrop, 0);
  expect(game.finesse).toEqual({ evaluated: 2, faults: 1, points: 6 });
  expect(finesseAccuracy(game.finesse)).toBe(60);
});

test("180 input and wall taps are counted through the game engine", () => {
  const turn = new Game(1);
  Object.assign(turn, { piece: Piece.T });
  turn.apply(Input.Rotate180, 0);
  turn.apply(Input.HardDrop, 0);
  expect(turn.finesse).toEqual({ evaluated: 1, faults: 0, points: 5 });

  const wall = new Game(1, 500, 5, { ...DEFAULT_HANDLING, arr: 0 });
  Object.assign(wall, { piece: Piece.T });
  wall.apply(Input.LeftDown, 0);
  wall.tick(200);
  wall.apply(Input.LeftUp, 200);
  wall.apply(Input.LeftDown, 200);
  wall.apply(Input.LeftUp, 200);
  wall.apply(Input.HardDrop, 200);
  expect(wall.finesse).toEqual({ evaluated: 1, faults: 1, points: 2 });
});

test("snapshot rejects invalid finesse counters before restoring", () => {
  const game = new Game(1);
  game.apply(Input.HardDrop, 0);
  const state = JSON.parse(JSON.stringify(game.saveState()));
  state.lastResult.finesse.faults = 2;
  expect(() => game.restoreState(state, null)).toThrow();
  expect(game.finesse.faults).toBe(0);
});
