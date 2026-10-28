import { expect, test } from "bun:test";
import { Game, Input } from "./game";
import { COLS, place } from "./board";
import { MINOS, SPAWN_Y, spawnX } from "./pieces";

test("first hold stores the piece and consumes one preview", () => {
  const g = new Game(108);
  const current = g.piece;
  const next = g.previews[0];
  const after = g.previews[1];
  g.apply(Input.Hold, 0);
  expect(g.held).toBe(current);
  expect(g.piece).toBe(next);
  expect(g.previews[0]).toBe(after);
  expect(g.dealt).toBe(2);
  expect(g.holdUsed).toBe(true);
  expect([...g.board].filter(Boolean)).toHaveLength(0);
});

test("hold cannot be used again until the piece locks", () => {
  const g = new Game(108);
  g.apply(Input.Hold, 0);
  const current = g.piece;
  const held = g.held;
  g.apply(Input.Hold, 0);
  expect(g.piece).toBe(current);
  expect(g.held).toBe(held);
  expect(g.dealt).toBe(2);
  g.apply(Input.HardDrop, 0);
  expect(g.holdUsed).toBe(false);
  g.apply(Input.Hold, 0);
  expect(g.piece).toBe(held);
  expect(g.holdUsed).toBe(true);
});

test("swapping hold resets position, rotation and gravity without consuming previews", () => {
  const g = new Game(108);
  const first = g.piece;
  g.apply(Input.Hold, 0);
  g.apply(Input.HardDrop, 0);
  const current = g.piece;
  const previews = g.previews.slice();
  const dealt = g.dealt;
  g.apply(Input.RightDown, 10);
  g.apply(Input.RightUp, 11);
  g.apply(Input.RotateCw, 20);
  g.apply(Input.Hold, 400);
  expect(g.piece).toBe(first);
  expect(g.held).toBe(current);
  expect(g.rot).toBe(0);
  expect(g.x).toBe(spawnX(first));
  expect(g.y).toBe(SPAWN_Y);
  expect(g.lastWasRotation).toBe(false);
  expect(g.lastKickIndex).toBe(0);
  expect(g.previews).toEqual(previews);
  expect(g.dealt).toBe(dealt);
  g.tick(899);
  expect(g.y).toBe(SPAWN_Y);
  g.tick(900);
  expect(g.y).toBe(SPAWN_Y + 1);
});

test("gravity locking also makes hold available again", () => {
  const g = new Game(108, 1);
  g.apply(Input.Hold, 0);
  for (let t = 1; g.dealt === 2 && t < 100; t++) g.tick(t);
  expect(g.dealt).toBe(3);
  expect(g.holdUsed).toBe(false);
});

test("holding into a blocked spawn tops out", () => {
  const g = new Game(108);
  g.apply(Input.Hold, 0);
  g.apply(Input.HardDrop, 0);
  const held = g.held!;
  place(g.board, held, 0, spawnX(held), SPAWN_Y);
  g.apply(Input.Hold, 0);
  expect(g.topOut).toBe(true);
  expect(g.piece).toBe(held);
  const minos = MINOS[held][0];
  expect(g.board[(SPAWN_Y + minos[1]) * COLS + spawnX(held) + minos[0]]).toBe(held);
});

test("hold is ignored while paused or topped out", () => {
  const g = new Game(108);
  g.setPaused(true, 0);
  g.apply(Input.Hold, 0);
  expect(g.held).toBeNull();
  g.setPaused(false, 1);
  g.topOut = true;
  g.apply(Input.Hold, 1);
  expect(g.held).toBeNull();
});
