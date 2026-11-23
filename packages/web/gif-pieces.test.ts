import { expect, test } from "bun:test";
import { Piece, ROWS, pathTo } from "@42tris/core";
import { boardToGame } from "./src/editor-play";
import { animateSteps, planStep } from "./src/gif-pieces";

const empty = "⬛⬛⬛⬛⬛⬛⬛⬛⬛⬛";
const pad = (rows: string[]) => [...Array(20 - rows.length).fill(empty), ...rows];
const filled = (board: string[]) => Array.from(board.join("")).filter(cell => cell !== "⬛").length;

// frames keep the old stack, show at most one extra piece and end on the new board
function check(from: string[], to: string[]) {
  const frames = planStep(from, to, to.length)!;
  expect(frames).not.toBeNull();
  expect(frames.at(-1)).toEqual(to);
  frames.forEach((frame, i) => {
    if (i) expect(frame).not.toEqual(frames[i - 1]);
    expect(frame).toHaveLength(to.length);
    frame.forEach((line, y) => Array.from(from[y]).forEach((cell, x) => {
      if (cell !== "⬛") expect(Array.from(line)[x]).toBe(cell);
    }));
    expect(filled(frame)).toBeGreaterThanOrEqual(filled(from));
    expect(filled(frame)).toBeLessThanOrEqual(filled(to) + 4);
  });
  return frames;
}

test("one tucked piece gets a frame per press and ends on the new board", () => {
  const from = pad(["⬜⬜⬜⬜⬛⬛⬛⬛⬛⬛", empty, empty]);
  const to = pad(["⬜⬜⬜⬜⬛⬛⬛⬛⬛⬛", "🟨🟨⬛⬛⬛⬛⬛⬛⬛⬛", "🟨🟨⬛⬛⬛⬛⬛⬛⬛⬛"]);
  const board = new Uint8Array(ROWS * 10);
  boardToGame(from, board);
  const moves = pathTo(board, Piece.O, { x: 0, y: 38, rot: 0 })!;
  // the hard drop frame is the same as the last press here, so it is not shown twice
  expect(check(from, to)).toHaveLength(moves.length - 1);
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

test("animateSteps holds only boards it jumps to, moving pieces never pause", () => {
  const a = pad([]), b = pad(["🟨🟨⬛⬛⬛⬛⬛⬛⬛⬛", "🟨🟨⬛⬛⬛⬛⬛⬛⬛⬛"]), c = pad([]);
  const { boards, holds } = animateSteps([a, b, c], 100);
  expect(boards.at(-1)).toEqual(c);
  expect(boards.at(-2)).toEqual(b);
  expect(holds.at(-1)).toBe(300);
  expect(holds[0]).toBe(300);
  expect(holds.slice(1, -1).every(hold => hold === 100)).toBe(true);
});

const tki = ["⬛⬛⬛🟦🟦🟦⬛⬛⬛⬛", "🟧⬛⬛🟥🟥🟦🟩⬛⬛⬛", "🟧⬛⬛⬛🟥🟥🟩🟩🟨🟨", "🟧🟧⬛⬜⬜⬜⬜🟩🟨🟨"];

test("the first board can be built from empty", () => {
  const frames = planStep([], tki)!;
  expect(frames.at(-1)).toEqual(tki);
  expect(check(Array(4).fill(empty), tki)).toEqual(frames);
  const { boards, holds, built } = animateSteps([tki], 100, true);
  expect(built).toBe(true);
  expect(boards[0]).toEqual(Array(4).fill(empty));
  expect(boards.at(-1)).toEqual(tki);
  expect(holds.every(hold => hold === 100)).toBe(true);
});

test("a first board that is not whole pieces shows as drawn", () => {
  const odd = ["🟦🟦🟦⬛⬛⬛⬛⬛⬛⬛"];
  expect(animateSteps([odd, odd], 100, true)).toEqual({ boards: [odd, odd], holds: [300, 300], built: false, skipped: [], limited: [] });
});

test("a timed out search reports its step without flagging the line clear", () => {
  const a = pad(["⬜⬜⬜⬜⬛⬛⬛⬛⬛⬛", empty, empty]);
  const b = pad(["⬜⬜⬜⬜⬛⬛⬛⬛⬛⬛", "🟨🟨⬛⬛⬛⬛⬛⬛⬛⬛", "🟨🟨⬛⬛⬛⬛⬛⬛⬛⬛"]);
  const c = pad([]);
  expect(animateSteps([a, b], 100).boards.length).toBeGreaterThan(2);
  const progress: number[][] = [];
  expect(animateSteps([a, b, c], 100, false, { stepTimeoutMs: 0, onProgress: (...args) => progress.push(args) }))
    .toEqual({ boards: [a, b, c], holds: [300, 300, 300], built: false, skipped: [2], limited: [] });
  expect(progress).toEqual([[2, 3], [3, 3]]);
  expect(animateSteps([tki], 100, true, { stepTimeoutMs: 0 }).skipped).toEqual([1]);
});

const blocks = Array.from("⬛🟥🟧🟨🟩⬜🟦🟪");
const tallStack = pad([
  "7000000666", "7701100446", "7335114420", "0335112225", "3305711405",
  "3325770445", "2227766645", "5077711633", "5422001133", "5442666040",
  "5642116244", "7666011204", "7755556225", "7440336665", "4400332225",
  "3307112045", "3377511044", "2227566604", "2777511633", "0070501133",
].map(row => Array.from(row, id => blocks[Number(id)]).join("")));

test("build from empty animates all 42 pieces of a 20-row stack", () => {
  const { boards, built, skipped } = animateSteps([tallStack], 100, true);
  expect(built).toBe(true);
  expect(skipped).toEqual([]);
  expect(boards[0]).toEqual(pad([]));
  expect(boards.at(-1)).toEqual(tallStack);
  const target = tallStack.map(row => Array.from(row));
  const counts = new Set(boards.filter(board => board.every((row, y) =>
    Array.from(row).every((cell, x) => cell === "⬛" || cell === target[y][x]))).map(filled));
  for (let count = 4; count <= 168; count += 4) expect(counts.has(count)).toBe(true);
});

test("a transition can add more than seven pieces", () => {
  const from = pad([]);
  const { boards, skipped } = animateSteps([from, tallStack], 100);
  expect(skipped).toEqual([]);
  expect(boards.length).toBeGreaterThan(42);
  expect(boards.at(-1)).toEqual(tallStack);
});

test("the shortest order drops i before s", () => {
  const frames = planStep([], tki)!;
  expect(frames).toHaveLength(6);
  expect(frames[0]).toEqual([empty, empty, empty, "⬛⬛⬛⬜⬜⬜⬜⬛⬛⬛"]);
  const board = new Uint8Array(ROWS * 10);
  const i = { x: 3, y: 38, rot: 0 };
  expect(pathTo(board, Piece.I, i)).toHaveLength(1);
  // in colour order the s is already locked, and the i has to tuck under it
  boardToGame([empty, "⬛⬛⬛⬛⬛⬛🟩⬛⬛⬛", "⬛⬛⬛⬛⬛⬛🟩🟩⬛⬛", "⬛⬛⬛⬛⬛⬛⬛🟩⬛⬛"], board);
  expect(pathTo(board, Piece.I, i)!.length).toBeGreaterThan(1);
});
