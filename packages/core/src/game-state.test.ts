import { expect, test } from "bun:test";
import { Game, Input } from "./game";
import { GAME_STATE_VERSION, type GameState } from "./game-state";
import { DEFAULT_HANDLING } from "./handling";
import { Piece, SPAWN_Y } from "./pieces";
import { Rng } from "./rng";

function json(g: Game): GameState {
  return JSON.parse(JSON.stringify(g.saveState()));
}

// The reference is never restored. Only the other branch crosses JSON boundaries.
for (const arr of [0, 0.6, 2]) {
  for (const sdarr of [0, 0.6, 2]) {
    test(`repeated JSON continuation during DAS/ARR=${arr}, soft drop=${sdarr} and timed locks`, () => {
      const handling = { das: 4.8, arr, sddas: 4.8, sdarr };
      const reference = new Game(-108, 500, 8, handling);
      let restored = new Game(-108, 500, 8, handling);
      const inputs = new Map([
        [0, Input.LeftDown], [17, Input.SoftDropDown], [1190, Input.RightDown],
        [1320, Input.RightUp], [1400, Input.LeftUp], [1500, Input.RotateCw],
        [1600, Input.HardDrop], [1750, Input.Hold], [2400, Input.SoftDropUp],
      ]);
      const times = [...new Set([...Array.from({ length: 450 }, (_, i) => i * 7), ...inputs.keys()])].sort((a, b) => a - b);
      for (const time of times) {
        const input = inputs.get(time);
        for (const g of [reference, restored]) {
          if (input === undefined) g.tick(time);
          else g.apply(input, time);
        }
        expect(restored.saveState()).toEqual(reference.saveState());
        const before = json(restored);
        restored = Game.fromState(before, null);
        expect(restored.saveState()).toEqual(before);
        if (time % 7 === 0) expect(restored.drainEvents()).toEqual(reference.drainEvents());
      }
      expect(restored.stats.pieces).toBeGreaterThan(0);
    });
  }
}

test("render-only observed time differs from simulation time and survives restoration", () => {
  const g = new Game(108);
  g.tick(0);
  g.tick(123);
  const s = json(g);
  expect(s.state.lastNow).toBe(0);
  expect(s.state.observedNow).toBe(123);
  expect(s.state.moveAt).toBeNull();
  const restored = Game.fromState(s, null);
  expect(() => restored.tick(122)).toThrow(RangeError);
  restored.tick(500);
  expect(restored.y).toBe(SPAWN_Y + 1);
});

test("partial gravity and lock accumulators survive repeated checkpoints", () => {
  const reference = new Game(108, 500, 5, { ...DEFAULT_HANDLING, sdarr: 0 });
  let restored = Game.fromState(json(reference), null);
  for (const g of [reference, restored]) {
    g.tick(0);
    g.apply(Input.RotateCw, 123);
  }
  expect(json(restored).state.fallAcc).toBe(123);
  restored = Game.fromState(json(restored), null);
  for (const g of [reference, restored]) {
    g.apply(Input.SoftDropDown, 200);
    g.apply(Input.SoftDropUp, 777);
  }
  expect(json(restored).state.lockElapsed).toBe(577);
  restored = Game.fromState(json(restored), null);
  for (const g of [reference, restored]) g.tick(1200);
  expect(restored.saveState()).toEqual(reference.saveState());
  expect(restored.lastClear?.atMs).toBe(1200);
});

test("pending lock/restored events, sequence and bag survive many shuffles without replay", () => {
  const reference = new Game(-0x80000000, 500, 14);
  let restored = new Game(-0x80000000, 500, 14);
  for (let i = 0; i < 40; i++) {
    for (const g of [reference, restored]) {
      g.board.fill(0);
      g.apply(Input.HardDrop, i);
    }
    restored = Game.fromState(json(restored), null);
    expect(restored.saveState()).toEqual(reference.saveState());
  }
  expect(restored.drainEvents()).toEqual(reference.drainEvents());
  expect(restored.lastClear?.sequence).toBe(40);
  restored.setZen(true);
  restored.board.fill(0);
  restored.apply(Input.HardDrop, 40);
  restored.undo(41);
  const before = json(restored);
  const copy = Game.fromState(before, null);
  expect(copy.drainEvents()).toEqual([{ type: "restored", sequence: 42, atMs: 41 }]);
  expect(copy.lastClear).toEqual(before.lastResult);
});

test("opening preview, pause, top-out and unstarted clocks are JSON-safe", () => {
  const g = new Game(108, 700, 2, { ...DEFAULT_HANDLING, das: 3.5 }, 250);
  let copy = Game.fromState(json(g), null);
  expect(copy.saveState()).toEqual(g.saveState());
  for (const game of [g, copy]) {
    game.tick(0);
    game.setPaused(true, 100);
    game.tick(9000);
  }
  copy = Game.fromState(json(copy), null);
  expect(copy.starting).toBe(true);
  expect(copy.paused).toBe(true);
  for (const game of [g, copy]) {
    game.setPaused(false, 9000);
    game.tick(9150);
    game.tick(9850);
  }
  expect(copy.saveState()).toEqual(g.saveState());
  expect(copy.y).toBe(SPAWN_Y + 1);
  copy.topOut = true;
  expect(Game.fromState(json(copy), null).saveState()).toEqual(copy.saveState());
});

