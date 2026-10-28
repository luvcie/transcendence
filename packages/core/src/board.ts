import { GARBAGE, MINOS, type PieceId } from "./pieces";

export const COLS = 10;
// top 20 rows are a hidden buffer above the visible field
export const ROWS = 40;
export const VISIBLE_ROWS = 20;

export function createBoard(): Uint8Array {
  return new Uint8Array(COLS * ROWS);
}

export function cellAt(board: Uint8Array, x: number, y: number): number {
  return board[y * COLS + x];
}

export function canPlace(
  board: Uint8Array,
  piece: PieceId,
  rot: number,
  x: number,
  y: number,
): boolean {
  const m = MINOS[piece][rot & 3];
  for (let i = 0; i < 8; i += 2) {
    const cx = x + m[i];
    const cy = y + m[i + 1];
    if (cx < 0 || cx >= COLS || cy < 0 || cy >= ROWS) return false;
    if (board[cy * COLS + cx] !== 0) return false;
  }
  return true;
}

export function place(
  board: Uint8Array,
  piece: PieceId,
  rot: number,
  x: number,
  y: number,
): void {
  const m = MINOS[piece][rot & 3];
  for (let i = 0; i < 8; i += 2) {
    board[(y + m[i + 1]) * COLS + (x + m[i])] = piece;
  }
}

export function clearRows(board: Uint8Array): { rows: number[]; garbage: boolean } {
  const rows: number[] = [];
  let garbage = false;
  let target = ROWS - 1;
  for (let y = ROWS - 1; y >= 0; y--) {
    const start = y * COLS;
    const row = board.subarray(start, start + COLS);
    if (row.every(cell => cell !== 0)) {
      rows.push(y);
      garbage ||= row.includes(GARBAGE);
    } else {
      if (target !== y) board.copyWithin(target * COLS, start, start + COLS);
      target--;
    }
  }
  board.fill(0, 0, (target + 1) * COLS);
  return { rows: rows.reverse(), garbage };
}
