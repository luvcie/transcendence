import { expect, test } from "bun:test";
import { canPlace, COLS, ROWS } from "./board";
import { Game, Input } from "./game";
import { MINOS, SPAWN_Y } from "./pieces";

test("hard drop locks at the floor and advances the queue once", () => {
  const g = new Game(108);
  const piece = g.piece;
  const x = g.x;
  const next = g.previews[0];
  const minos = MINOS[piece][g.rot];
  let bottom = 0;
  for (let i = 1; i < 8; i += 2) bottom = Math.max(bottom, minos[i]);

  g.apply(Input.HardDrop, 0);

  for (let i = 0; i < 8; i += 2) {
    expect(g.board[(ROWS - 1 - bottom + minos[i + 1]) * COLS + x + minos[i]]).toBe(piece);
  }
  expect([...g.board].filter(Boolean)).toHaveLength(4);
  expect(g.piece).toBe(next);
  expect(g.dealt).toBe(2);
  expect(g.y).toBe(SPAWN_Y);
});

test("hard drop stops above a stack without overwriting it", () => {
  const g = new Game(108);
  g.board.fill(8, (ROWS - 5) * COLS);
  for (let y = ROWS - 5; y < ROWS; y++) g.board[y * COLS + 9] = 0;
  const expected = g.board.slice();
  let y = g.y;
  while (canPlace(expected, g.piece, g.rot, g.x, y + 1)) y++;
  const minos = MINOS[g.piece][g.rot];
  for (let i = 0; i < 8; i += 2) {
    expected[(y + minos[i + 1]) * COLS + g.x + minos[i]] = g.piece;
  }

  g.apply(Input.HardDrop, 0);

  expect(g.board).toEqual(expected);
  expect(g.dealt).toBe(2);
});

test("hard drop locks immediately when already grounded", () => {
  const g = new Game(108);
  while (canPlace(g.board, g.piece, g.rot, g.x, g.y + 1)) g.y++;
  g.apply(Input.HardDrop, 0);
  expect([...g.board].filter(Boolean)).toHaveLength(4);
  expect(g.dealt).toBe(2);
});

test("hard drop does nothing after top out", () => {
  const g = new Game(108);
  g.topOut = true;
  const board = g.board.slice();
  g.apply(Input.HardDrop, 0);
  expect(g.board).toEqual(board);
  expect(g.dealt).toBe(1);
});
