import { canPlace, ROWS } from "./board";
import { Input, type InputId } from "./game";
import { FRAME_MS, type Handling } from "./handling";
import { kicksFor } from "./kicks";
import { MINOS, SPAWN_Y, spawnX, type PieceId } from "./pieces";
import { classifySpin, type Spin } from "./rules";

// one key press each: a das slide runs to the obstacle, a soft drop to the surface
export const Move = {
  Left: 0, Right: 1, DasLeft: 2, DasRight: 3, Cw: 4, Ccw: 5, Flip: 6, SoftDrop: 7, HardDrop: 8,
} as const;
export type MoveId = (typeof Move)[keyof typeof Move];

export interface Placement {
  readonly x: number;
  readonly y: number;
  readonly rot: number;
  readonly spin: Spin;
  /** Sorted board indices of the four locked cells. */
  readonly cells: readonly number[];
  readonly cost: number;
  /** Cheapest presses from spawn, ending with HardDrop. */
  readonly moves: readonly MoveId[];
}

export interface MovegenOptions {
  /** Non-negative integer cost per Move, one per press by default. */
  readonly costs?: ArrayLike<number>;
}

const UNIT_COSTS = [1, 1, 1, 1, 1, 1, 1, 1, 1];
const SPINS: readonly Spin[] = ["none", "mini", "full"];
// pieces sit up to 3 cells left of or above the board inside their box
const PAD = 3;
// rotation tags, the spin check only cares whether the last kick was the 4th
const ROTATED = 1, KICK4 = 2;

/**
 * Every distinct lock reachable from spawn with zero gravity, keyed by cells and spin,
 * each with its cheapest presses. Hold is up to the caller: pass the piece after hold.
 */
export function placements(board: Uint8Array, piece: PieceId, options: MovegenOptions = {}): Placement[] {
  const costs = options.costs ?? UNIT_COSTS;
  const width = board.length / ROWS;
  const xs = width + PAD, ys = ROWS + PAD;
  const size = 4 * ys * xs * 3;
  const dist = new Int32Array(size).fill(-1);
  const parent = new Int32Array(size);
  const via = new Uint8Array(size);
  const id = (x: number, y: number, rot: number, tag: number) => ((rot * ys + y + PAD) * xs + x + PAD) * 3 + tag;
  const start = spawnX(piece, width);
  if (!canPlace(board, piece, 0, start, SPAWN_Y)) return [];

  // dial's buckets: costs are small integers, so this is dijkstra without a heap
  const root = id(start, SPAWN_Y, 0, 0);
  const buckets: number[][] = [[root]];
  dist[root] = 0;
  let cost = 0, from = 0;
  const relax = (x: number, y: number, rot: number, tag: number, move: MoveId) => {
    const s = id(x, y, rot, tag), c = cost + costs[move];
    if (dist[s] !== -1 && dist[s] <= c) return;
    dist[s] = c;
    parent[s] = from;
    via[s] = move;
    (buckets[c] ??= []).push(s);
  };
  const found = new Map<number, number>();
  const cells = new Int32Array(4);
  const area = width * ROWS;

  for (; cost < buckets.length; cost++) {
    const bucket = buckets[cost];
    for (let i = 0; bucket && i < bucket.length; i++) {
      const s = from = bucket[i];
      if (dist[s] !== cost) continue;
      const tag = s % 3, x = (s / 3 | 0) % xs - PAD, rot = (s / 3 / xs / ys) | 0;
      const y = ((s / 3 / xs) | 0) % ys - PAD;

      let floor = y;
      while (canPlace(board, piece, rot, x, floor + 1)) floor++;
      const last = floor === y ? tag : 0;
      const spin = SPINS.indexOf(classifySpin(board, piece, rot, x, floor, last !== 0, last === KICK4 ? 4 : 0));
      const m = MINOS[piece][rot];
      for (let k = 0; k < 4; k++) cells[k] = (floor + m[k * 2 + 1]) * width + x + m[k * 2];
      cells.sort();
      const key = (((cells[0] * area + cells[1]) * area + cells[2]) * area + cells[3]) * 3 + spin;
      // buckets pop in cost order, so the first state to reach a lock is a cheapest one
      if (!found.has(key)) found.set(key, s);

      if (canPlace(board, piece, rot, x - 1, y)) relax(x - 1, y, rot, 0, Move.Left);
      if (canPlace(board, piece, rot, x + 1, y)) relax(x + 1, y, rot, 0, Move.Right);
      for (let dx = -1; dx <= 1; dx += 2) {
        let nx = x;
        while (canPlace(board, piece, rot, nx + dx, y)) nx += dx;
        if (nx !== x) relax(nx, y, rot, 0, dx < 0 ? Move.DasLeft : Move.DasRight);
      }
      for (let turn = 1; turn < 4; turn++) {
        const to = (rot + turn) & 3;
        const move = turn === 1 ? Move.Cw : turn === 3 ? Move.Ccw : Move.Flip;
        // same order as Game.rotate: natural rotation, then the kick table
        if (canPlace(board, piece, to, x, y)) relax(x, y, to, ROTATED, move);
        else {
          const kicks = kicksFor(piece, rot, to);
          for (let k = 0; k < kicks.length; k += 2) {
            if (!canPlace(board, piece, to, x + kicks[k], y + kicks[k + 1])) continue;
            relax(x + kicks[k], y + kicks[k + 1], to, k === 6 ? KICK4 : ROTATED, move);
            break;
          }
        }
      }
      if (floor !== y) relax(x, floor, rot, 0, Move.SoftDrop);
    }
  }

  const result: Placement[] = [];
  for (const [key, s] of found) {
    const moves: MoveId[] = [Move.HardDrop];
    for (let at = s; at !== root; at = parent[at]) moves.push(via[at] as MoveId);
    moves.reverse();
    const x = (s / 3 | 0) % xs - PAD, rot = (s / 3 / xs / ys) | 0;
    let y = ((s / 3 / xs) | 0) % ys - PAD;
    while (canPlace(board, piece, rot, x, y + 1)) y++;
    const m = MINOS[piece][rot];
    const occupied = [0, 2, 4, 6].map(k => (y + m[k + 1]) * width + x + m[k]).sort((a, b) => a - b);
    result.push({ x, y, rot, spin: SPINS[key % 3], cells: occupied, cost: dist[s] + costs[Move.HardDrop], moves });
  }
  return result;
}

