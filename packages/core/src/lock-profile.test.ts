import { expect, test } from "bun:test";
import { DEFAULT_HANDLING, FRAME_MS, Game, Input, LEAGUE_LOCK, Piece } from "./index";

function league() {
  const game = new Game(1, 500, 5, DEFAULT_HANDLING, 0, null, LEAGUE_LOCK);
  game.tick(0);
  return game;
}

test("pending frame boundary remains restorable when phase division rounds up", () => {
  const g = new Game(108, 500, 5, DEFAULT_HANDLING, 0, null, LEAGUE_LOCK);
  g.tick(0);
  g.apply(Input.LeftDown, 81 * FRAME_MS);
  g.tick(1650);
  const state = g.saveState();
  expect(state.state.lastNow).toBe(1650);
  expect(state.state.leagueFrame).toBe(99);
  expect(state.state.leaguePhase).toBeLessThan(99);
  expect(g.nextStepAt).toBe(99 * FRAME_MS);
  const restored = Game.fromState(JSON.parse(JSON.stringify(state)), null);
  const corrupt = JSON.parse(JSON.stringify(state));
  corrupt.state.leaguePhase = 99;
  expect(() => Game.fromState(corrupt, null)).toThrow();
  for (const game of [g, restored]) {
    game.tick(99 * FRAME_MS);
    expect(game.saveState().state.leagueFrame).toBe(100);
    expect(game.saveState().state.leaguePhase).toBe(99);
    game.tick(100 * FRAME_MS);
  }
  expect(restored.saveState()).toEqual(g.saveState());
});

test("nonzero fractional resets survive exactly 30 frames, including JSON continuation", () => {
  for (const input of [Input.HardDrop, Input.LeftUp]) {
    const g = league();
    Object.assign(g, { piece: Piece.O, x: 4, y: 38 });
    g.apply(Input.RotateCw, 2.2 * FRAME_MS);
    const restored = Game.fromState(JSON.parse(JSON.stringify(g.saveState())), null);
    for (const game of [g, restored]) {
      game.apply(input, 32.2 * FRAME_MS);
      expect(game.stats.pieces).toBe(input === Input.HardDrop ? 1 : 0);
      if (input === Input.LeftUp) {
        expect(game.saveState().state.leagueLockFrames).toBe(30);
        const atThreshold = Game.fromState(JSON.parse(JSON.stringify(game.saveState())), null);
        game.apply(Input.LeftUp, 32.45 * FRAME_MS);
        atThreshold.apply(Input.LeftUp, 32.45 * FRAME_MS);
        expect(game.stats.pieces).toBe(1);
        expect(atThreshold.saveState()).toEqual(game.saveState());
      }
    }
    expect(restored.saveState()).toEqual(g.saveState());
  }
});

test("strict lock still detects positive time beyond the rounding neighborhood", () => {
  const g = league();
  Object.assign(g, { piece: Piece.O, x: 4, y: 38 });
  g.apply(Input.RotateCw, 2.2 * FRAME_MS);
  g.apply(Input.LeftUp, (32.2 + 1e-10) * FRAME_MS);
  expect(g.stats.pieces).toBe(1);
});

test("league leaves pre-contact airborne actions unbudgeted and depth renewal only resets rotation excess", () => {
  const game = league();
  game.apply(Input.RotateCw, 0);
  game.apply(Input.LeftDown, 0);
  game.apply(Input.LeftUp, 0);
  expect(game.saveState().state.lockResets).toBe(0);
  expect(game.saveState().state.rotationResets).toBe(1);
  game.x = 0;
  game.piece = Piece.O;
  game.apply(Input.LeftDown, 0);
  expect(game.saveState().state.lockResets).toBe(0);
  game.apply(Input.LeftUp, 0);
  game.tick(30 * FRAME_MS);
  expect(game.saveState().state.lockResets).toBe(0);
  expect(game.saveState().state.rotationResets).toBe(0);
  expect(game.saveState().state.lowestY).toBe(19);
});

