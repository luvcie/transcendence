import { expect, test } from "bun:test";
import { Game, Input, type GameEvent, type InputId } from "./game";
import { DEFAULT_HANDLING } from "./handling";

const inputs: [number, InputId][] = [
  [0, Input.LeftDown], [0, Input.SoftDropDown], [1550, Input.LeftUp],
  [1550, Input.RightDown], [2700, Input.RotateCw], [2800, Input.RightUp],
  [2950, Input.HardDrop], [3100, Input.Hold], [3300, Input.LeftDown], [4300, Input.LeftUp],
];
function play(step: number, sdarr: number) {
  const g = new Game(108, 500, 5, { ...DEFAULT_HANDLING, das: 4.8, arr: 0.6, sdarr });
  g.setZen(true);
  const events: GameEvent[] = [];
  let last = 0;
  for (const [at, input] of inputs) {
    for (let t = last + step; t < at; t += step) {
      g.tick(t);
      events.push(...g.drainEvents());
    }
    g.apply(input, at);
    events.push(...g.drainEvents());
    last = at;
  }
  for (let t = last + step; t < 6500; t += step) {
    g.tick(t);
    events.push(...g.drainEvents());
  }
  g.tick(6500);
  events.push(...g.drainEvents());
  return { g, events };
}

test("lock results and final state are independent of render tick batching", () => {
  for (const sdarr of [0, 0.6, 2]) {
    const fine = play(7, sdarr);
    const coarse = play(Infinity, sdarr);
    expect(fine.g.board).toEqual(coarse.g.board);
    expect(fine.g.previews).toEqual(coarse.g.previews);
    expect(fine.g.stats).toEqual(coarse.g.stats);
    expect([fine.g.x, fine.g.y, fine.g.rot, fine.g.held]).toEqual([coarse.g.x, coarse.g.y, coarse.g.rot, coarse.g.held]);
    expect(fine.events).toEqual(coarse.events);
    expect(fine.events.length).toBeGreaterThan(2);
  }
});

test("one tick may enqueue multiple locks, including the tick nested in apply", () => {
  const g = new Game(108, 500, 5, { ...DEFAULT_HANDLING, sdarr: 0 });
  g.apply(Input.SoftDropDown, 0);
  g.apply(Input.HardDrop, 2100);
  expect(g.drainEvents().map(event => [event.sequence, event.atMs])).toEqual([[1, 1000], [2, 2000], [3, 2100]]);
  expect(g.drainEvents()).toEqual([]);
});

test("two players do not share counters, attack events or undo history", () => {
  const a = new Game(108);
  const b = new Game(108);
  a.setZen(true);
  a.apply(Input.HardDrop, 0);
  expect(b.stats.pieces).toBe(0);
  expect(b.undoCount).toBe(0);
  expect(b.board.every(cell => cell === 0)).toBe(true);
  expect(b.drainEvents()).toEqual([]);
  expect(a.drainEvents()).toHaveLength(1);
  a.undo(0);
  expect(a.drainEvents()).toHaveLength(1);
  expect(b.drainEvents()).toEqual([]);
});
