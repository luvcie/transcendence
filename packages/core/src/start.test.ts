import { expect, test } from "bun:test";
import { Game, Input } from "./game";
import { DEFAULT_HANDLING } from "./handling";
import { SPAWN_Y } from "./pieces";

test("opening queue includes the first piece until the ready phase ends", () => {
  const g = new Game(108, 500, 5, DEFAULT_HANDLING, 250);
  const first = g.previews[0];
  const second = g.previews[1];
  g.tick(0);
  expect(g.starting).toBe(true);
  expect(g.dealt).toBe(0);
  g.tick(249);
  expect(g.previews[0]).toBe(first);
  g.tick(250);
  expect(g.starting).toBe(false);
  expect(g.piece).toBe(first);
  expect(g.previews[0]).toBe(second);
  expect(g.dealt).toBe(1);
  g.tick(749);
  expect(g.y).toBe(SPAWN_Y);
  g.tick(750);
  expect(g.y).toBe(SPAWN_Y + 1);
});

test("ready phase ignores gameplay inputs and freezes while paused", () => {
  const g = new Game(108, 500, 5, DEFAULT_HANDLING, 250);
  g.tick(0);
  g.apply(Input.Hold, 50);
  g.apply(Input.HardDrop, 100);
  expect(g.held).toBeNull();
  expect(g.dealt).toBe(0);
  g.setPaused(true, 100);
  g.tick(5000);
  g.setPaused(false, 5000);
  g.tick(5149);
  expect(g.starting).toBe(true);
  g.tick(5150);
  expect(g.starting).toBe(false);
  expect(g.dealt).toBe(1);
});

test("a delayed frame advances only the time after the first spawn", () => {
  const g = new Game(108, 500, 5, DEFAULT_HANDLING, 250);
  g.tick(0);
  g.tick(750);
  expect(g.dealt).toBe(1);
  expect(g.y).toBe(SPAWN_Y + 1);
});
