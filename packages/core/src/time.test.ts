import { expect, test } from "bun:test";
import { Game, Input } from "./game";
import { DEFAULT_HANDLING } from "./handling";
import { SPAWN_Y } from "./pieces";

test("all external clock entry points reject invalid and backward timestamps before mutation", () => {
  for (const mode of ["active", "paused", "topOut", "starting", "zen"] as const) {
    const g = new Game(108, 500, 5, DEFAULT_HANDLING, mode === "starting" ? 250 : 0);
    g.tick(0);
    if (mode === "zen") { g.setZen(true); g.apply(Input.HardDrop, 0); }
    if (mode === "paused") g.setPaused(true, 0);
    if (mode === "topOut") g.topOut = true;
    g.tick(123);
    const before = g.saveState();
    const undoCount = g.undoCount;
    for (const now of [NaN, Infinity, -Infinity, -1, 122]) {
      for (const action of [
        () => g.tick(now), () => g.apply(Input.HardDrop, now),
        () => g.setPaused(!g.paused, now), () => g.setPaused(g.paused, now), () => g.undo(now),
      ]) {
        expect(action).toThrow(RangeError);
        expect(g.saveState()).toEqual(before);
        expect(g.undoCount).toBe(undoCount);
      }
    }
    expect(() => g.tick(123)).not.toThrow();
    expect(() => g.apply(Input.RotateCw, 123)).not.toThrow();
    expect(() => g.setPaused(g.paused, 123)).not.toThrow();
    expect(() => g.undo(123)).not.toThrow();
  }
});

test("paused RAF observations constrain undo/resume without consuming paused time", () => {
  const g = new Game(108);
  g.tick(0);
  g.setZen(true);
  g.apply(Input.HardDrop, 0);
  g.setPaused(true, 100);
  g.tick(10000);
  expect(() => g.undo(9999)).toThrow();
  expect(g.undo(10000)).toBe(true);
  g.tick(20000);
  g.setHandling({ ...DEFAULT_HANDLING, arr: 0 });
  g.setZen(false);
  g.setZen(true);
  expect(g.y).toBe(SPAWN_Y);
  expect(g.stats.pieces).toBe(0);
  g.setPaused(false, 20000);
  g.tick(20499);
  expect(g.y).toBe(SPAWN_Y);
  g.tick(20500);
  expect(g.y).toBe(SPAWN_Y + 1);
});

test("ignored inputs and no-op pause/undo calls still observe valid external timestamps", () => {
  const g = new Game(108);
  g.setPaused(true, 0);
  g.apply(Input.LeftDown, 100);
  expect(() => g.tick(99)).toThrow();
  g.setPaused(true, 200);
  expect(() => g.undo(199)).toThrow();
  expect(g.undo(300)).toBe(false);
  expect(() => g.setPaused(false, 299)).toThrow();
  g.setPaused(false, 300);
});

test("setters process deadlines observed by no-op undo and pause calls before residual time", () => {
  for (const observe of ["undo", "pause"] as const) {
    for (const setter of ["zen", "handling"] as const) {
      for (const mode of ["repeats", "gravity", "lock", "overflow", "starting", "paused"] as const) {
        const ledgers: number[][] = [[], []];
        const controllers = ledgers.map(ledger => (p: { result: { atMs: number } }) => {
          ledger.push(p.result.atMs);
          return mode === "overflow" ? [0] : [];
        });
        const games = controllers.map(controller => new Game(108, 500, 5,
          { ...DEFAULT_HANDLING, sdarr: 0 }, mode === "starting" ? 250 : 0, controller));
        for (const g of games) {
          g.tick(0);
          if (mode === "repeats") g.apply(Input.LeftDown, 0);
          if (mode === "lock" || mode === "overflow") g.apply(Input.SoftDropDown, 0);
          if (mode === "overflow") g.board[0] = 8;
          if (mode === "paused") g.setPaused(true, 0);
        }
        const [reference, observed] = games;
        reference.tick(2100);
        if (observe === "undo") expect(observed.undo(2100)).toBe(false);
        else observed.setPaused(mode === "paused", 2100);
        for (const g of games) {
          if (setter === "zen") g.setZen(true);
          else g.setHandling({ ...DEFAULT_HANDLING, arr: 0 });
        }
        expect(observed.saveState()).toEqual(reference.saveState());
        expect(ledgers[1]).toEqual(ledgers[0]);
        if (mode === "lock") expect(ledgers[1]).toEqual([1000, 2000]);
        if (mode === "overflow") expect(ledgers[1]).toEqual([1000]);
        const snapshot = JSON.parse(JSON.stringify(observed.saveState()));
        const restored = Game.fromState(snapshot, controllers[1]);
        expect(restored.saveState()).toEqual(snapshot);
        expect(restored.drainEvents()).toEqual(reference.drainEvents());
        expect(observed.drainEvents()).toEqual(snapshot.events);
      }
    }
  }
});

test("a RAF timestamp older than a performance.now boundary is rejected, including pause and undo", () => {
  for (const boundary of ["restart", "input", "pause", "undo"] as const) {
    const g = new Game(108);
    g.tick(100);
    if (boundary === "restart") g.tick(116.9);
    if (boundary === "input") g.apply(Input.RotateCw, 116.9);
    if (boundary === "pause") g.setPaused(true, 116.9);
    if (boundary === "undo") {
      g.setZen(true);
      g.apply(Input.HardDrop, 110);
      g.undo(116.9);
    }
    const before = g.saveState();
    // A frame timestamp is sampled before its callback and can precede the boundary above.
    expect(() => g.tick(116.6)).toThrow(RangeError);
    expect(g.saveState()).toEqual(before);
    expect(() => g.tick(116.9)).not.toThrow();
  }
});