test("league locks after 30 frames, practice retains a full second", () => {
  for (const game of [league(), new Game(1)]) {
    game.tick(0);
    Object.assign(game, { piece: Piece.O, x: 4, y: 38 });
    game.tick(30 * FRAME_MS);
    expect(game.stats.pieces).toBe(0);
    game.tick(31 * FRAME_MS);
    expect(game.stats.pieces).toBe(game.saveState().config.lockProfile === LEAGUE_LOCK ? 1 : 0);
    game.tick(1000);
    expect(game.stats.pieces).toBe(1);
  }
});

test("the sixteenth successful action keeps the fifteenth reset timer instead of renewing it", () => {
  const game = league();
  Object.assign(game, { piece: Piece.O, x: 4, y: 38 });
  for (let i = 0; i < 14; i++) game.apply(Input.RotateCw, i);
  game.tick(20);
  expect(game.stats.pieces).toBe(0);
  const resumed = Game.fromState(JSON.parse(JSON.stringify(game.saveState())), null);
  for (const g of [game, resumed]) {
    g.apply(Input.RotateCw, 21);
    expect(g.saveState().state.lockResets).toBe(15);
    g.tick(21);
    expect(g.stats.pieces).toBe(0);
    g.apply(Input.Rotate180, 22);
    expect(g.rot).toBe(1);
    expect(g.saveState().state.lockResets).toBe(15);
    expect(g.stats.pieces).toBe(0);
    g.tick(40 * FRAME_MS);
    expect(g.stats.pieces).toBe(1);
  }
  expect(resumed.saveState()).toEqual(game.saveState());
});

test("rotation excess accelerates falling; new historical depth renews counters", () => {
  const g = league();
  for (let i = 0; i < 31; i++) g.apply(Input.RotateCw, 0);
  expect(g.saveState().state.rotationResets).toBe(31);
  expect(g.nextStepAt).toBeLessThan(500);
  g.tick(g.nextStepAt);
  expect(g.saveState().state.rotationResets).toBe(0);
});

test("30 blocked frames survive and the next quarter-frame checkpoint locks before input", () => {
  const g = league();
  Object.assign(g, { piece: Piece.O, x: 4, y: 38 });
  for (let frame = 1; frame <= 30; frame++) g.tick(frame * FRAME_MS);
  expect(g.stats.pieces).toBe(0);
  expect(g.saveState().state.leagueLockFrames).toBe(30);
  g.apply(Input.Rotate180, 30.25 * FRAME_MS);
  expect(g.stats.pieces).toBe(1);
  expect(g.lastClear?.atMs).toBe(30.25 * FRAME_MS);
  expect(g.rot).toBe(2);
  expect(g.saveState().state.leagueLockFrames).toBe(0);
  expect(g.saveState().state.fallAcc).toBe(0);
  g.tick(31 * FRAME_MS);
  expect(g.saveState().state.fallAcc).toBeCloseTo(0.75 * FRAME_MS, 10);
});

test("inputs before, at, and after the frame lock checkpoint target the correct piece", () => {
  for (const frame of [30.75, 31, 31.25]) {
    const g = league();
    Object.assign(g, { piece: Piece.O, x: 4, y: 38 });
    g.apply(Input.Rotate180, frame * FRAME_MS);
    expect(g.stats.pieces).toBe(1);
    expect(g.rot).toBe(2);
    expect(g.lastClear?.atMs).toBe(Math.min(frame, 31) * FRAME_MS);
  }
  const g = league();
  Object.assign(g, { piece: Piece.O, x: 4, y: 38 });
  g.apply(Input.Rotate180, 30 * FRAME_MS);
  expect(g.stats.pieces).toBe(0);
  expect(g.rot).toBe(2);
  expect(g.saveState().state.leagueLockFrames).toBe(0);
});

test("fifteenth reset clears the timer, sixteenth preserves it, 180 counts once", () => {
  const g = league();
  Object.assign(g, { piece: Piece.O, x: 4, y: 38 });
  for (let i = 0; i < 13; i++) g.apply(Input.Rotate180, 0);
  g.apply(Input.Rotate180, 4 * FRAME_MS);
  expect(g.saveState().state.lockResets).toBe(14);
  expect(g.saveState().state.rotationResets).toBe(14);
  expect(g.saveState().state.leagueLockFrames).toBe(0);
  g.apply(Input.Rotate180, 4.25 * FRAME_MS);
  expect(g.saveState().state.lockResets).toBe(15);
  expect(g.saveState().state.leagueLockFrames).toBe(0);
  g.apply(Input.Rotate180, 4.5 * FRAME_MS);
  expect(g.saveState().state.lockResets).toBe(15);
  expect(g.saveState().state.leagueLockFrames).toBeCloseTo(0.25, 10);
  g.tick(4.5 * FRAME_MS);
  expect(g.stats.pieces).toBe(0);
  g.tick(40 * FRAME_MS);
  expect(g.stats.pieces).toBe(1);
});

