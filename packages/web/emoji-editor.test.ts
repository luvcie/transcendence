import { expect, test } from "bun:test";
import { MINOS, pieceEdges } from "@42tris/core";
import { arrangeBoards, mirrorRows, parseEmojiMode, parseSavedOpeners } from "./src/emoji-editor";
import { gifSize, tetrominoEdges, timeline } from "./src/emoji-gif";

const row = (emoji: string) => emoji.repeat(10);

test("boards in a row are bottom aligned and joined by a space", () => {
  const [group] = arrangeBoards([[row("🟦"), row("🟥")], [row("🟩")]], 2);
  expect(group).toBe(`${row("🟦")} ${row("⬛")}\n${row("🟥")} ${row("🟩")}`);
});

test("boards are split into rows of the given size", () => {
  expect(arrangeBoards([[row("🟦")], [row("🟥")], [row("🟩")]], 2)).toEqual([
    `${row("🟦")} ${row("🟥")}`,
    row("🟩"),
  ]);
});

test("mirroring flips a board and swaps S/Z and J/L", () => {
  expect(mirrorRows(["🟦🟦🟦⬛⬛⬛⬛⬛⬛🟩"])).toEqual(["🟥⬛⬛⬛⬛⬛⬛🟧🟧🟧"]);
});

test("saved openers ignore anything that is not valid", () => {
  const good = { name: "mine", steps: [[row("🟦")], []] };
  expect(parseSavedOpeners(JSON.stringify([good]))).toEqual([good]);
  expect(parseSavedOpeners(null)).toEqual([]);
  expect(parseSavedOpeners("not json")).toEqual([]);
  expect(parseSavedOpeners(JSON.stringify([{ name: "x", steps: [["🟦"]] }]))).toEqual([]);
  expect(parseSavedOpeners(JSON.stringify([{ name: "x", steps: [[row("🍎")]] }]))).toEqual([]);
  expect(parseSavedOpeners(JSON.stringify([{ name: "", steps: [[]] }, good]))).toEqual([good]);
});

test("timeline holds each step once for flat skins and ticks for animated ones", () => {
  expect(timeline([1000, 1000, 1000], false)).toEqual([
    { step: 0, at: 0, duration: 1000 }, { step: 1, at: 1000, duration: 1000 }, { step: 2, at: 2000, duration: 2000 },
  ]);
  const animated = timeline([1000, 1000], true);
  expect(animated).toHaveLength(30);
  expect(animated[10]).toEqual({ step: 1, at: 1000, duration: 100 });
  expect(animated.reduce((sum, frame) => sum + frame.duration, 0)).toBe(3000);
  expect(timeline([500, 500], false).map(frame => frame.duration)).toEqual([500, 1000]);
});

test("gifSize sizes the canvas from the block size and the tallest board", () => {
  expect(gifSize([["⬛⬛⬛⬛⬛⬛⬛⬛⬛⬛"], Array(4).fill("⬛⬛⬛⬛⬛⬛⬛⬛⬛⬛")], 16)).toEqual({ rows: 4, width: 160, height: 64 });
});

test("emoji mode is on unless storage explicitly says false", () => {
  expect(parseEmojiMode("false")).toBe(false);
  for (const raw of ["true", null, "", "0", "nope"]) expect(parseEmojiMode(raw)).toBe(true);
});

// a 10 wide grid from rows of digits, 0 is empty
const grid = (...rows: string[]) => rows.flatMap(line => [...line.padEnd(10, "0")].map(Number));

test("every piece in every rotation gets the same edges as the game", () => {
  for (let id = 1; id <= 7; id++) for (let rot = 0; rot < 4; rot++) {
    const minos = MINOS[id][rot], cells = new Array(40).fill(0);
    for (let i = 0; i < 8; i += 2) cells[minos[i + 1] * 10 + minos[i] + 3] = id;
    const edges = tetrominoEdges(cells);
    for (let i = 0; i < 8; i += 2) expect(edges[minos[i + 1] * 10 + minos[i] + 3]).toBe(pieceEdges(minos, i));
  }
});

test("two touching pieces of one colour join only inside each piece", () => {
  const edges = tetrominoEdges(grid("3333", "3333"));
  expect([...edges.slice(0, 4)].map(edge => edge & 15)).toEqual([6, 3, 6, 3]);
  const ts = tetrominoEdges(grid("777777", "070070"));
  expect([...ts].filter(Boolean)).toHaveLength(8);
  expect(ts[2] & 4).toBe(0);
});

test("a drawing that is not made of the colour's pieces stays single blocks", () => {
  for (const cells of [grid("777", "777"), grid("7777", "7777"), grid("55555"), grid("11"), grid("88", "88")]) {
    expect(tetrominoEdges(cells).every(edge => edge === 0)).toBe(true);
  }
});

test("a different colour next to a piece never joins it", () => {
  const edges = tetrominoEdges(grid("7772", "0702", "00022"));
  expect(edges[2] & 15).toBe(1);
  expect(edges[3] & 15).toBe(2);
  expect(edges[11] & 15).toBe(8);
});
