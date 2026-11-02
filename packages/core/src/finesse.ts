import { canPlace, COLS, createBoard } from "./board";
import { kicksFor } from "./kicks";
import { MINOS, SPAWN_Y, spawnX, type PieceId } from "./pieces";

export interface FinesseStats {
  readonly evaluated: number;
  readonly faults: number;
  readonly points: number;
}

export const INITIAL_FINESSE: FinesseStats = Object.freeze({ evaluated: 0, faults: 0, points: 0 });

export function finesseAccuracy(stats: FinesseStats): number | null {
  return stats.evaluated ? 100 * stats.points / (5 * stats.evaluated) : null;
}

// Empty-field reference: one press can move any distance, as with DAS/ARR.
function reference(piece: PieceId, instant: boolean): Map<string, number> {
  const board = createBoard();
  const queue = [{ x: spawnX(piece), rot: 0, cost: 0 }];
  const visited = new Map<string, number>();
  for (let i = 0; i < queue.length; i++) {
    const { x, rot, cost } = queue[i];
    const key = `${x},${rot}`;
    if (visited.has(key)) continue;
    visited.set(key, cost);
    for (const dx of [-1, 1]) {
      let nx = x + dx;
      while (canPlace(board, piece, rot, nx, SPAWN_Y)) {
        if (!instant || nx === x + dx || !canPlace(board, piece, rot, nx + dx, SPAWN_Y)) {
          queue.push({ x: nx, rot, cost: cost + 1 });
        }
        nx += dx;
      }
    }
    for (const turn of [1, 2, 3]) {
      const to = (rot + turn) & 3;
      if (canPlace(board, piece, to, x, SPAWN_Y)) queue.push({ x, rot: to, cost: cost + 1 });
      else {
        const kicks = kicksFor(piece, rot, to);
        for (let k = 0; k < kicks.length; k += 2) {
          if (canPlace(board, piece, to, x + kicks[k], SPAWN_Y + kicks[k + 1])) {
            queue.push({ x: x + kicks[k], rot: to, cost: cost + 1 });
            break;
          }
        }
      }
    }
  }
  return visited;
}
function shapeKey(piece: PieceId, rot: number, x: number): string {
  const minos = MINOS[piece][rot];
  const minY = Math.min(minos[1], minos[3], minos[5], minos[7]);
  return Array.from({ length: 4 }, (_, i) => `${x + minos[i * 2]},${minos[i * 2 + 1] - minY}`).sort().join(";");
}
const references = [false, true].map(instant => Array.from({ length: 7 }, (_, i) => {
  const piece = (i + 1) as PieceId;
  const shapes = new Map<string, number>();
  for (const [position, cost] of reference(piece, instant)) {
    const [x, rot] = position.split(",").map(Number);
    const key = shapeKey(piece, rot, x);
    shapes.set(key, Math.min(shapes.get(key) ?? Infinity, cost));
  }
  return shapes;
}));

export function finessePlacement(board: Uint8Array, piece: PieceId, rot: number, x: number, y: number,
  inputs: number, inherited: boolean, spin: boolean, instant: boolean): number | null {
  if (inherited || spin || y <= SPAWN_Y + 2) return null;
  const minos = MINOS[piece][rot];
  for (let i = 0; i < minos.length; i += 2) {
    const cx = x + minos[i], cy = y + minos[i + 1];
    for (let row = 0; row < cy; row++) if (board[row * COLS + cx]) return null;
  }
  const optimal = references[Number(instant)][piece - 1].get(shapeKey(piece, rot, x));
  if (optimal === undefined) return null;
  const extra = Math.max(0, inputs - optimal);
  return extra === 0 ? 5 : Math.max(0, 3 - extra);
}

export function addFinesse(stats: FinesseStats, points: number | null): FinesseStats {
  return points === null ? stats : Object.freeze({ evaluated: stats.evaluated + 1,
    faults: stats.faults + (points < 5 ? 1 : 0), points: stats.points + points });
}
