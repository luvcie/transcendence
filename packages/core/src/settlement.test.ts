import { expect, test } from "bun:test";
import { COLS, ROWS } from "./board";
import { Game, Input, type PlacementSettlement, type SettlePlacement } from "./game";
import { DEFAULT_HANDLING } from "./handling";
import { GARBAGE, MINOS, Piece, SPAWN_Y, spawnX } from "./pieces";

function game(settle: SettlePlacement) {
  return new Game(108, 500, 5, { ...DEFAULT_HANDLING, sdarr: 0 }, 0, settle);
}

function quad(g: Game) {
  g.board.fill(0);
  Object.assign(g, { piece: Piece.I, rot: 1, x: 2, y: SPAWN_Y });
  for (let y = 36; y < ROWS; y++) {
    g.board.fill(Piece.L, y * COLS, (y + 1) * COLS);
    g.board[y * COLS + 4] = 0;
  }
}

test("settlement rejects reentrant operations before mutation, even when the controller catches them", () => {
  for (const operation of ["apply", "tick", "undo", "restore", "zen", "handling", "pause", "events", "snapshot"] as const) {
    for (const caught of [false, true]) {
      let calls = 0;
      let snapshot: ReturnType<Game["saveState"]>;
      const g = game(() => {
        calls++;
        const reenter = () => {
          switch (operation) {
            case "apply": return g.apply(Input.HardDrop, 9999);
            case "tick": return g.tick(9999);
            case "undo": return g.undo(9999);
            case "restore": return g.restoreState(snapshot, null);
            case "zen": return g.setZen(false);
            case "handling": return g.setHandling({ ...DEFAULT_HANDLING, arr: 0 });
            case "pause": return g.setPaused(true, 9999);
            case "events": return g.drainEvents();
            case "snapshot": return g.saveState();
          }
        };
        if (caught) expect(reenter).toThrow("during settlement");
        else reenter();
        return [4];
      });
      const reference = game(() => [4]);
      for (const target of [g, reference]) {
        target.setZen(true);
        target.tick(0);
      }
      snapshot = new Game(108).saveState();
      const before = g.saveState();
      if (caught) {
        g.apply(Input.HardDrop, 17);
        reference.apply(Input.HardDrop, 17);
        expect(g.saveState()).toEqual(reference.saveState());
        expect(g.undoCount).toBe(1);
        // Leave the first event pending and history populated during the next callback.
        g.apply(Input.HardDrop, 18);
        reference.apply(Input.HardDrop, 18);
        expect(g.saveState()).toEqual(reference.saveState());
        expect(g.undoCount).toBe(2);
        expect(g.drainEvents()).toEqual(reference.drainEvents());
      } else {
        expect(() => g.apply(Input.HardDrop, 17)).toThrow("during settlement");
        expect(g.topOut).toBe(true);
        const failed = g.saveState();
        expect(failed.board).toEqual(before.board);
        expect(failed.previews).toEqual(before.previews);
        expect(failed.bag).toEqual(before.bag);
        expect(failed.lastResult).toBeNull();
        expect(failed.state.sequence).toBe(0);
        expect(failed.state.dealt).toBe(before.state.dealt);
        expect(failed.state.observedNow).toBe(17);
        expect(failed.state.paused).toBe(false);
        expect(g.undoCount).toBe(0);
        expect(g.drainEvents()).toEqual([]);
        expect(Game.fromState(JSON.parse(JSON.stringify(failed)), () => []).saveState()).toEqual(failed);
        g.tick(20);
      }
      expect(calls).toBe(caught ? 2 : 1);
    }
  }
});

test("settlement receives frozen placement/clear/attack data before any spawn, then inserts ordered hole rows", () => {
  let calls = 0;
  let placement: PlacementSettlement | undefined;
  const g = game(p => {
    calls++;
    placement = p;
    expect(g.dealt).toBe(1);
    expect(g.piece).toBe(Piece.I);
    expect(g.stats.pieces).toBe(0);
    expect(Object.isFrozen(p)).toBe(true);
    expect(Object.isFrozen(p.result)).toBe(true);
    expect(Object.isFrozen(p.result.rows)).toBe(true);
    expect(Object.isFrozen(p.result.stats)).toBe(true);
    expect(Object.isFrozen(p.result.attacks)).toBe(true);
    expect(p.result.attacks.every(Object.isFrozen)).toBe(true);
    expect(Object.keys(p).sort()).toEqual(["result", "rot", "x", "y"]);
    return [0, 9];
  });
  quad(g);
  g.apply(Input.HardDrop, 17);
  expect(calls).toBe(1);
  expect(placement).toMatchObject({ x: 2, y: 36, rot: 1, result: {
    sequence: 1, atMs: 17, piece: Piece.I, rows: [36, 37, 38, 39], allClear: true,
    attacks: [{ kind: "normal", lines: 4 }, { kind: "allClear", lines: 5 }],
  } });
  expect([...g.board.slice(38 * COLS, 39 * COLS)]).toEqual([0, 8, 8, 8, 8, 8, 8, 8, 8, 8]);
  expect([...g.board.slice(39 * COLS)]).toEqual([8, 8, 8, 8, 8, 8, 8, 8, 8, 0]);
  expect(g.stats.attack).toBe(9);
  expect(g.stats.lines).toBe(4);
  expect(g.dealt).toBe(2);
  expect(g.drainEvents()).toEqual([placement!.result]);
});