test("fractional depth renewal preserves blocked time and uses the old historical marker", () => {
  const g = league();
  const state = g.saveState();
  Object.assign(state.state, { lockResets: 14, rotationResets: 14, leagueLockFrames: 12, lowestY: 18 });
  g.restoreState(state, null);
  g.apply(Input.LeftUp, FRAME_MS / 4);
  expect(g.y).toBe(18);
  expect(g.saveState().state.lowestY).toBe(19);
  expect(g.saveState().state.lockResets).toBe(14);
  expect(g.saveState().state.leagueLockFrames).toBe(12);
  g.apply(Input.Rotate180, FRAME_MS / 4);
  g.apply(Input.LeftUp, FRAME_MS / 2);
  // The piece has not touched ground yet, so this rotation stays unbudgeted.
  expect(g.saveState().state.lockResets).toBe(14);
});

test("excess rotation adds distance once per Fall, including quarter frames and depth renewal", () => {
  for (const rotations of [30, 31, 32, 63]) {
    for (const duration of [0.25, 1]) {
      const g = league();
      for (let i = 0; i < rotations; i++) g.apply(Input.Rotate180, 0);
      g.apply(Input.LeftUp, duration * FRAME_MS);
      const state = g.saveState().state;
      const distance = g.y - 18 + state.fallAcc / 500;
      expect(distance).toBeCloseTo(duration / 30 + 0.5 * duration * (rotations - 30), 12);
      expect(state.rotationResets).toBe(0);
    }
  }
});

test("a failed chunk charges the whole Fall duration once, including a partial landing", () => {
  for (const duration of [0.25, 1]) {
    const g = new Game(1, duration * FRAME_MS / 2, 5, DEFAULT_HANDLING, 0, null, LEAGUE_LOCK);
    g.tick(0);
    Object.assign(g, { piece: Piece.O, x: 4, y: 37 });
    g.apply(Input.LeftUp, duration * FRAME_MS);
    expect(g.y).toBe(38);
    expect(g.saveState().state.leagueLockFrames).toBe(duration);
  }
});

test("fractional blocked timer survives JSON restoration through the strict threshold", () => {
  const a = league();
  Object.assign(a, { piece: Piece.O, x: 4, y: 38 });
  a.apply(Input.LeftUp, 29.25 * FRAME_MS);
  expect(a.saveState().state.leagueLockFrames).toBe(29.25);
  const b = Game.fromState(JSON.parse(JSON.stringify(a.saveState())), null);
  for (const g of [a, b]) {
    g.tick(30 * FRAME_MS);
    expect(g.stats.pieces).toBe(0);
    expect(g.saveState().state.leagueLockFrames).toBe(30);
    g.apply(Input.Rotate180, 30.25 * FRAME_MS);
    g.tick(32 * FRAME_MS);
  }
  expect(b.saveState()).toEqual(a.saveState());
});

test("pre-contact rotation excess saturates without spending the lock budget", () => {
  const g = league();
  for (let i = 0; i < 80; i++) g.apply(Input.Rotate180, 0);
  expect(g.saveState().state.lockResets).toBe(0);
  expect(g.saveState().state.rotationResets).toBe(63);
  expect(g.stats.pieces).toBe(0);
});

test("failed grounded shifts do not reset the timer", () => {
  const g = league();
  Object.assign(g, { piece: Piece.O, x: 0, y: 38 });
  g.apply(Input.LeftDown, 10 * FRAME_MS);
  expect(g.saveState().state.lockResets).toBe(0);
  expect(g.saveState().state.leagueLockFrames).toBe(10);
});