test("snapshot and restoration never share mutable arrays, configuration or result data", () => {
  const g = new Game(108);
  g.apply(Input.HardDrop, 0);
  const snapshot = g.saveState();
  const pristine = json(g);
  const copy = Game.fromState(snapshot, null);
  expect(snapshot.lastResult).not.toBe(g.lastClear);
  expect(snapshot.lastResult?.stats).not.toBe(g.stats);
  expect(copy.lastClear).not.toBe(snapshot.lastResult);
  expect(copy.lastClear?.stats).not.toBe(snapshot.lastResult?.stats);
  snapshot.board.fill(8);
  snapshot.previews.fill(1);
  snapshot.bag.pieces.fill(1);
  snapshot.config.handling.das = 0;
  snapshot.events.length = 0;
  snapshot.state.x = 0;
  expect(g.saveState()).toEqual(pristine);
  expect(copy.saveState()).toEqual(pristine);
  const mutable = json(g);
  copy.restoreState(mutable, null);
  (mutable.lastResult as { rows: number[] }).rows = [1];
  (mutable.lastResult!.stats as { pieces: number }).pieces = 500;
  (mutable.events[0] as { sequence: number }).sequence = 100;
  expect(copy.saveState()).toEqual(pristine);
  copy.board.fill(0);
  expect(g.saveState()).toEqual(pristine);
});

test("exact restore clears Zen history without serializing or copying its 1000 checkpoints", () => {
  const g = new Game(108);
  g.setZen(true);
  for (let i = 0; i < 1000; i++) {
    g.board.fill(0);
    g.apply(Input.HardDrop, 0);
    g.drainEvents();
  }
  expect(g.undoCount).toBe(1000);
  const snapshot = json(g);
  expect(JSON.stringify(snapshot).length).toBeLessThan(2500);
  g.restoreState(snapshot, null);
  expect(g.zen).toBe(true);
  expect(g.undoCount).toBe(0);
  expect(g.undo(0)).toBe(false);
  const baseline = g.board.slice();
  g.apply(Input.HardDrop, 0);
  expect(g.undo(0)).toBe(true);
  expect(g.board).toEqual(baseline);
});

test("malformed state is rejected before mutating a target Game", () => {
  const target = new Game(19);
  const before = target.saveState();
  const corruptions: ((s: GameState) => void)[] = [
    s => { s.version = 99 as typeof GAME_STATE_VERSION; },
    s => { s.rulesVersion = "other" as GameState["rulesVersion"]; },
    s => { s.board.pop(); }, s => { s.board[1] = 9; }, s => { s.board[1] = NaN; },
    s => { s.previews = []; }, s => { s.previews[0] = 0; },
    s => { s.bag.index = 8; }, s => { s.bag.rng = 0x80000000; },
    s => { s.bag.pieces[0] = s.bag.pieces[1]; },
    s => { s.config.gravityMs = 0; }, s => { s.config.handling.arr = Infinity; },
    s => { s.state.piece = 0 as typeof Piece.I; }, s => { s.state.rot = 4; },
    s => { s.state.x = 9; }, s => { s.state.y = 40; },
    s => { s.state.fallAcc = -1; }, s => { s.state.fallAcc = 501; },
    s => { s.state.lockElapsed = 1001; }, s => { s.state.readyMs = NaN; },
    s => { s.state.lastNow = 1; s.state.observedNow = 0; },
    s => { s.state.moveAt = Infinity; }, s => { s.state.direction = -1; },
    s => { s.state.softHeld = true; }, s => { s.state.sequence = 0.5; },
    s => { s.lastResult = undefined as unknown as null; },
    s => { s.events = [{ type: "restored", sequence: 1, atMs: 0 }]; },
  ];
  for (const corrupt of corruptions) {
    const snapshot = json(target);
    corrupt(snapshot);
    expect(() => target.restoreState(snapshot, null)).toThrow();
    expect(target.saveState()).toEqual(before);
  }
  for (const value of [null, [], {}, 1, "snapshot"]) expect(() => Game.fromState(value, null)).toThrow();
  const locked = new Game(108);
  locked.apply(Input.HardDrop, 0);
  for (const corrupt of [
    (s: GameState) => { (s.lastResult!.stats as { attack: number }).attack = Infinity; },
    (s: GameState) => { (s.lastResult as { rows: number[] }).rows = [39, 38]; },
    (s: GameState) => { (s.lastResult as { attacks: { kind: string; lines: number }[] }).attacks = [{ kind: "normal", lines: -1 }]; },
    (s: GameState) => { s.events.push(s.events[0]); },
  ]) {
    const snapshot = json(locked);
    corrupt(snapshot);
    expect(() => Game.fromState(snapshot, null)).toThrow();
  }
});

