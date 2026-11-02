import { expect, test } from "bun:test";
import { canPlace, COLS } from "./board";
import { Game, Input, type InputId } from "./game";
import { DEFAULT_HANDLING } from "./handling";
import { LEAGUE_LOCK, LOCK_RESET_LIMIT, MAX_GROUNDED_MS, PRACTICE_LOCK, lockDelay } from "./lock-profile";
import { Piece, SPAWN_Y, type PieceId } from "./pieces";

const handling = { ...DEFAULT_HANDLING, sddas: 0, sdarr: 0 };

function practice(seed = 108): Game {
  const game = new Game(seed, 500, 5, handling);
  game.tick(0);
  return game;
}

function league(): Game {
  const game = new Game(1, 500, 5, DEFAULT_HANDLING, 0, null, LEAGUE_LOCK);
  game.tick(0);
  return game;
}

function ground(game: Game, piece: PieceId = Piece.O, x = 4): void {
  game.piece = piece;
  game.rot = 0;
  game.x = x;
  game.y = SPAWN_Y;
  while (canPlace(game.board, game.piece, game.rot, game.x, game.y + 1)) game.y++;
}

function tap(game: Game, direction: "left" | "right", atMs: number): void {
  game.apply(direction === "left" ? Input.LeftDown : Input.RightDown, atMs);
  game.apply(direction === "left" ? Input.LeftUp : Input.RightUp, atMs);
}

/** Alternate successful floor moves and return the last input timestamp. */
function moveBudget(game: Game, moves: number, startMs: number): number {
  let at = startMs;
  for (let i = 0; i < moves; i++) {
    tap(game, i % 2 === 0 ? "left" : "right", at);
    at += 10;
  }
  return at - 10;
}

/** I-piece wall kick that leaves the piece hanging above the floor. */
function kickFixture(game: Game): void {
  game.piece = Piece.I;
  game.rot = 0;
  game.x = 1;
  game.y = 27;
  game.board[27 * COLS + 5] = 8;
  game.board[29 * COLS + 3] = 8;
  game.board[29 * COLS + 5] = 8;
}

test("a grounded practice piece still locks after the existing lock delay", () => {
  const g = practice();
  ground(g);
  expect(g.stats.pieces).toBe(0);
  g.tick(lockDelay(PRACTICE_LOCK) - 1);
  expect(g.stats.pieces).toBe(0);
  g.tick(lockDelay(PRACTICE_LOCK));
  expect(g.stats.pieces).toBe(1);
});

test("successful grounded moves consume one reset each and extend the lock timer", () => {
  const g = practice();
  ground(g);
  const last = moveBudget(g, 5, 100);
  expect(g.saveState().state.lockResets).toBe(5);
  expect(g.stats.pieces).toBe(0);
  g.tick(last + lockDelay(PRACTICE_LOCK) - 1);
  expect(g.stats.pieces).toBe(0);
  g.tick(last + lockDelay(PRACTICE_LOCK));
  expect(g.stats.pieces).toBe(1);
});

test("exhausting the reset budget prevents further timer resets", () => {
  const g = practice();
  ground(g);
  const last = moveBudget(g, LOCK_RESET_LIMIT, 10);
  expect(g.saveState().state.lockResets).toBe(LOCK_RESET_LIMIT);
  // The sixteenth successful move must not restart the fifteenth timer.
  tap(g, "right", last);
  expect(g.saveState().state.lockResets).toBe(LOCK_RESET_LIMIT);
  g.tick(last + lockDelay(PRACTICE_LOCK) - 1);
  expect(g.stats.pieces).toBe(0);
  g.tick(last + lockDelay(PRACTICE_LOCK));
  expect(g.stats.pieces).toBe(1);
});

test("extensive movement and rotation before first ground contact spend no resets", () => {
  const g = practice();
  expect(canPlace(g.board, g.piece, g.rot, g.x, g.y + 1)).toBe(true);
  expect(g.saveState().state.groundedAt).toBeNull();
  let at = 10;
  for (let i = 0; i < 80; i++) {
    tap(g, i % 2 === 0 ? "left" : "right", at);
    g.apply(Input.RotateCw, at);
    at += 10;
  }
  expect(g.dealt).toBe(1);
  expect(canPlace(g.board, g.piece, g.rot, g.x, g.y + 1)).toBe(true);
  expect(g.saveState().state.groundedAt).toBeNull();
  expect(g.saveState().state.lockResets).toBe(0);

  g.apply(Input.SoftDropDown, at);
  g.apply(Input.SoftDropUp, at);
  expect(g.saveState().state.groundedAt).toBe(at);
  expect(g.saveState().state.lockResets).toBe(0);
  tap(g, "left", at + 10);
  expect(g.saveState().state.lockResets).toBe(1);
});

test("repeated grounded rotations eventually lock", () => {
  const g = practice();
  ground(g);
  let at = 0;
  for (let i = 0; i < 200 && g.stats.pieces === 0; i++) {
    g.apply(Input.RotateCw, at);
    at += 50;
  }
  expect(g.stats.pieces).toBe(1);
});

test("repeated grounded lateral moves eventually lock", () => {
  const g = practice();
  ground(g);
  let at = 0;
  for (let i = 0; i < 200 && g.stats.pieces === 0; i++) {
    tap(g, i % 2 === 0 ? "left" : "right", at);
    at += 50;
  }
  expect(g.stats.pieces).toBe(1);
});

