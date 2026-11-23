import { expect, test } from "bun:test";
import { Piece, ROWS, pathTo } from "@42tris/core";
import { boardToGame } from "./src/editor-play";
import { animateSteps, planStep } from "./src/gif-pieces";

const empty = "⬛⬛⬛⬛⬛⬛⬛⬛⬛⬛";
const pad = (rows: string[]) => [...Array(20 - rows.length).fill(empty), ...rows];
const filled = (board: string[]) => Array.from(board.join("")).filter(cell => cell !== "⬛").length;

// frames keep the old stack, show at most one extra piece and end on the new board
function check(from: string[], to: string[], maxPieces?: number) {
  const frames = planStep(from, to, to.length, maxPieces)!;
  expect(frames).not.toBeNull();
  expect(frames.at(-1)).toEqual(to);
  for (const frame of frames) {
    expect(frame).toHaveLength(to.length);
    frame.forEach((line, y) => Array.from(from[y]).forEach((cell, x) => {
      if (cell !== "⬛") expect(Array.from(line)[x]).toBe(cell);
    }));
    expect(filled(frame)).toBeGreaterThanOrEqual(filled(from));
    expect(filled(frame)).toBeLessThanOrEqual(filled(to) + 4);
  }
  return frames;
}

test("one tucked piece gets a frame per press and ends on the new board", () => {
  const from = pad(["⬜⬜⬜⬜⬛⬛⬛⬛⬛⬛", empty, empty]);
  const to = pad(["⬜⬜⬜⬜⬛⬛⬛⬛⬛⬛", "🟨🟨⬛⬛⬛⬛⬛⬛⬛⬛", "🟨🟨⬛⬛⬛⬛⬛⬛⬛⬛"]);
  const board = new Uint8Array(ROWS * 10);
  boardToGame(from, board);
  const moves = pathTo(board, Piece.O, { x: 0, y: 38, rot: 0 })!;
  expect(check(from, to)).toHaveLength(moves.length);
});

test("a piece resting on another is placed after it", () => {
  const from = pad([]);
  const to = pad(["🟨🟨⬛⬛⬛⬛⬛⬛⬛⬛", "🟨🟨⬛⬛⬛⬛⬛⬛⬛⬛", "⬜⬜⬜⬜⬛⬛⬛⬛⬛⬛"]);
  const frames = check(from, to);
  const firstO = frames.findIndex(frame => frame.join("").includes("🟨"));
  expect(frames[firstO].at(-1)).toBe("⬜⬜⬜⬜⬛⬛⬛⬛⬛⬛");
});

test("touching pieces of one colour are split into whole pieces", () => {
  const from = pad([]);
  const to = pad(["🟨🟨🟨🟨⬛⬛⬛⬛⬛⬛", "🟨🟨🟨🟨⬛⬛⬛⬛⬛⬛"]);
  const frames = check(from, to);
  // the first o locks before the second one moves
  expect(frames.some(frame => filled(frame) === 4 && frame.slice(-2).every(line => line.startsWith("🟨🟨⬛")))).toBe(true);
});

test("a t-spin double slot animates into place", () => {
  const from = pad(["🟧🟧⬛⬛⬛⬛⬛⬛⬛⬛", "🟧⬛⬛⬛🟦🟦🟦🟦🟦🟦", "🟧🟧⬛🟦🟦🟦🟦🟦🟦🟦"]);
  const to = pad(["🟧🟧⬛⬛⬛⬛⬛⬛⬛⬛", "🟧🟪🟪🟪🟦🟦🟦🟦🟦🟦", "🟧🟧🟪🟦🟦🟦🟦🟦🟦🟦"]);
  check(from, to);
});

test("line clears, edits and partial pieces fall back to a jump", () => {
  expect(planStep(pad(["🟦🟦🟦🟦🟦🟦🟦🟦🟦⬛"]), pad([]))).toBeNull();
  expect(planStep(pad(["🟦⬛⬛⬛⬛⬛⬛⬛⬛⬛"]), pad(["🟥⬛⬛⬛⬛⬛⬛⬛⬛⬛"]))).toBeNull();
  expect(planStep(pad([]), pad(["🟦🟦🟦⬛⬛⬛⬛⬛⬛⬛"]))).toBeNull();
  expect(planStep(pad([]), pad([]))).toBeNull();
  // four cells of a colour that no reachable placement covers
  expect(planStep(pad([]), pad(["🟦⬛🟦⬛🟦⬛🟦⬛⬛⬛"]))).toBeNull();
});

test("animateSteps holds each step end three times and jumps where it cannot animate", () => {
  const a = pad([]), b = pad(["🟨🟨⬛⬛⬛⬛⬛⬛⬛⬛", "🟨🟨⬛⬛⬛⬛⬛⬛⬛⬛"]), c = pad([]);
  const { boards, holds } = animateSteps([a, b, c], 100);
  expect(boards.at(-1)).toEqual(c);
  expect(boards.at(-2)).toEqual(b);
  expect(holds.at(-1)).toBe(300);
  expect(holds.at(-2)).toBe(300);
  expect(holds[0]).toBe(300);
  expect(holds.slice(1, -2).every(hold => hold === 100)).toBe(true);
});

const tki = ["⬛⬛⬛🟦🟦🟦⬛⬛⬛⬛", "🟧⬛⬛🟥🟥🟦🟩⬛⬛⬛", "🟧⬛⬛⬛🟥🟥🟩🟩🟨🟨", "🟧🟧⬛⬜⬜⬜⬜🟩🟨🟨"];

test("the first board can be built from empty", () => {
  const frames = planStep([], tki, 4, Infinity)!;
  expect(frames.at(-1)).toEqual(tki);
  expect(check(Array(4).fill(empty), tki, Infinity)).toEqual(frames);
  const { boards, holds, built } = animateSteps([tki], 100, true);
  expect(built).toBe(true);
  expect(boards[0]).toEqual(Array(4).fill(empty));
  expect(boards.at(-1)).toEqual(tki);
  expect(holds[0]).toBe(300);
  expect(holds.at(-1)).toBe(300);
});

test("a first board that is not whole pieces shows as drawn", () => {
  const odd = ["🟦🟦🟦⬛⬛⬛⬛⬛⬛⬛"];
  expect(animateSteps([odd, odd], 100, true)).toEqual({ boards: [odd, odd], holds: [300, 300], built: false });
});

test("the order with the fewest presses wins, so the i hard drops before the s boxes it in", () => {
  const frames = planStep([], tki, 4, Infinity)!;
  // every piece here is a plain hard drop, one lock frame each
  expect(frames).toHaveLength(6);
  expect(frames[0]).toEqual([empty, empty, empty, "⬛⬛⬛⬜⬜⬜⬜⬛⬛⬛"]);
  const board = new Uint8Array(ROWS * 10);
  const i = { x: 3, y: 38, rot: 0 };
  expect(pathTo(board, Piece.I, i)).toHaveLength(1);
  // in colour order the s is already locked, and the i has to tuck under it
  boardToGame([empty, "⬛⬛⬛⬛⬛⬛🟩⬛⬛⬛", "⬛⬛⬛⬛⬛⬛🟩🟩⬛⬛", "⬛⬛⬛⬛⬛⬛⬛🟩⬛⬛"], board);
  expect(pathTo(board, Piece.I, i)!.length).toBeGreaterThan(1);
});
