import { expect, test } from "bun:test";
import { Bag } from "./bag";

function drawSeven(bag: Bag): number[] {
  const out: number[] = [];
  for (let i = 0; i < 7; i++) out.push(bag.next());
  return out;
}

test("every run of 7 is a permutation of all pieces", () => {
  const bag = new Bag(99);
  for (let run = 0; run < 20; run++) {
    const sorted = drawSeven(bag).sort((a, b) => a - b);
    expect(sorted).toEqual([1, 2, 3, 4, 5, 6, 7]);
  }
});

test("same seed gives the same piece order", () => {
  const a = new Bag(2026);
  const b = new Bag(2026);
  for (let i = 0; i < 70; i++) {
    expect(a.next()).toBe(b.next());
  }
});

test("different seeds shuffle differently", () => {
  const orders = new Set<string>();
  for (let seed = 0; seed < 20; seed++) {
    orders.add(drawSeven(new Bag(seed)).join(""));
  }
  expect(orders.size).toBeGreaterThan(15);
});
