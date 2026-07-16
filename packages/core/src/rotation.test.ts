import { expect, test } from "bun:test";
import { COLS } from "./board";
import { Game, Input } from "./game";
import { GARBAGE, Piece } from "./pieces";

function freshGame(seed: number, wanted: number): Game {
  // reroll seeds until the first piece is the one the test wants
  for (let s = seed; ; s++) {
    const g = new Game(s);
    if (g.piece === wanted) return g;
  }
}

test("open field rotations do not move the piece", () => {
  const g = freshGame(1, Piece.T);
  const { x, y } = g;
  g.apply(Input.RotateCw, 0);
  expect(g.rot).toBe(1);
  expect(g.x).toBe(x);
  expect(g.y).toBe(y);
  expect(g.lastKickIndex).toBe(0);
  expect(g.lastWasRotation).toBe(true);
});

test("four cw rotations come back to spawn state", () => {
  const g = freshGame(1, Piece.J);
  const { x, y } = g;
  for (let i = 0; i < 4; i++) g.apply(Input.RotateCw, 0);
  expect(g.rot).toBe(0);
  expect(g.x).toBe(x);
  expect(g.y).toBe(y);
});

test("ccw and 180 set the right states", () => {
  const g = freshGame(1, Piece.S);
  g.apply(Input.RotateCcw, 0);
  expect(g.rot).toBe(3);
  g.apply(Input.Rotate180, 0);
  expect(g.rot).toBe(1);
});

test("movement clears the rotation flag", () => {
  const g = freshGame(1, Piece.L);
  g.apply(Input.RotateCw, 0);
  expect(g.lastWasRotation).toBe(true);
  g.apply(Input.LeftDown, 0);
  expect(g.lastWasRotation).toBe(false);
});

test("a blocked t piece takes the last kick of the table", () => {
  const g = freshGame(1, Piece.T);
  // park the t at x 4, y 20 without rotating
  g.x = 4;
  g.y = 20;
  // wall in rows 20 to 25 except the t's own cells and a hole that
  // only the last kick (-1, +2) of 0 to cw can reach
  for (let y = 20; y <= 25; y++) {
    for (let x = 0; x < COLS; x++) g.board[y * COLS + x] = GARBAGE;
  }
  // current t cells at rot 0
  for (const [cx, cy] of [
    [5, 20],
    [4, 21],
    [5, 21],
    [6, 21],
  ]) {
    g.board[cy * COLS + cx] = 0;
  }
  // hole for rot cw at x 3, y 22
  for (const [cx, cy] of [
    [5, 23],
    [4, 22],
    [4, 23],
    [4, 24],
  ]) {
    g.board[cy * COLS + cx] = 0;
  }
  g.apply(Input.RotateCw, 0);
  expect(g.rot).toBe(1);
  expect(g.x).toBe(3);
  expect(g.y).toBe(22);
  expect(g.lastKickIndex).toBe(4);
  expect(g.lastWasRotation).toBe(true);
});

test("a fully blocked rotation does nothing", () => {
  const g = freshGame(1, Piece.T);
  g.x = 4;
  g.y = 20;
  for (let y = 17; y <= 25; y++) {
    for (let x = 0; x < COLS; x++) g.board[y * COLS + x] = GARBAGE;
  }
  for (const [cx, cy] of [
    [5, 20],
    [4, 21],
    [5, 21],
    [6, 21],
  ]) {
    g.board[cy * COLS + cx] = 0;
  }
  g.apply(Input.RotateCw, 0);
  expect(g.rot).toBe(0);
  expect(g.x).toBe(4);
  expect(g.y).toBe(20);
});

test("i piece 180 kicks one row up when blocked below", () => {
  const g = freshGame(1, Piece.I);
  g.x = 3;
  g.y = 20;
  // rot 2 sits one row lower than rot 0 inside the i box, blocking
  // row 22 makes the natural 180 collide, the only kick is (0, -1)
  for (let x = 0; x < COLS; x++) g.board[22 * COLS + x] = GARBAGE;
  g.apply(Input.Rotate180, 0);
  expect(g.rot).toBe(2);
  expect(g.y).toBe(19);
  expect(g.lastKickIndex).toBe(1);
});