test("fractional JSON continuation and coarse ticks match canonical checkpoints", () => {
  const a = league();
  a.apply(Input.Rotate180, 0.25 * FRAME_MS);
  const b = Game.fromState(JSON.parse(JSON.stringify(a.saveState())), null);
  const c = Game.fromState(JSON.parse(JSON.stringify(a.saveState())), null);
  for (let frame = 1; frame <= 80; frame++) b.tick(frame * FRAME_MS);
  for (let frame = 0.5; frame <= 80; frame += 0.5) c.tick(frame * FRAME_MS);
  a.tick(80 * FRAME_MS);
  for (const g of [a, b, c]) {
    g.apply(Input.Hold, 80.25 * FRAME_MS);
    expect(g.saveState().state.leagueLockFrames).toBe(0);
    expect(g.saveState().state.fallAcc).toBe(0);
    g.tick(81 * FRAME_MS);
    expect(g.saveState().state.fallAcc).toBeCloseTo(0.75 * FRAME_MS, 10);
  }
  expect(b.saveState()).toEqual(a.saveState());
  expect(c.saveState()).toEqual(a.saveState());
});

test("profile and counter corruption is rejected before restoring", () => {
  const g = league();
  for (const patch of [{ lockResets: 16 }, { lockResets: -1 }, { rotationResets: -1 }, { lowestY: NaN },
    { leagueFrame: 0 }, { leaguePhase: 1 }, { leagueOriginMs: 20 }, { leagueLockFrames: 30.25 }]) {
    const state = g.saveState();
    Object.assign(state.state, patch);
    expect(() => g.restoreState(state, null)).toThrow();
  }
  const state = g.saveState();
  Object.assign(state.config, { lockProfile: "unknown" });
  expect(() => g.restoreState(state, null)).toThrow();
});

test("failed rotations preserve the lock timer and counters", () => {
  const g = league();
  Object.assign(g, { piece: Piece.T, x: 3, y: 20 });
  g.board.fill(8);
  // Leave only the spawn-orientation T cells vacant.
  for (const [x, y] of [[4, 20], [3, 21], [4, 21], [5, 21]]) g.board[y * 10 + x] = 0;
  g.tick(2 * FRAME_MS);
  const before = g.saveState().state;
  g.apply(Input.Rotate180, 2 * FRAME_MS);
  const after = g.saveState().state;
  expect(g.rot).toBe(0);
  expect(after.lockResets).toBe(before.lockResets);
  expect(after.rotationResets).toBe(before.rotationResets);
  expect(after.leagueLockFrames).toBe(2);
});

test("rotation acceleration is additive to configured soft drop", () => {
  const g = league();
  const state = g.saveState();
  Object.assign(state.state, { rotationResets: 32, lockResets: 15, softHeld: true, softAt: 0 });
  g.restoreState(state, null);
  g.apply(Input.LeftUp, FRAME_MS / 4);
  const expected = FRAME_MS / 4 / 500 + 0.25 / DEFAULT_HANDLING.sdarr + 0.25;
  expect(g.y - 18 + g.saveState().state.fallAcc / 500).toBeCloseTo(expected, 12);
});

test("fractional league lock deadlines make progress and terminal snapshots restore", () => {
  for (let seed = 0; seed < 100; seed++) {
    const g = new Game(seed, 500, 5, { ...DEFAULT_HANDLING, sdarr: 0 }, 0, null, LEAGUE_LOCK);
    g.tick(0);
    g.apply(Input.SoftDropDown, seed * 0.137);
    g.tick(60000);
    expect(g.topOut).toBe(true);
    expect(Game.fromState(g.saveState(), null).saveState()).toEqual(g.saveState());
  }
});

test("league Zen checkpoints restore lock counters and historical depth", () => {
  const g = league();
  g.apply(Input.RotateCw, 0);
  g.apply(Input.RotateCw, 0);
  g.setZen(true);
  const before = g.saveState();
  g.apply(Input.HardDrop, 10);
  expect(g.undo(20)).toBe(true);
  const after = g.saveState();
  expect(after.config.lockProfile).toBe(LEAGUE_LOCK);
  expect(after.state.lockResets).toBe(before.state.lockResets);
  expect(after.state.rotationResets).toBe(before.state.rotationResets);
  expect(after.state.lowestY).toBe(before.state.lowestY);
});