test("every timed lock settles separately, including multiple locks inside apply's tick", () => {
  const calls: PlacementSettlement[] = [];
  const g = game(p => { calls.push(p); return [p.result.sequence]; });
  g.apply(Input.SoftDropDown, 0);
  g.apply(Input.HardDrop, 2100);
  expect(calls.map(p => [p.result.sequence, p.result.atMs])).toEqual([[1, 1000], [2, 2000], [3, 2100]]);
  expect(g.stats.pieces).toBe(3);
  expect(g.board.slice(39 * COLS).filter(cell => cell === GARBAGE)).toHaveLength(9);
  expect(g.board[39 * COLS + 3]).toBe(0);
  expect(g.drainEvents()).toEqual(calls.map(p => p.result));
});

test("garbage settlement is independent of render batching", () => {
  const play = (step: number) => {
    const calls: PlacementSettlement[] = [];
    const g = game(p => { calls.push(p); return [p.result.sequence % COLS]; });
    g.apply(Input.SoftDropDown, 0);
    for (let t = step; t < 3500; t += step) g.tick(t);
    g.tick(3500);
    return { state: g.saveState(), calls };
  };
  expect(play(7)).toEqual(play(3500));
});

test("shifted-off occupied cells cause top-out with no queue/bag consumption or spawn", () => {
  const g = game(() => [3, 7]);
  g.board[COLS + 9] = Piece.T;
  const before = g.saveState();
  g.apply(Input.HardDrop, 0);
  expect(g.topOut).toBe(true);
  expect(g.dealt).toBe(before.state.dealt);
  expect(g.previews).toEqual(new Uint8Array(before.previews));
  expect(g.saveState().bag).toEqual(before.bag);
  expect(g.y).toBeGreaterThan(SPAWN_Y);
  expect(g.stats.pieces).toBe(1);
  expect(g.drainEvents()).toHaveLength(1);
  expect(g.board[38 * COLS + 3]).toBe(0);
  expect(g.board[39 * COLS + 7]).toBe(0);
});

test("timed overflow stops the rest of a coarse tick and charged controls", () => {
  let calls = 0;
  const g = new Game(108, 500, 5, { ...DEFAULT_HANDLING, das: 0, arr: 0, sdarr: 0 }, 0,
    () => { calls++; return [4]; });
  g.board[0] = Piece.T;
  g.apply(Input.LeftDown, 0);
  g.apply(Input.SoftDropDown, 0);
  const x = g.x;
  g.tick(10000);
  expect(calls).toBe(1);
  expect(g.topOut).toBe(true);
  expect(g.x).toBe(x);
  expect(g.dealt).toBe(1);
  expect(g.lastClear?.atMs).toBe(1000);
});

test("empty shifted rows are safe, and garbage may block the next spawn", () => {
  const g = game(() => [0]);
  // After the rise this cell blocks the next spawn; it is not shifted off.
  const next = g.previews[0];
  const minos = MINOS[next][0];
  g.board[(SPAWN_Y + minos[1] + 1) * COLS + spawnX(next) + minos[0]] = Piece.L;
  g.y = 30;
  g.apply(Input.HardDrop, 0);
  expect(g.topOut).toBe(true);
  expect(g.dealt).toBe(2);
  expect(g.y).toBe(SPAWN_Y);
});

test("more than forty rows are inserted in order and overflow includes settled minos", () => {
  const g = game(() => Array.from({ length: 41 }, (_, i) => i % COLS));
  g.apply(Input.HardDrop, 0);
  expect(g.topOut).toBe(true);
  expect(g.dealt).toBe(1);
  expect(g.board[0]).toBe(8);
  expect(g.board[1]).toBe(0);
  expect(g.board[39 * COLS]).toBe(0);
});

test("callback errors and malformed holes fail closed without partial placement, stats, queue or events", () => {
  const error = new Error("controller unavailable");
  const invalid: unknown[] = [undefined, null, [-1], [10], [NaN], [Infinity], [0.5], [2, 10], new Array(1), Promise.resolve([])];
  for (const result of [error, ...invalid]) {
    let calls = 0;
    const g = game(() => { calls++; if (result === error) throw error; return result as number[]; });
    quad(g);
    const before = g.saveState();
    expect(() => g.apply(Input.HardDrop, 0)).toThrow();
    expect(g.topOut).toBe(true);
    expect(g.board).toEqual(new Uint8Array(before.board));
    expect(g.previews).toEqual(new Uint8Array(before.previews));
    expect(g.saveState().bag).toEqual(before.bag);
    expect(g.stats.pieces).toBe(0);
    expect(g.lastClear).toBeNull();
    expect(g.drainEvents()).toEqual([]);
    expect(g.saveState().state.sequence).toBe(0);
    g.tick(10000);
    g.apply(Input.HardDrop, 10000);
    expect(calls).toBe(1);
  }
});

