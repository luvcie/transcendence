import { expect, test } from "bun:test";
import { canPlace, clearRows, COLS, createBoard, ROWS } from "./board";
import { Game, Input } from "./game";
import { DEFAULT_HANDLING } from "./handling";
import { GARBAGE, Piece } from "./pieces";
import { classifySpin } from "./rules";

function setCells(board: Uint8Array, cells: number[][]) {
  for (const [x, y] of cells) board[y * COLS + x] = Piece.J;
}

function tSlot() {
  const g = new Game(108);
  Object.assign(g, { piece: Piece.T, rot: 3, x: 3, y: 36 });
  setCells(g.board, [[3, 36], [5, 36], [3, 38]]);
  return g;
}

function tDouble(g: Game) {
  g.board.fill(0);
  Object.assign(g, { piece: Piece.T, rot: 1, x: 3, y: 37 });
  for (const y of [38, 39]) g.board.fill(Piece.J, y * COLS, (y + 1) * COLS);
  for (const x of [3, 4, 5]) g.board[38 * COLS + x] = 0;
  g.board[39 * COLS + 4] = 0;
  setCells(g.board, [[3, 37]]);
}

test("compaction removes separated rows and hidden rows while preserving cell colors", () => {
  const board = createBoard();
  board.fill(Piece.J, 5 * COLS, 6 * COLS);
  board.fill(GARBAGE, 37 * COLS, 38 * COLS);
  board.fill(Piece.S, 39 * COLS);
  board[4 * COLS + 2] = Piece.Z;
  board[38 * COLS + 8] = Piece.I;
  expect(clearRows(board)).toEqual({ rows: [5, 37, 39], garbage: true });
  expect(board[7 * COLS + 2]).toBe(Piece.Z);
  expect(board[39 * COLS + 8]).toBe(Piece.I);
  expect([...board].filter(Boolean)).toHaveLength(2);
});

test("locking clears one through four rows, detects all clears and keeps the board array", () => {
  for (let lines = 1; lines <= 4; lines++) {
    const g = new Game(108);
    Object.assign(g, { piece: Piece.I, rot: 1, x: 2 });
    for (let y = ROWS - lines; y < ROWS; y++) {
      g.board.fill(Piece.L, y * COLS, (y + 1) * COLS);
      g.board[y * COLS + 4] = 0;
    }
    const board = g.board;
    g.apply(Input.HardDrop, 0);
    expect(g.board).toBe(board);
    expect(g.stats.lines).toBe(lines);
    expect(g.lastClear?.rows).toEqual(Array.from({ length: lines }, (_, i) => ROWS - lines + i));
    expect(g.lastClear?.allClear).toBe(lines === 4);
    expect([...g.board].filter(Boolean)).toHaveLength(4 - lines);
    expect(g.dealt).toBe(2);
  }
});

test("a hidden surviving cell prevents an all clear", () => {
  const g = new Game(108);
  Object.assign(g, { piece: Piece.I, rot: 1, x: 2 });
  for (let y = 36; y < ROWS; y++) {
    g.board.fill(Piece.L, y * COLS, (y + 1) * COLS);
    g.board[y * COLS + 4] = 0;
  }
  g.board[0] = Piece.Z;
  g.apply(Input.HardDrop, 0);
  expect(g.lastClear?.allClear).toBe(false);
  expect(g.board[4 * COLS]).toBe(Piece.Z);
});

test("T corners select full and mini spins in every orientation, with the fifth-test upgrade", () => {
  const corners = [[3, 35], [5, 35], [5, 37], [3, 37]];
  for (let rot = 0; rot < 4; rot++) {
    for (const mini of [false, true]) {
      const board = createBoard();
      const missing = mini ? rot : (rot + 2) % 4;
      setCells(board, corners.filter((_, i) => i !== missing));
      setCells(board, [[4, 38]]);
      expect(classifySpin(board, Piece.T, rot, 3, 35, true, 0)).toBe(mini ? "mini" : "full");
      expect(classifySpin(board, Piece.T, rot, 3, 35, true, 4)).toBe("full");
      expect(classifySpin(board, Piece.T, rot, 3, 35, false, 4)).toBe("none");
    }
  }
});

test("immobile non-T pieces and T pieces without three corners count as minis", () => {
  const board = createBoard();
  setCells(board, [[3, 35], [6, 35], [4, 34], [4, 37]]);
  expect(classifySpin(board, Piece.O, 0, 4, 35, true, 0)).toBe("mini");
  expect(classifySpin(board, Piece.O, 0, 4, 35, false, 0)).toBe("none");
  board.fill(0);
  setCells(board, [[2, 36], [6, 36], [4, 34], [4, 37]]);
  expect(classifySpin(board, Piece.T, 0, 3, 35, true, 0)).toBe("mini");
  board[34 * COLS + 4] = 0;
  expect(classifySpin(board, Piece.T, 0, 3, 35, true, 0)).toBe("none");
});

