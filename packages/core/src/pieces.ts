// cell ids follow the jstris skin order so atlas offsets line up later
export const Piece = { Z: 1, L: 2, O: 3, S: 4, I: 5, J: 6, T: 7 } as const;
export type PieceId = (typeof Piece)[keyof typeof Piece];

export const GARBAGE = 8;

// spawn shapes as x y pairs inside the bounding box, row 0 is the top
const SPAWN_SHAPES: Record<number, number[]> = {
  [Piece.Z]: [0, 0, 1, 0, 1, 1, 2, 1],
  [Piece.L]: [2, 0, 0, 1, 1, 1, 2, 1],
  [Piece.O]: [0, 0, 1, 0, 0, 1, 1, 1],
  [Piece.S]: [1, 0, 2, 0, 0, 1, 1, 1],
  [Piece.I]: [0, 1, 1, 1, 2, 1, 3, 1],
  [Piece.J]: [0, 0, 0, 1, 1, 1, 2, 1],
  [Piece.T]: [1, 0, 0, 1, 1, 1, 2, 1],
};

// srs rotates pieces inside a fixed box: i in 4x4, o in 2x2, the rest in 3x3
export const BOX: Record<number, number> = {
  [Piece.Z]: 3,
  [Piece.L]: 3,
  [Piece.O]: 2,
  [Piece.S]: 3,
  [Piece.I]: 4,
  [Piece.J]: 3,
  [Piece.T]: 3,
};

// MINOS[piece][rotation] = Int8Array of 8, x y pairs
// built once at load, the game loop only reads
export const MINOS: Int8Array[][] = [];

for (let p = 1; p <= 7; p++) {
  const n = BOX[p];
  const rots: Int8Array[] = [Int8Array.from(SPAWN_SHAPES[p])];
  for (let r = 1; r < 4; r++) {
    const prev = rots[r - 1];
    const next = new Int8Array(8);
    for (let i = 0; i < 8; i += 2) {
      // clockwise inside the box: (x, y) becomes (n - 1 - y, x)
      next[i] = n - 1 - prev[i + 1];
      next[i + 1] = prev[i];
    }
    rots.push(next);
  }
  MINOS[p] = rots;
}

// guideline spawn: just above the visible rows, may get tuned later
export const SPAWN_Y = 18;

export function spawnX(piece: PieceId): number {
  return piece === Piece.O ? 4 : 3;
}