test("a ground-leaving rotation kick counts as a reset and cannot dodge the grounded lifetime", () => {
  const g = practice();
  kickFixture(g);
  g.apply(Input.RotateCw, 10);
  expect(g.rot).toBe(1);
  expect(g.x).toBe(2);
  expect(g.y).toBe(27);
  expect(canPlace(g.board, g.piece, g.rot, g.x, g.y + 1)).toBe(true);
  expect(g.saveState().state.lockResets).toBe(1);
  expect(g.saveState().state.groundedAt).toBe(0);
  // Expiry is never applied in midair: the piece is still falling at the cap.
  g.tick(MAX_GROUNDED_MS);
  expect(g.stats.pieces).toBe(0);
  // The next ground contact locks immediately, long before a fresh lock delay elapses.
  g.tick(4_510);
  expect(g.stats.pieces).toBe(1);
  expect(g.lastClear!.atMs).toBe(4_510);
  expect(g.lastClear!.atMs).toBeGreaterThanOrEqual(MAX_GROUNDED_MS);
});

test("failed rotations do not consume or replenish resets", () => {
  const g = practice();
  ground(g, Piece.I, 3);
  g.apply(Input.SoftDropDown, 0);
  g.board.fill(8, 34 * COLS);
  for (let y = 34; y < 40; y++) g.board[y * COLS] = 0;
  for (let x = 3; x < 7; x++) g.board[39 * COLS + x] = 0;
  g.apply(Input.RotateCw, 900);
  expect(g.rot).toBe(0);
  expect(g.saveState().state.lockResets).toBe(0);
  g.tick(1000);
  expect(g.stats.pieces).toBe(1);
});

test("hard drop still locks immediately and every newly active piece gets a fresh budget", () => {
  const g = practice();
  ground(g);
  moveBudget(g, LOCK_RESET_LIMIT, 10);
  expect(g.saveState().state.lockResets).toBe(LOCK_RESET_LIMIT);
  g.apply(Input.HardDrop, 1000);
  expect(g.stats.pieces).toBe(1);
  expect(g.dealt).toBe(2);
  expect(g.saveState().state.lockResets).toBe(0);
  expect(g.saveState().state.groundedAt).toBeNull();

  for (let i = 0; i < 3; i++) g.apply(Input.RotateCw, 1010 + i);
  expect(g.saveState().state.groundedAt).toBeNull();
  expect(g.saveState().state.lockResets).toBe(0);
  g.apply(Input.SoftDropDown, 1100);
  g.apply(Input.SoftDropUp, 1100);
  expect(g.saveState().state.groundedAt).toBe(1100);
  tap(g, "left", 1110);
  tap(g, "right", 1120);
  expect(g.saveState().state.lockResets).toBe(2);
  g.apply(Input.Hold, 1130);
  expect(g.holdUsed).toBe(true);
  expect(g.saveState().state.lockResets).toBe(0);
});

test("Zen undo restores the reset budget and rebases the lock and grounded timers", () => {
  const g = practice();
  ground(g);
  moveBudget(g, 7, 100);
  expect(g.saveState().state.lockResets).toBe(7);
  g.setZen(true);
  g.tick(2000);
  expect(g.stats.pieces).toBe(1);
  expect(g.undo(10_000)).toBe(true);
  const restored = g.saveState().state;
  expect(restored.lockResets).toBe(7);
  expect(restored.lockElapsed).toBe(0);
  expect(restored.groundedAt).toBe(9_840);
  g.tick(10_999);
  expect(g.stats.pieces).toBe(0);
  g.tick(11_000);
  expect(g.stats.pieces).toBe(1);
});

test("pausing excludes the paused interval from the grounded lifetime", () => {
  const g = practice();
  ground(g);
  g.tick(500);
  expect(g.saveState().state.groundedAt).toBe(0);
  g.setPaused(true, 500);
  g.setPaused(false, 20_000);
  expect(g.saveState().state.groundedAt).toBe(19_500);
  g.tick(20_499);
  expect(g.stats.pieces).toBe(0);
  g.tick(20_500);
  expect(g.stats.pieces).toBe(1);
});

test("different frame chunking produces identical bounded-lock outcomes", () => {
  const events: [number, InputId][] = [
    [10, Input.RotateCw],
    [600, Input.RotateCw],
    [700, Input.LeftDown],
    [700, Input.LeftUp],
    [800, Input.RightDown],
    [800, Input.RightUp],
    [5_000, Input.HardDrop],
  ];
  const run = (chunk: number) => {
    const g = practice();
    kickFixture(g);
    let now = 0;
    for (const [at, input] of events) {
      for (let t = now + chunk; t < at; t += chunk) g.tick(t);
      g.apply(input, at);
      now = at;
    }
    g.tick(20_000);
    return g.saveState();
  };
  expect(run(1)).toEqual(run(25));
});

test("league applies the same per-piece reset budget and grounded cap", () => {
  const g = league();
  Object.assign(g, { piece: Piece.O, rot: 0, x: 4, y: 38 });
  for (let i = 0; i < 20; i++) g.apply(Input.RotateCw, i * 50);
  const state = g.saveState().state;
  expect(state.lockResets).toBe(LOCK_RESET_LIMIT);
  g.tick(5_000);
  expect(g.stats.pieces).toBeGreaterThan(0);
});