test("a failed later settlement retains earlier completed locks and stops a multi-lock tick", () => {
  let calls = 0;
  const g = game(() => { if (++calls === 2) throw new Error("failed"); return [0]; });
  g.apply(Input.SoftDropDown, 0);
  expect(() => g.tick(5000)).toThrow("failed");
  expect(calls).toBe(2);
  expect(g.topOut).toBe(true);
  expect(g.stats.pieces).toBe(1);
  expect(g.dealt).toBe(2);
  expect(g.drainEvents().map(event => event.sequence)).toEqual([1]);
});

test("restoration requires controller reattachment and does not invoke it or replay pending attacks", () => {
  let calls = 0;
  const settle = () => { calls++; return [6]; };
  const g = game(settle);
  quad(g);
  g.apply(Input.HardDrop, 0);
  const snapshot = JSON.parse(JSON.stringify(g.saveState()));
  expect(snapshot.settlementRequired).toBe(true);
  expect(() => Game.fromState(snapshot, null)).toThrow(TypeError);
  expect(() => Game.fromState(snapshot, undefined as unknown as null)).toThrow(TypeError);
  const target = new Game(108);
  const before = target.saveState();
  expect(() => target.restoreState(snapshot, null)).toThrow(TypeError);
  expect(target.saveState()).toEqual(before);
  const restored = Game.fromState(snapshot, settle);
  expect(calls).toBe(1);
  expect(restored.drainEvents()).toEqual(g.drainEvents());
  expect(calls).toBe(1);
  restored.apply(Input.HardDrop, 1);
  expect(calls).toBe(2);
});

test("Zen rewinds received garbage and local stats but cannot retract an external sent ledger", () => {
  const ledger: number[] = [];
  const g = game(p => { ledger.push(p.result.stats.attack); return [4]; });
  quad(g);
  g.setZen(true);
  const before = g.board.slice();
  g.apply(Input.HardDrop, 0);
  expect(g.board.includes(GARBAGE)).toBe(true);
  expect(ledger).toEqual([9]);
  g.undo(1);
  expect(g.board).toEqual(before);
  expect(g.stats.attack).toBe(0);
  expect(ledger).toEqual([9]);
  expect(g.drainEvents()).toEqual([{ type: "restored", sequence: 2, atMs: 1 }]);
});

test("connected games continue through repeated JSON snapshots with explicitly reattached independent controllers", () => {
  const referenceLedger: PlacementSettlement[] = [];
  const restoredLedger: PlacementSettlement[] = [];
  const controller = (ledger: PlacementSettlement[]): SettlePlacement => p => {
    ledger.push(p);
    return [p.result.sequence % COLS];
  };
  const reference = game(controller(referenceLedger));
  let restored = game(controller(restoredLedger));
  for (const g of [reference, restored]) g.apply(Input.SoftDropDown, 0);
  for (let at = 43; at <= 4300; at += 43) {
    reference.tick(at);
    restored.tick(at);
    restored = Game.fromState(JSON.parse(JSON.stringify(restored.saveState())), controller(restoredLedger));
    expect(restored.saveState()).toEqual(reference.saveState());
    expect(restoredLedger).toEqual(referenceLedger);
  }
  expect(referenceLedger).toHaveLength(4);
});

test("fractional timed overflow and callback failure produce exactly restorable terminal snapshots", () => {
  for (const failure of [false, true]) {
    let calls = 0;
    const settle: SettlePlacement = () => {
      calls++;
      if (failure) throw new Error("settlement failed");
      return [0];
    };
    const g = game(settle);
    g.board[0] = Piece.T;
    g.apply(Input.SoftDropDown, 8.768);
    g.apply(Input.SoftDropUp, 385.89099999999996);
    if (failure) expect(() => g.tick(1008.769)).toThrow("settlement failed");
    else g.tick(1008.769);
    const snapshot = JSON.parse(JSON.stringify(g.saveState()));
    expect(g.topOut).toBe(true);
    expect(snapshot.state.lockElapsed).toBe(1000.0000000000001);
    const restored = Game.fromState(snapshot, settle);
    expect(restored.saveState()).toEqual(snapshot);
    restored.tick(1010);
    g.tick(1010);
    expect(restored.saveState()).toEqual(g.saveState());
    expect(calls).toBe(1);
    snapshot.state.lockElapsed = 1000.001;
    expect(() => Game.fromState(snapshot, settle)).toThrow(RangeError);
  }
});
