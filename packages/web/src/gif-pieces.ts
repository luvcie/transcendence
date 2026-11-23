import { Game, MINOS, Move, ROWS, SPAWN_Y, VISIBLE_ROWS, placements, spawnX, toInputs,
  type MoveId, type PieceId, type Placement } from "@42tris/core";
import { boardToGame, gameToLines } from "./editor-play";

const cols = 10;
const empty = "⬛".repeat(cols);
// placements calls per search, this keeps a hopeless board to about a second
const maxNodes = 2000;
// toInputs needs instant movement, and gravity must not pull the piece during a das wait
const handling = { das: 1, arr: 0, sddas: 0, sdarr: 0 };

type Plan = { piece: PieceId; placement: Placement }[];
type Best = { cost: number; plan: Plan } | null;
type Search = { memo: Map<string, Best>; nodes: number };

const lowest = (placement: Placement) => Math.max(...placement.cells);

// the exact cover of the added cells by reachable placements with the fewest presses in total.
// the board is the old one plus whatever is no longer left, so the left cells alone key the memo
function split(board: Uint8Array, left: Uint8Array, search: Search): Best {
  if (left.every(id => id === 0)) return { cost: 0, plan: [] };
  const key = left.join();
  if (search.memo.has(key)) return search.memo.get(key)!;
  const candidates: { piece: PieceId; placement: Placement }[] = [];
  for (let id = 1; id <= 7; id++) {
    const piece = id as PieceId;
    if (!left.includes(piece)) continue;
    // over the limit, callers keep the best complete order found so far
    if (search.nodes-- <= 0) return null;
    for (const placement of placements(board, piece)) {
      if (placement.cells.every(cell => left[cell] === piece)) candidates.push({ piece, placement });
    }
  }
  // bottom up first, so the first full order is a natural one and wins ties
  candidates.sort((a, b) => Math.floor(lowest(b.placement) / cols) - Math.floor(lowest(a.placement) / cols)
    || a.placement.cost - b.placement.cost || a.piece - b.piece);
  let best: Best = null;
  for (const candidate of candidates) {
    if (best && candidate.placement.cost >= best.cost) continue;
    const next = board.slice(), rest = left.slice();
    for (const cell of candidate.placement.cells) {
      next[cell] = candidate.piece;
      rest[cell] = 0;
    }
    const tail = split(next, rest, search);
    if (tail && (!best || candidate.placement.cost + tail.cost < best.cost)) {
      best = { cost: candidate.placement.cost + tail.cost, plan: [candidate, ...tail.plan] };
    }
  }
  search.memo.set(key, best);
  return best;
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

/**
 * Frames that place the pieces added between two boards one press at a time,
 * ending on `to`. Null when the step is not plain piece placements.
 */
export function planStep(from: string[], to: string[], rows = Math.max(from.length, to.length), maxPieces = 7): string[][] | null {
  const board = new Uint8Array(ROWS * cols), target = new Uint8Array(ROWS * cols), left = new Uint8Array(ROWS * cols);
  boardToGame(from, board);
  boardToGame(to, target);
  const counts = new Array(8).fill(0);
  for (let i = 0; i < board.length; i++) {
    // a changed or missing cell means a line clear or an edit
    if (board[i]) {
      if (target[i] !== board[i]) return null;
    } else if (target[i]) {
      left[i] = target[i];
      counts[target[i]]++;
    }
  }
  const pieces = counts.reduce((sum, count) => sum + count, 0) / 4;
  if (!pieces || pieces > maxPieces || counts.some(count => count % 4)) return null;
  const plan = split(board, left, { memo: new Map(), nodes: maxNodes })?.plan;
  if (!plan) return null;
  const frames: string[][] = [];
  for (const { piece, placement } of plan) {
    frames.push(...pieceFrames(board, piece, placement.moves, rows));
    for (const cell of placement.cells) board[cell] = piece;
    frames.push(view(board, rows));
  }
  return frames;
}

/**
 * Every board shown with its hold: one hold per press, three on each step's last frame.
 * `build` starts from an empty board and places the first board's pieces too.
 */
export function animateSteps(boards: string[][], hold: number, build = false) {
  const rows = Math.max(...boards.map(board => board.length));
  const first = build ? planStep([], boards[0], rows, Infinity) : null;
  const out = first ? [Array(rows).fill(empty)] : [], holds = first ? [hold * 3] : [];
  const add = (frames: string[][]) => frames.forEach((frame, k) => {
    out.push(frame);
    holds.push(k === frames.length - 1 ? hold * 3 : hold);
  });
  add(first ?? [boards[0]]);
  for (let i = 1; i < boards.length; i++) add(planStep(boards[i - 1], boards[i], rows) ?? [boards[i]]);
  return { boards: out, holds, built: !!first };
}
