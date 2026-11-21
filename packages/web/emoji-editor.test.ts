import { expect, test } from "bun:test";
import { arrangeBoards, mirrorRows, parseSavedOpeners } from "./src/emoji-editor";

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
