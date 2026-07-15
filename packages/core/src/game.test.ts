import { expect, test } from "bun:test";
import { SPAWN_Y } from "./pieces";
import { Game } from "./game";

test("piece falls one row per gravity step", () => {
  const g = new Game(1, 500);
  g.tick(1000);
  expect(g.y).toBe(SPAWN_Y);
  g.tick(1499);
  expect(g.y).toBe(SPAWN_Y);
  g.tick(1500);
  expect(g.y).toBe(SPAWN_Y + 1);
});

test("piece locks at the bottom and the next one spawns", () => {
  const g = new Game(1, 1);
  g.tick(0);
  g.tick(100);
  let filled = 0;
  for (const cell of g.board) if (cell !== 0) filled++;
  expect(filled).toBeGreaterThanOrEqual(4);
});

test("same seed and same ticks give the same game", () => {
  const a = new Game(108, 50);
  const b = new Game(108, 50);
  for (let t = 0; t <= 30000; t += 16) {
    a.tick(t);
    b.tick(t);
  }
  expect(a.piece).toBe(b.piece);
  expect(a.x).toBe(b.x);
  expect(a.y).toBe(b.y);
  expect(a.topOut).toBe(b.topOut);
  expect([...a.board]).toEqual([...b.board]);
});

test("stacking with no input eventually tops out", () => {
  const g = new Game(7, 1);
  g.tick(0);
  for (let i = 1; i < 10000 && !g.topOut; i++) {
    g.tick(i * 100);
  }
  expect(g.topOut).toBe(true);
});
