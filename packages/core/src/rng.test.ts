import { expect, test } from "bun:test";
import { Rng } from "./rng";

test("same seed gives the same sequence", () => {
  const a = new Rng(1234);
  const b = new Rng(1234);
  for (let i = 0; i < 100; i++) {
    expect(a.next()).toBe(b.next());
  }
});

test("different seeds give different sequences", () => {
  const a = new Rng(1);
  const b = new Rng(2);
  let same = 0;
  for (let i = 0; i < 100; i++) {
    if (a.next() === b.next()) same++;
  }
  expect(same).toBe(0);
});

test("output stays in uint32 range", () => {
  const rng = new Rng(-42);
  for (let i = 0; i < 1000; i++) {
    const v = rng.next();
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(0xffffffff);
    expect(Number.isInteger(v)).toBe(true);
  }
});

test("nextBelow stays under the bound", () => {
  const rng = new Rng(7);
  for (let i = 0; i < 1000; i++) {
    const v = rng.nextBelow(7);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThan(7);
  }
});