test("constructor defaults and signed seeds remain unchanged; invalid numeric config is rejected", () => {
  const defaults = new Game(-1).saveState();
  expect(defaults.config).toEqual({ width: 10, gravityMs: 500, handling: DEFAULT_HANDLING, lockProfile: "42tris-practice-lock-v1" });
  expect(defaults.previews).toHaveLength(5);
  expect(defaults.state.readyMs).toBe(0);
  expect(new Game(-1).saveState()).toEqual(new Game(0xffffffff).saveState());
  for (const gravity of [0, -1, NaN, Infinity]) expect(() => new Game(1, gravity)).toThrow();
  for (const count of [0, -1, 1.5, Infinity]) expect(() => new Game(1, 500, count)).toThrow();
  expect(() => new Game(1, 500, 5, DEFAULT_HANDLING, NaN)).toThrow();
});

test("preview-count mismatch leaves a Zen target and its undo history unchanged", () => {
  const target = new Game(108);
  target.setZen(true);
  const baseline = target.board.slice();
  target.apply(Input.HardDrop, 0);
  const before = target.saveState();
  const history = target.undoCount;
  const incompatible = new Game(19, 500, 2).saveState();
  expect(() => target.restoreState(incompatible, null)).toThrow("Preview count");
  expect(target.saveState()).toEqual(before);
  expect(target.undoCount).toBe(history);
  expect(target.undo(1)).toBe(true);
  expect(target.board).toEqual(baseline);
});

test("fractional mixed inputs keep independent continuations equal across thousands of roundtrips", () => {
  const handling = { das: 3.1, arr: 0.7, sddas: 1.2, sdarr: 0.3 };
  const reference = new Game(108, 491.3, 5, handling);
  let restored = new Game(108, 491.3, 5, handling);
  const inputs = new Rng(7283);
  for (let i = 0; i < 2000; i++) {
    const at = i * 13.37;
    const input = inputs.nextBelow(11) as Parameters<Game["apply"]>[0];
    for (const g of [reference, restored]) {
      if (input === Input.HardDrop) g.board.fill(0);
      g.apply(input, at);
      g.tick(at + 0.123);
    }
    restored = Game.fromState(json(restored), null);
    expect(restored.saveState()).toEqual(reference.saveState());
    expect(restored.drainEvents()).toEqual(reference.drainEvents());
  }
});

test("generated attacks, combo and Surge charge continue through JSON without resetting stats", () => {
  const reference = new Game(108);
  let restored = new Game(108);
  for (let i = 0; i < 6; i++) {
    for (const g of [reference, restored]) {
      g.board.fill(0);
      Object.assign(g, { piece: Piece.I, rot: 1, x: 2, y: SPAWN_Y });
      for (let y = 36; y < 40; y++) {
        g.board.fill(Piece.L, y * 10, (y + 1) * 10);
        g.board[y * 10 + 4] = 0;
      }
      g.apply(Input.HardDrop, i);
    }
    restored = Game.fromState(json(restored), null);
    expect(restored.saveState()).toEqual(reference.saveState());
  }
  expect(restored.stats.surge).toBe(5);
  for (const g of [reference, restored]) {
    g.board.fill(0);
    Object.assign(g, { piece: Piece.O, rot: 0, x: 4, y: SPAWN_Y });
    g.board.fill(Piece.L, 390);
    g.board[394] = g.board[395] = 0;
    g.apply(Input.HardDrop, 10);
  }
  expect(restored.saveState()).toEqual(reference.saveState());
  expect(restored.lastClear?.attacks.slice(0, 3)).toEqual([
    { kind: "surge", lines: 2 }, { kind: "surge", lines: 2 }, { kind: "surge", lines: 1 },
  ]);
});

test("missing and inconsistent held-control deadlines are rejected; charged ARR=0 remains valid", () => {
  const g = new Game(108);
  g.apply(Input.LeftDown, 10);
  g.apply(Input.SoftDropDown, 20);
  const valid = json(g);
  const corruptions: ((s: GameState) => void)[] = [
    s => { s.state.moveAt = null; },
    s => { delete (s.state as Partial<GameState["state"]>).moveAt; },
    s => { delete (s.state as Partial<GameState["state"]>).softAt; },
    s => { s.state.softAt = null; },
    s => { s.state.softHeld = false; },
    s => { s.state.leftHeld = false; },
    s => { s.state.direction = 0; },
    s => { s.state.moveAt = 19; },
    s => { s.state.lastNow = -1; },
  ];
  for (const corrupt of corruptions) {
    const snapshot = JSON.parse(JSON.stringify(valid)) as GameState;
    corrupt(snapshot);
    expect(() => g.restoreState(snapshot, null)).toThrow(RangeError);
    expect(g.saveState()).toEqual(valid);
  }
  const charged = new Game(108, 500, 5, { ...DEFAULT_HANDLING, das: 0, arr: 0 });
  charged.apply(Input.LeftDown, 0);
  expect(json(charged).state.moveAt).toBeNull();
  expect(Game.fromState(json(charged), null).saveState()).toEqual(charged.saveState());
});