test("a zero-distance hard drop preserves a successful spin and failed sideways movement", () => {
  const g = tSlot();
  g.apply(Input.RotateCw, 0);
  expect(g.rot).toBe(0);
  expect(canPlace(g.board, g.piece, g.rot, g.x, g.y + 1)).toBe(false);
  g.apply(Input.LeftDown, 0);
  expect(g.x).toBe(3);
  g.apply(Input.HardDrop, 0);
  expect(g.lastClear?.spin).toBe("full");
  expect(g.lastClear?.attacks).toEqual([]);
});

test("180 rotation qualifies using the final orientation's corners", () => {
  const g = tSlot();
  g.rot = 2;
  g.apply(Input.Rotate180, 0);
  expect(g.rot).toBe(0);
  g.apply(Input.HardDrop, 0);
  expect(g.lastClear?.spin).toBe("full");
});

test("actual downward travel after a rotation invalidates the spin", () => {
  const g = new Game(108);
  g.piece = Piece.T;
  g.apply(Input.RotateCw, 0);
  g.apply(Input.HardDrop, 0);
  expect(g.lastClear?.spin).toBe("none");
});

test("lock events survive a top out and drain exactly once", () => {
  const g = new Game(108);
  g.board.fill(Piece.J, 19 * COLS + 3, 19 * COLS + 7);
  g.y = 30;
  g.apply(Input.HardDrop, 12);
  expect(g.topOut).toBe(true);
  const events = g.drainEvents();
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ type: "lock", sequence: 1, atMs: 12 });
  expect(g.drainEvents()).toEqual([]);
});

test("quarter-turn and 180 fifth-test kicks upgrade an otherwise mini T-spin", () => {
  const fixtures = [
    { turn: Input.RotateCw, rot: 1, cells: [[5, 28], [7, 28], [4, 29], [7, 30], [4, 31], [6, 32]] },
    { turn: Input.Rotate180, rot: 3, cells: [[4, 28], [4, 30], [6, 30], [6, 31]] },
  ];
  for (const { turn, rot, cells } of fixtures) {
    const g = new Game(108);
    Object.assign(g, { piece: Piece.T, rot, x: 4, y: 30 });
    setCells(g.board, cells);
    g.apply(turn, 0);
    expect(g.lastKickIndex).toBe(4);
    expect(classifySpin(g.board, g.piece, g.rot, g.x, g.y, true, 0)).toBe("mini");
    g.apply(Input.HardDrop, 0);
    expect(g.lastClear?.spin).toBe("full");
  }
});

test("a T-spin double is classified before its corner rows are removed", () => {
  const g = new Game(108);
  tDouble(g);
  g.apply(Input.RotateCw, 0);
  expect(g.rot).toBe(2);
  g.apply(Input.HardDrop, 0);
  expect(g.lastClear).toMatchObject({ spin: "full", rows: [38, 39], attacks: [{ kind: "normal", lines: 4 }] });
});

test("failed rotations preserve an existing spin", () => {
  const g = new Game(108);
  Object.assign(g, { piece: Piece.T, rot: 0, x: 3, y: 36 });
  g.board.fill(Piece.J, 33 * COLS);
  for (let y = 33; y < ROWS; y++) g.board[y * COLS] = 0;
  for (const [x, y] of [[4, 36], [3, 37], [4, 37], [5, 37]]) g.board[y * COLS + x] = 0;
  g.lastWasRotation = true;
  g.apply(Input.RotateCw, 0);
  expect(g.rot).toBe(0);
  g.apply(Input.HardDrop, 0);
  expect(g.lastClear?.spin).toBe("full");
});

test("T-spin doubles establish and extend B2B while soft drop is held", () => {
  for (const sdarr of [0, 2]) {
    for (const timedLock of [false, true]) {
      const g = new Game(108, 500, 5, { ...DEFAULT_HANDLING, sdarr });
      for (let i = 0; i < 3; i++) {
        const at = i * 2000;
        g.tick(at);
        tDouble(g);
        g.apply(Input.SoftDropDown, at);
        g.apply(Input.RotateCw, at);
        if (timedLock) g.tick(at + 1000);
        else g.apply(Input.HardDrop, at + 10);
        g.apply(Input.SoftDropUp, at + 1000);
        expect(g.lastClear).toMatchObject({ spin: "full", rows: [38, 39] });
        expect(g.stats.chainLength).toBe(i + 1);
        expect(g.stats.b2b).toBe(i);
      }
    }
  }
});
