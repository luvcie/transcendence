import { Game, MINOS, Move, Piece, ROWS, SPAWN_Y, VISIBLE_ROWS, kicksFor, spawnX, targetPlacements, toInputs,
  type MoveId, type PieceId, type Placement } from "@42tris/core";
import { boardToGame, gameToLines } from "./editor-play";

const cols = 10;
const empty = "⬛".repeat(cols);
const stepTimeoutMs = 20_000;
const maxPiecesForShortestPlan = 10;
// toInputs needs instant movement, and gravity must not pull the piece during a das wait
const handling = { das: 1, arr: 0, sddas: 0, sdarr: 0 };

type Candidate = { piece: PieceId; placement: Placement; blocks: boolean };
type Shape = { cells: number[]; mask: bigint; supports: number[]; minCost: number };
type StepResult =
  | { status: "animated"; frames: string[][] }
  | { status: "clear/edit" | "unchanged" | "partial" | "unreachable" | "deadline" };
type Search = { deadline: number; nodes: number; limited: boolean };

const pieceIds = Object.values(Piece);
const bits = Array.from({ length: ROWS * cols }, (_, cell) => 1n << BigInt(cell));
const below = bits.map((_, cell) => {
  let mask = 0n;
  for (let at = cell + cols; at < bits.length; at += cols) mask |= bits[at];
  return mask;
});
const rowOf = (cell: number) => Math.floor(cell / cols);

function shapesFor(piece: PieceId, left: Uint8Array, target: Uint8Array) {
  const shapes = new Map<string, Shape>();
  const start = spawnX(piece);
  for (let rot = 0; rot < 4; rot++) {
    const minos = MINOS[piece][rot];
    const oneRotation = new Set([start]);
    if (rot) {
      const kicks = kicksFor(piece, 0, rot);
      for (let k = 0; k < kicks.length; k += 2) oneRotation.add(start + kicks[k]);
    }
    for (let x = -3; x < cols; x++) {
      const xs = [0, 2, 4, 6].map(i => x + minos[i]);
      if (xs.some(col => col < 0 || col >= cols)) continue;
      const minCost = rot === 0 ? (x === start ? 1 : 2) : oneRotation.has(x) ? 2 : 3;
      for (let y = ROWS - VISIBLE_ROWS - 3; y < ROWS; y++) {
        const cells = xs.map((col, i) => (y + minos[i * 2 + 1]) * cols + col);
        if (cells.some(cell => left[cell] !== piece)) continue;
        cells.sort((a, b) => a - b);
        const key = cells.join();
        const existing = shapes.get(key);
        if (existing) {
          existing.minCost = Math.min(existing.minCost, minCost);
          continue;
        }
        const supports = cells.map(cell => cell + cols).filter(cell => !cells.includes(cell) &&
          (cell >= target.length || target[cell]));
        if (!supports.length) continue;
        shapes.set(key, { cells, mask: cells.reduce((mask, cell) => mask | bits[cell], 0n), supports, minCost });
      }
    }
  }
  return [...shapes.values()];
}

function split(board: Uint8Array, left: Uint8Array, target: Uint8Array, search: Search, optimize: boolean) {
  const shapes = pieceIds.filter(piece => left.includes(piece)).map(piece => ({ piece, shapes: shapesFor(piece, left, target) }));
  // each cell contributes a quarter of the cheapest shape that could cover it
  const minCosts = new Uint8Array(left.length).fill(255);
  for (const group of shapes) for (const shape of group.shapes) for (const cell of shape.cells) {
    minCosts[cell] = Math.min(minCosts[cell], shape.minCost);
  }
  let mask = 0n, lowerBound = 0;
  for (let cell = 0; cell < left.length; cell++) {
    if (!left[cell]) continue;
    if (minCosts[cell] === 255) return null;
    mask |= bits[cell];
    lowerBound += minCosts[cell];
  }
  // the remaining cells determine where every placed cell sits
  const visited = new Map<bigint, number>();
  const path: Candidate[] = [];
  const best: { plan: Candidate[] | null; cost: number } = { plan: null, cost: Infinity };

  function visit(rest: bigint, cost: number, remainingCost: number) {
    if (cost + Math.ceil(remainingCost / 4) >= best.cost) return;
    if (!rest) {
      best.plan = path.slice();
      best.cost = cost;
      return;
    }
    if (performance.now() >= search.deadline) {
      search.limited = true;
      return;
    }
    if ((visited.get(rest) ?? Infinity) <= cost) return;
    visited.set(rest, cost);

    let covered = 0n;
    const grounded = shapes.map(({ piece, shapes }) => ({
      piece,
      shapes: shapes.filter(shape => {
        if ((shape.mask & rest) !== shape.mask) return false;
        covered |= shape.mask;
        return shape.supports.some(cell => cell >= board.length || board[cell]);
      }),
    }));
    if (covered !== rest) return;

    const candidates: Candidate[] = [];
    for (const { piece, shapes } of grounded) {
      if (!shapes.length) continue;
      search.nodes++;
      for (const placement of targetPlacements(board, piece, shapes.map(shape => shape.cells))) {
        const remaining = placement.cells.reduce((mask, cell) => mask ^ bits[cell], rest);
        const blocks = placement.cells.some(cell => (below[cell] & remaining) !== 0n);
        candidates.push({ piece, placement, blocks });
      }
    }
    candidates.sort((a, b) => Number(a.blocks) - Number(b.blocks) || rowOf(b.placement.cells[3]) - rowOf(a.placement.cells[3])
      || a.placement.cost - b.placement.cost || a.piece - b.piece);
    for (const candidate of candidates) {
      let next = rest, nextCost = remainingCost;
      for (const cell of candidate.placement.cells) {
        next ^= bits[cell];
        nextCost -= minCosts[cell];
        board[cell] = candidate.piece;
      }
      path.push(candidate);
      visit(next, cost + candidate.placement.cost, nextCost);
      path.pop();
      for (const cell of candidate.placement.cells) board[cell] = 0;
      if (search.limited || (!optimize && best.plan)) return;
    }
  }

  visit(mask, 0, lowerBound);
  return best.plan;
}

