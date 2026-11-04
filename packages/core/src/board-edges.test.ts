import { expect, test } from "bun:test";
import { boardEdges, pieceEdges } from "./board-edges";
import { clearRows, createBoard, place } from "./board";
import { Game, Input } from "./game";
import { MINOS, Piece, type PieceId } from "./pieces";

test("placements retain their own connections when identical pieces touch", () => {
  const board = createBoard();
  place(board, Piece.S, 1, 0, 24);
  place(board, Piece.S, 3, 0, 25);
  expect([...board].filter(Boolean)).toHaveLength(8);
  expect(boardEdges(board)[251] & 15).toBe(12);
  expect(boardEdges(board)[261] & 15).toBe(3);
});

test("clears cut connections and move fragments without joining newly adjacent cells", () => {
  const board = createBoard();
  place(board, Piece.I, 1, 0, 20);
  for (let x = 0; x < 10; x++) if (x !== 2) board[210 + x] = Piece.J;
  expect(clearRows(board).rows).toEqual([21]);
  expect([212, 222, 232].map(index => boardEdges(board)[index])).toEqual([0, 2, 8]);
  expect([212, 222, 232].map(index => board[index])).toEqual([Piece.I, Piece.I, Piece.I]);
  for (let x = 0; x < 10; x++) if (x !== 2) board[220 + x] = Piece.J;
  expect(clearRows(board).rows).toEqual([22]);
  expect([222, 232].map(index => boardEdges(board)[index])).toEqual([0, 0]);
});

test("clearing either half of an O piece preserves horizontal edges and removes diagonals", () => {
  for (const row of [30, 31]) {
    const board = createBoard();
    place(board, Piece.O, 0, 2, 30);
    for (let x = 0; x < 10; x++) if (x !== 2 && x !== 3) board[row * 10 + x] = Piece.J;
    clearRows(board);
    expect(boardEdges(board)[312]).toBe(4);
    expect(boardEdges(board)[313]).toBe(1);
  }
});

test("all piece rotations retain only surviving original neighbors across every clear pattern", () => {
  for (let piece = 1; piece <= 7; piece++) for (let rot = 0; rot < 4; rot++) for (let mask = 1; mask < 16; mask++) {
    const board = createBoard(), rows = [20, 21, 22, 23].filter((_, i) => mask & (1 << i));
    for (const row of rows) board.fill(Piece.J, row * 10, (row + 1) * 10);
    place(board, piece as PieceId, rot, 3, 20);
    const minos = [...MINOS[piece][rot]];
    const surviving: number[] = [];
    for (let i = 0; i < 8; i += 2) if (!rows.includes(20 + minos[i + 1])) surviving.push(minos[i], minos[i + 1]);
    expect(clearRows(board).rows).toEqual(rows);
    for (let i = 0; i < surviving.length; i += 2) {
      const x = 3 + surviving[i], y = 20 + surviving[i + 1];
      const collapsed = y + rows.filter(row => row > y).length;
      expect(boardEdges(board)[collapsed * 10 + x]).toBe(pieceEdges(surviving, i));
    }
    expect([...board].filter(Boolean)).toHaveLength(surviving.length / 2);
  }
});

test("snapshots and undo keep detached edges without adding fields to serialized state", () => {
  const game = new Game(123);
  Object.assign(game, { piece: Piece.S, rot: 1, x: 0, y: 35 });
  game.tick(0); game.setZen(true);
  game.apply(Input.HardDrop, 1);
  const state = game.saveState(), edges = boardEdges(game.board).slice(), json = JSON.stringify(state);
  expect(edges.some(Boolean)).toBe(true);
  expect(boardEdges(Game.fromState(state, null).board)).toEqual(edges);
  expect(game.undo(2)).toBe(true);
  expect(boardEdges(game.board).every(value => value === 0)).toBe(true);
  game.apply(Input.HardDrop, 3);
  expect(boardEdges(game.board)).toEqual(edges);
  boardEdges(state.board).fill(0);
  expect(boardEdges(game.board)).toEqual(edges);
  expect(JSON.stringify(state)).toBe(json);
  game.restoreState(JSON.parse(json), null);
  expect(boardEdges(game.board).every(value => value === 0)).toBe(true);
});

test("garbage raises original edges and undo restores their previous positions", () => {
  const game = new Game(123, 500, 5, undefined, 0, () => [3, 5]);
  place(game.board, Piece.O, 0, 2, 25);
  Object.assign(game, { piece: Piece.I, rot: 1, x: 7, y: 18 });
  game.tick(0); game.setZen(true);
  const before = boardEdges(game.board).slice();
  game.apply(Input.HardDrop, 1);
  for (const index of [252, 253, 262, 263]) expect(boardEdges(game.board)[index - 20]).toBe(before[index]);
  expect(boardEdges(game.board).slice(380).every(value => value === 0)).toBe(true);
  expect(game.undo(2)).toBe(true);
  expect(boardEdges(game.board)).toEqual(before);
});
