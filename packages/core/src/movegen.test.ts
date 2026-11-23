import { expect, test } from "bun:test";
import { COLS, createBoard, ROWS } from "./board";
import { finessePlacement } from "./finesse";
import { Game, type PlacementSettlement } from "./game";
import { Move, pathTo, placements, toInputs, type MoveId } from "./movegen";
import { GARBAGE, MINOS, Piece, SPAWN_Y, spawnX, type PieceId } from "./pieces";
import { Rng } from "./rng";

const HANDLING = { das: 1, arr: 0, sddas: 0, sdarr: 0 };
const PIECES = Object.values(Piece);

function garbageBoard(seed: number): Uint8Array {
  const rng = new Rng(seed);
  const board = createBoard();
  for (let x = 0; x < COLS; x++) {
    const height = rng.nextBelow(9);
    for (let y = ROWS - height; y < ROWS; y++) if (rng.nextBelow(6)) board[y * COLS + x] = GARBAGE;
  }
  // floating blocks make overhangs and tuck spots
  for (let i = 0; i < 6; i++) board[(ROWS - 3 - rng.nextBelow(9)) * COLS + rng.nextBelow(COLS)] = GARBAGE;
  return board;
}

function setup(board: Uint8Array, piece: PieceId, locks: PlacementSettlement[]): Game {
  // slow gravity so das waits never drop the piece
  const game = new Game(1, 1e9, 5, HANDLING, 0, p => { locks.push(p); return []; });
  game.board.set(board);
  Object.assign(game, { piece, rot: 0, x: spawnX(piece), y: SPAWN_Y });
  return game;
}

function play(game: Game, moves: readonly MoveId[], startMs: number): number {
  let at = startMs;
  for (const { input, atMs } of toInputs(moves, HANDLING)) game.apply(input, at = startMs + atMs);
  return at;
}

const cellsOf = (piece: PieceId, { x, y, rot }: { x: number; y: number; rot: number }) =>
  [0, 2, 4, 6].map(k => (y + MINOS[piece][rot][k + 1]) * COLS + x + MINOS[piece][rot][k]).sort((a, b) => a - b);

test("every placement replays through the real game to the predicted lock", () => {
  for (let seed = 1; seed <= 40; seed++) {
    const board = garbageBoard(seed);
    for (const piece of PIECES) {
      const found = placements(board, piece);
      expect(found.length).toBeGreaterThan(0);
      for (const p of found) {
        const locks: PlacementSettlement[] = [];
        play(setup(board, piece, locks), p.moves, 0);
        expect(locks.length).toBe(1);
        expect(cellsOf(piece, locks[0])).toEqual([...p.cells]);
        expect(locks[0].result.spin).toBe(p.spin);
        expect(p.cost).toBe(p.moves.length);
      }
    }
  }
});

test("brute force over real game states finds the same locks at the same cost", () => {
  const steps = [Move.Left, Move.Right, Move.DasLeft, Move.DasRight, Move.Cw, Move.Ccw, Move.Flip, Move.SoftDrop];
  for (let seed = 100; seed < 102; seed++) {
    const board = garbageBoard(seed);
    for (const piece of PIECES) {
      const expected = new Map(placements(board, piece).map(p => [`${p.cells}|${p.spin}`, p.cost]));
      const reached = new Map<string, number>();
      const locks: PlacementSettlement[] = [];
      const start = setup(board, piece, locks);
      const seen = new Set<string>();
      let frontier = [{ game: start, at: 0 }];
      for (let depth = 0; frontier.length; depth++) {
        const next: typeof frontier = [];
        for (const { game, at } of frontier) {
          const key = `${game.x},${game.y},${game.rot},${game.lastWasRotation && (game.lastKickIndex === 4 ? 2 : 1)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const state = game.saveState();
          const drop = Game.fromState(state, p => { locks.push(p); return []; });
          play(drop, [Move.HardDrop], at);
          const lock = locks.pop()!;
          const lockKey = `${cellsOf(piece, lock)}|${lock.result.spin}`;
          if (!reached.has(lockKey)) reached.set(lockKey, depth + 1);
          for (const move of steps) {
            const child = Game.fromState(state, () => []);
            next.push({ game: child, at: play(child, [move], at) });
          }
        }
        frontier = next;
      }
      expect(reached).toEqual(expected);
    }
  }
}, 20000);

test("empty board costs match the finesse reference, hard drop not counted there", () => {
  const board = createBoard();
  for (const piece of PIECES) {
    for (const p of placements(board, piece)) {
      if (p.spin !== "none") continue;
      const presses = p.cost - 1;
      // full points up to the optimum, so this pins presses to exactly the optimum
      expect(finessePlacement(board, piece, p.rot, p.x, p.y, presses, false, false, true)).toBe(5);
      expect(finessePlacement(board, piece, p.rot, p.x, p.y, presses + 1, false, false, true)).not.toBe(5);
    }
  }
});

const fill = (board: Uint8Array, cells: [number, number][]) => { for (const [x, y] of cells) board[y * COLS + x] = GARBAGE; };
const row = (y: number, except: number[] = []) =>
  Array.from({ length: COLS }, (_, x) => [x, y] as [number, number]).filter(([x]) => !except.includes(x));

test("o tucks under a roof after a soft drop", () => {
  const board = createBoard();
  fill(board, [[0, 37], [1, 37], [2, 37]]);
  const moves = pathTo(board, Piece.O, { x: 0, y: 38, rot: 0 });
  expect(moves).toEqual([Move.SoftDrop, Move.DasLeft, Move.HardDrop]);
});

test("i slides into a one row slot", () => {
  const board = createBoard();
  fill(board, row(38, [6, 7, 8, 9]));
  const moves = pathTo(board, Piece.I, { x: 0, y: 38, rot: 0 });
  expect(moves).toEqual([Move.DasRight, Move.SoftDrop, Move.DasLeft, Move.HardDrop]);
});

test("a t-spin triple slot is only reachable through the fourth kick", () => {
  const board = createBoard();
  fill(board, [...row(37, [2]), ...row(38, [1, 2]), ...row(39, [2]), ...row(36, [0, 1, 2]), [2, 35]]);
  const tst = cellsOf(Piece.T, { x: 1, y: 37, rot: 3 });
  const found = placements(board, Piece.T).filter(p => `${p.cells}` === `${tst}`);
  expect(found.map(p => p.spin)).toEqual(["full"]);
  const locks: PlacementSettlement[] = [];
  const game = setup(board, Piece.T, locks);
  play(game, found[0].moves, 0);
  expect(locks[0].result.rows.length).toBe(3);
  expect(locks[0].result.spin).toBe("full");
});

test("an enclosed pocket is never offered", () => {
  const board = createBoard();
  fill(board, [...row(37), ...row(38, [4, 5]), ...row(39, [4, 5])]);
  expect(pathTo(board, Piece.O, { x: 4, y: 38, rot: 0 })).toBeNull();
  expect(placements(board, Piece.O).every(p => p.cells.every(c => c < 37 * COLS))).toBe(true);
});
