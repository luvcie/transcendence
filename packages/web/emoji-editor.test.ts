import { expect, test } from "bun:test";
import { arrangeBoards } from "./src/emoji-editor";

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
