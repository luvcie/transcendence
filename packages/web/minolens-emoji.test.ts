import { expect, test } from "bun:test";
import { empty, ids } from "./src/board-emoji";
import { parseBoardText } from "./src/emoji-editor";
import { toEmoji } from "./src/minolens/emoji";

test("round trip through the editor keeps every id", () => {
  const cells = Uint8Array.from({ length: 20 }, (_, i) => i % 9);
  const lines = toEmoji(cells, 10);
  const parsed = parseBoardText(lines.join("\n"));
  expect(parsed).toEqual(lines);
  if (typeof parsed === "string") throw new Error(parsed);
  expect(parsed.flatMap(row => Array.from(row, emoji => ids[emoji] ?? 0))).toEqual([...cells]);
  expect(lines[0]).toBe("⬛🟥🟧🟨🟩⬜🟦🟪🟫⬛");
});

test("trims only leading empty rows when asked", () => {
  const cells = new Uint8Array([0, 0, 0, 3, 0, 0, 5, 0, 0, 0]);
  const blank = empty.repeat(2);
  const rows = ["⬛🟨", blank, "⬜⬛", blank];
  expect(toEmoji(cells, 2)).toEqual(rows);
  expect(toEmoji(cells, 2, false)).toEqual([blank, ...rows]);
});
