import { Piece, type PieceId } from "./pieces";

// srs+ kick tables, copied from the tetr.io client bundle so rotation
// behaves exactly like tetr.io, x right, y down
// the natural rotation (0,0) is tried first and is not stored here
// transitions are keyed as from * 4 + to, rotation states 0 1 2 3 =
// spawn, cw, 180, ccw

const t = (nums: number[]) => Int8Array.from(nums);

const KICKS: Int8Array[] = [];
KICKS[0 * 4 + 1] = t([-1, 0, -1, -1, 0, 2, -1, 2]);
KICKS[1 * 4 + 0] = t([1, 0, 1, 1, 0, -2, 1, -2]);
KICKS[1 * 4 + 2] = t([1, 0, 1, 1, 0, -2, 1, -2]);
KICKS[2 * 4 + 1] = t([-1, 0, -1, -1, 0, 2, -1, 2]);
KICKS[2 * 4 + 3] = t([1, 0, 1, -1, 0, 2, 1, 2]);
KICKS[3 * 4 + 2] = t([-1, 0, -1, 1, 0, -2, -1, -2]);
KICKS[3 * 4 + 0] = t([-1, 0, -1, 1, 0, -2, -1, -2]);
KICKS[0 * 4 + 3] = t([1, 0, 1, -1, 0, 2, 1, 2]);
KICKS[0 * 4 + 2] = t([0, -1, 1, -1, -1, -1, 1, 0, -1, 0]);
KICKS[1 * 4 + 3] = t([1, 0, 1, -2, 1, -1, 0, -2, 0, -1]);
KICKS[2 * 4 + 0] = t([0, 1, -1, 1, 1, 1, -1, 0, 1, 0]);
KICKS[3 * 4 + 1] = t([-1, 0, -1, -2, -1, -1, 0, -2, 0, -1]);

// the i piece has its own table, symmetric in srs+ unlike guideline srs
const I_KICKS: Int8Array[] = [];
I_KICKS[0 * 4 + 1] = t([1, 0, -2, 0, -2, 1, 1, -2]);
I_KICKS[1 * 4 + 0] = t([-1, 0, 2, 0, -1, 2, 2, -1]);
I_KICKS[1 * 4 + 2] = t([-1, 0, 2, 0, -1, -2, 2, 1]);
I_KICKS[2 * 4 + 1] = t([-2, 0, 1, 0, -2, -1, 1, 2]);
I_KICKS[2 * 4 + 3] = t([2, 0, -1, 0, 2, -1, -1, 2]);
I_KICKS[3 * 4 + 2] = t([1, 0, -2, 0, 1, -2, -2, 1]);
I_KICKS[3 * 4 + 0] = t([1, 0, -2, 0, 1, 2, -2, -1]);
I_KICKS[0 * 4 + 3] = t([-1, 0, 2, 0, 2, 1, -1, -2]);
I_KICKS[0 * 4 + 2] = t([0, -1]);
I_KICKS[1 * 4 + 3] = t([1, 0]);
I_KICKS[2 * 4 + 0] = t([0, 1]);
I_KICKS[3 * 4 + 1] = t([-1, 0]);

export function kicksFor(piece: PieceId, from: number, to: number): Int8Array {
  const table = piece === Piece.I ? I_KICKS : KICKS;
  return table[from * 4 + to];
}
