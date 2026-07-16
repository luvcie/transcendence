import { expect, test } from "bun:test";
import { Bag } from "./bag";
import { Game } from "./game";

test("current piece and previews match the bag order", () => {
  const g = new Game(108, 500, 14);
  const bag = new Bag(108);
  expect(g.piece).toBe(bag.next());
  for (let i = 0; i < 14; i++) {
    expect(g.previews[i]).toBe(bag.next());
  }
});

test("the next preview becomes the piece after a lock", () => {
  const g = new Game(1, 1, 5);
  const expected = g.previews[0];
  g.tick(0);
  // gravity is 1ms so 25 steps is enough to reach the floor and lock
  g.tick(25);
  expect(g.piece).toBe(expected);
  expect(g.dealt).toBe(2);
});

test("previews always hold valid pieces", () => {
  const g = new Game(7, 1, 5);
  g.tick(0);
  for (let t = 1; t < 40; t++) {
    g.tick(t * 30);
    for (const p of g.previews) {
      expect(p).toBeGreaterThanOrEqual(1);
      expect(p).toBeLessThanOrEqual(7);
    }
  }
});
