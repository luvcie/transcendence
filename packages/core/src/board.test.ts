import { expect, test } from "bun:test";
import { COLS, ROWS, canPlace, cellAt, createBoard, place } from "./board";
import { Piece } from "./pieces";

test("piece fits on an empty board", () => {
  const b = createBoard();
  expect(canPlace(b, Piece.T, 0, 3, 18)).toBe(true);
});

test("walls and floor stop a piece", () => {
  const b = createBoard();
  expect(canPlace(b, Piece.T, 0, -1, 18)).toBe(false);
  expect(canPlace(b, Piece.T, 0, COLS - 2, 18)).toBe(false);
  expect(canPlace(b, Piece.T, 0, 3, ROWS - 1)).toBe(false);
});

test("placed cells keep the piece id and block other pieces", () => {
  const b = createBoard();
  place(b, Piece.T, 0, 3, 18);
  expect(cellAt(b, 4, 18)).toBe(Piece.T);
  expect(canPlace(b, Piece.T, 0, 3, 18)).toBe(false);
});

test("rotation is normalized so 4 means spawn", () => {
  const b = createBoard();
  place(b, Piece.S, 4, 0, 0);
  expect(cellAt(b, 1, 0)).toBe(Piece.S);
});
