import { expect, test } from "bun:test";
import { arrangeBoards, mirrorRows, parseSavedOpeners } from "./src/emoji-editor";
import { gifSize, timeline } from "./src/emoji-gif";

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
  expect(timeline(3, false)).toEqual([
    { step: 0, at: 0, duration: 1000 }, { step: 1, at: 1000, duration: 1000 }, { step: 2, at: 2000, duration: 2000 },
  ]);
  const animated = timeline(2, true);
  expect(animated).toHaveLength(30);
  expect(animated[10]).toEqual({ step: 1, at: 1000, duration: 100 });
  expect(animated.reduce((sum, frame) => sum + frame.duration, 0)).toBe(3000);
  expect(timeline(2, false, 500).map(frame => frame.duration)).toEqual([500, 1000]);
});

test("gifSize sizes the canvas from the block size and the tallest board", () => {
  expect(gifSize([["⬛⬛⬛⬛⬛⬛⬛⬛⬛⬛"], Array(4).fill("⬛⬛⬛⬛⬛⬛⬛⬛⬛⬛")], 16)).toEqual({ rows: 4, width: 160, height: 64 });
});