const view = (board: Uint8Array, rows: number) => gameToLines(board).slice(VISIBLE_ROWS - rows);

// one frame per press while some of the piece is inside the shown rows
function pieceFrames(board: Uint8Array, piece: PieceId, moves: readonly MoveId[], rows: number) {
  const game = new Game(1, 1e9, 1, handling);
  game.board.set(board);
  // the game dealt its own first piece, swap in the one being placed
  Object.assign(game, { piece, rot: 0, x: spawnX(piece), y: SPAWN_Y });
  const frames: string[][] = [];
  let at = 0;
  for (const move of moves) {
    if (move === Move.HardDrop) break;
    for (const input of toInputs([move], handling)) game.apply(input.input, at = at + input.atMs);
    const drawn = board.slice(), minos = MINOS[piece][game.rot];
    let visible = false;
    for (let i = 0; i < 8; i += 2) {
      const y = game.y + minos[i + 1];
      if (y >= ROWS - rows) visible = true;
      if (y >= 0) drawn[y * cols + game.x + minos[i]] = piece;
    }
    if (visible) frames.push(view(drawn, rows));
  }
  return frames;
}

function searchStep(from: string[], to: string[], rows: number, search: Search): StepResult {
  const board = new Uint8Array(ROWS * cols), target = new Uint8Array(ROWS * cols), left = new Uint8Array(ROWS * cols);
  boardToGame(from, board);
  boardToGame(to, target);
  const counts = new Array(8).fill(0);
  for (let i = 0; i < board.length; i++) {
    if (board[i]) {
      if (target[i] !== board[i]) return { status: "clear/edit" };
    } else if (target[i]) {
      left[i] = target[i];
      counts[target[i]]++;
    }
  }
  const pieces = counts.reduce((sum, count) => sum + count, 0) / 4;
  if (!pieces) return { status: "unchanged" };
  if (counts.some(count => count % 4)) return { status: "partial" };
  // large builds can have millions of equivalent orders even after finding a complete one
  const plan = split(board, left, target, search, pieces <= maxPiecesForShortestPlan);
  if (!plan) return { status: search.limited ? "deadline" : "unreachable" };
  const frames: string[][] = [];
  for (const { piece, placement } of plan) {
    const presses = pieceFrames(board, piece, placement.moves, rows);
    for (const cell of placement.cells) board[cell] = piece;
    const lock = view(board, rows);
    // a last press that already sits on the lock cells would show the same frame twice
    if (presses.at(-1)?.join() === lock.join()) presses.pop();
    frames.push(...presses, lock);
  }
  return { status: "animated", frames };
}

/** Frames that place the pieces added between two boards, ending on `to`. */
export function planStep(from: string[], to: string[], rows = Math.max(from.length, to.length)) {
  const result = searchStep(from, to, rows, { deadline: performance.now() + stepTimeoutMs, nodes: 0, limited: false });
  return result.status === "animated" ? result.frames : null;
}

type AnimationOptions = {
  stepTimeoutMs?: number;
  onProgress?(step: number, total: number): void;
  onStep?(step: { step: number; status: StepResult["status"]; nodes: number; ms: number; limited: boolean }): void;
};

/** `build` places the first board's pieces from empty. Boards shown as drawn are held three times. */
export function animateSteps(boards: string[][], hold: number, build = false, options: AnimationOptions = {}) {
  const rows = Math.max(...boards.map(board => board.length));
  const out: string[][] = [], holds: number[] = [], skipped: number[] = [], limited: number[] = [];
  let built = false;
  const add = (frames: string[][], duration: number) => {
    for (const frame of frames) {
      out.push(frame);
      holds.push(duration);
    }
  };
  for (let i = 0; i < boards.length; i++) {
    if (i === 0 && !build) {
      add([boards[i]], hold * 3);
      continue;
    }
    options.onProgress?.(i + 1, boards.length);
    const start = performance.now();
    const search = { deadline: start + (options.stepTimeoutMs ?? stepTimeoutMs), nodes: 0, limited: false };
    const result = searchStep(boards[i - 1] ?? [], boards[i], rows, search);
    options.onStep?.({ step: i + 1, status: result.status, nodes: search.nodes, ms: performance.now() - start, limited: search.limited });
    if (result.status === "animated") {
      if (search.limited) limited.push(i + 1);
      if (i === 0) {
        built = true;
        add([Array(rows).fill(empty)], hold);
      }
      add(result.frames, hold);
    } else {
      if (result.status === "deadline") skipped.push(i + 1);
      add([boards[i]], hold * 3);
    }
  }
  return { boards: out, holds, built, skipped, limited };
}
