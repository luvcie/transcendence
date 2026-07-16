import { expect, test } from "bun:test";
import { Game, Input } from "./game";

test("left and right move one column per press", () => {
  const g = new Game(1);
  const startX = g.x;
  g.apply(Input.LeftDown, 0);
  expect(g.x).toBe(startX - 1);
  g.apply(Input.RightDown, 0);
  g.apply(Input.RightDown, 0);
  expect(g.x).toBe(startX + 1);
});

test("walls stop movement", () => {
  const g = new Game(1);
  for (let i = 0; i < 20; i++) g.apply(Input.LeftDown, 0);
  const atLeftWall = g.x;
  g.apply(Input.LeftDown, 0);
  expect(g.x).toBe(atLeftWall);
  for (let i = 0; i < 20; i++) g.apply(Input.RightDown, 0);
  const atRightWall = g.x;
  g.apply(Input.RightDown, 0);
  expect(g.x).toBe(atRightWall);
  expect(atRightWall).toBeGreaterThan(atLeftWall);
});

test("key up events are accepted and do nothing yet", () => {
  const g = new Game(1);
  const startX = g.x;
  g.apply(Input.LeftUp, 0);
  g.apply(Input.RightUp, 0);
  expect(g.x).toBe(startX);
});
