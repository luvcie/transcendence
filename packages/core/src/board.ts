import { GARBAGE, MINOS, type PieceId } from "./pieces";
import { boardEdges, pieceEdges } from "./board-edges";

export const COLS = 10;
// top 20 rows are a hidden buffer above the visible field
export const ROWS = 40;
export const VISIBLE_ROWS = 20;

export function validateBoardWidth(width: number): void {
  if (!Number.isInteger(width) || width < 4 || width > 12) throw new RangeError("Board width must be an integer from 4 to 12");
}

export function createBoard(width = COLS): Uint8Array {
  validateBoardWidth(width);
  return new Uint8Array(width * ROWS);
}

export function cellAt(board: Uint8Array, x: number, y: number): number {
  return board[y * (board.length / ROWS) + x];
}

export function canPlace(
  board: Uint8Array,
  piece: PieceId,
  rot: number,
  x: number,
  y: number,
): boolean {
  const width = board.length / ROWS;
  const m = MINOS[piece][rot & 3];
  for (let i = 0; i < 8; i += 2) {
    const cx = x + m[i];
    const cy = y + m[i + 1];
    if (cx < 0 || cx >= width || cy < 0 || cy >= ROWS) return false;
    if (board[cy * width + cx] !== 0) return false;
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
  const width = board.length / ROWS;
  const m = MINOS[piece][rot & 3];
  const edges = boardEdges(board);
  for (let i = 0; i < 8; i += 2) {
    board[(y + m[i + 1]) * width + (x + m[i])] = piece;
    edges[(y + m[i + 1]) * width + (x + m[i])] = pieceEdges(m, i);
  }
}

export function clearRows(board: Uint8Array): { rows: number[]; garbage: boolean } {
  const width = board.length / ROWS;
  const edges = boardEdges(board);
  const rows: number[] = [];
  let garbage = false;
  let target = ROWS - 1;
  for (let y = ROWS - 1; y >= 0; y--) {
    const start = y * width;
    const row = board.subarray(start, start + width);
    if (row.every(cell => cell !== 0)) {
      rows.push(y);
      garbage ||= row.includes(GARBAGE);
      // Cut links before collapsing; newly adjacent fragments must not join.
      if (y > 0) for (let x = 0; x < width; x++) edges[(y - 1) * width + x] &= ~(2 | 32 | 64);
      if (target < ROWS - 1) for (let x = 0; x < width; x++) edges[(target + 1) * width + x] &= ~(8 | 16 | 128);
    } else {
      if (target !== y) {
        board.copyWithin(target * width, start, start + width);
        edges.copyWithin(target * width, start, start + width);
      }
      target--;
    }
  }
  board.fill(0, 0, (target + 1) * width);
  edges.fill(0, 0, (target + 1) * width);
  return { rows: rows.reverse(), garbage };
}
