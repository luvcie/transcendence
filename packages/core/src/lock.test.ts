import { expect, test } from "bun:test";
import { canPlace, COLS, ROWS } from "./board";
import { Game, Input, LOCK_DELAY_MS } from "./game";
import { DEFAULT_HANDLING } from "./handling";
import { Piece } from "./pieces";

function game() {
  return new Game(108, 500, 5, { ...DEFAULT_HANDLING, sddas: 0, sdarr: 0 });
}

test("instant soft drop gets a full lock delay even just before a gravity tick", () => {
  const g = game();
  g.tick(0);
  g.apply(Input.SoftDropDown, 499);
  g.tick(499 + LOCK_DELAY_MS - 1);
  expect(g.dealt).toBe(1);
  expect([...g.board].filter(Boolean)).toHaveLength(0);
  g.tick(499 + LOCK_DELAY_MS);
  expect(g.dealt).toBe(2);
  expect([...g.board].filter(Boolean)).toHaveLength(4);
});

test("successful grounded movement refreshes the lock timer", () => {
  const g = game();
  g.apply(Input.SoftDropDown, 0);
  const x = g.x;
  g.apply(Input.LeftDown, 900);
  g.apply(Input.LeftUp, 900);
  expect(g.x).toBe(x - 1);
  g.tick(1899);
  expect(g.dealt).toBe(1);
  g.tick(1900);
  expect(g.dealt).toBe(2);
});

test("successful rotation refreshes the lock timer", () => {
  const g = game();
  g.piece = Piece.O;
  g.apply(Input.SoftDropDown, 0);
  g.apply(Input.RotateCw, 900);
  expect(g.rot).toBe(1);
  g.tick(1899);
  expect(g.dealt).toBe(1);
  g.tick(1900);
  expect(g.dealt).toBe(2);
});

test("pressing against the wall does not postpone locking", () => {
  const g = game();
  while (canPlace(g.board, g.piece, g.rot, g.x - 1, g.y)) g.x--;
  g.apply(Input.SoftDropDown, 0);
  g.apply(Input.LeftDown, 900);
  g.tick(1000);
  expect(g.dealt).toBe(2);
});

test("failed rotation does not refresh the lock timer", () => {
  const g = game();
  g.piece = Piece.I;
  g.x = 3;
  g.apply(Input.SoftDropDown, 0);
  g.board.fill(8);
  // A one-row tunnel fits the horizontal I but none of its vertical kicks.
  for (let x = 3; x < 7; x++) g.board[(ROWS - 1) * COLS + x] = 0;
  g.apply(Input.RotateCw, 900);
  expect(g.rot).toBe(0);
  g.tick(1000);
  expect(g.dealt).toBe(2);
});

test("leaving a ledge suspends locking until the piece lands again", () => {
  const g = game();
  g.piece = Piece.O;
  g.x = 3;
  g.board[30 * COLS + 3] = 8;
  g.apply(Input.SoftDropDown, 0);
  g.apply(Input.SoftDropUp, 0);
  expect(g.y).toBe(28);
  g.apply(Input.RightDown, 900);
  g.apply(Input.RightUp, 900);
  g.tick(1900);
  expect(g.dealt).toBe(1);
  expect(g.y).toBe(30);
});

test("pause freezes the remaining lock delay", () => {
  const g = game();
  g.apply(Input.SoftDropDown, 0);
  g.setPaused(true, 600);
  g.tick(5000);
  g.setPaused(false, 5000);
  g.tick(5399);
  expect(g.dealt).toBe(1);
  g.tick(5400);
  expect(g.dealt).toBe(2);
});

test("hard drop bypasses lock delay", () => {
  const g = game();
  g.apply(Input.SoftDropDown, 0);
  g.apply(Input.HardDrop, 10);
  expect(g.dealt).toBe(2);
});

test("grounded finite soft drop also waits for the lock delay", () => {
  const g = new Game(108, 500, 5, { ...DEFAULT_HANDLING, sdarr: 0.1 });
  g.apply(Input.SoftDropDown, 0);
  g.tick(100);
  expect(canPlace(g.board, g.piece, g.rot, g.x, g.y + 1)).toBe(false);
  g.tick(1000);
  expect(g.dealt).toBe(1);
  g.tick(1100);
  expect(g.dealt).toBe(2);
});