/** Cheapest presses to lock the piece on the cells of (x, y, rot), optionally with a given spin. */
export function pathTo(board: Uint8Array, piece: PieceId,
  target: { x: number; y: number; rot: number; spin?: Spin }, options?: MovegenOptions): readonly MoveId[] | null {
  const width = board.length / ROWS;
  const m = MINOS[piece][target.rot & 3];
  const want = [0, 2, 4, 6].map(k => (target.y + m[k + 1]) * width + target.x + m[k]).sort((a, b) => a - b).join();
  let best: Placement | null = null;
  for (const p of placements(board, piece, options)) {
    if (p.cells.join() !== want || target.spin !== undefined && p.spin !== target.spin) continue;
    if (!best || p.cost < best.cost) best = p;
  }
  return best?.moves ?? null;
}

/**
 * Timed Game inputs for a move list. The game must use these handling values with
 * das > 0, arr 0, sddas 0 and sdarr 0. Das waits let time pass, so gravity slow
 * enough not to fall during them keeps the result equal to the search.
 */
export function toInputs(moves: readonly MoveId[], handling: Handling): { input: InputId; atMs: number }[] {
  const out: { input: InputId; atMs: number }[] = [];
  // one extra ms so float rounding never releases the key just before the repeat
  const dasMs = handling.das * FRAME_MS + 1;
  let t = 0;
  const press = (down: InputId, up: InputId, hold = 0) => {
    out.push({ input: down, atMs: t });
    t += hold;
    out.push({ input: up, atMs: t });
  };
  for (const move of moves) {
    if (move === Move.Left || move === Move.DasLeft) press(Input.LeftDown, Input.LeftUp, move === Move.DasLeft ? dasMs : 0);
    else if (move === Move.Right || move === Move.DasRight) press(Input.RightDown, Input.RightUp, move === Move.DasRight ? dasMs : 0);
    else if (move === Move.SoftDrop) press(Input.SoftDropDown, Input.SoftDropUp);
    else out.push({ input: move === Move.Cw ? Input.RotateCw : move === Move.Ccw ? Input.RotateCcw
      : move === Move.Flip ? Input.Rotate180 : Input.HardDrop, atMs: t });
  }
  return out;
}
