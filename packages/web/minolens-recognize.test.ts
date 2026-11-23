import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { PNG } from "pngjs";
import { toEmoji } from "./src/minolens/emoji";
import { recognizeBoard } from "./src/minolens/recognize";

const fixtures = `${import.meta.dir}/test-fixtures/minolens`;
const load = (name: string) => {
  const png = PNG.sync.read(readFileSync(`${fixtures}/${name}.png`));
  return { width: png.width, height: png.height, data: new Uint8ClampedArray(png.data) };
};
const expected = (name: string) => readFileSync(`${fixtures}/${name}.txt`, "utf8").trim().split("\n");

test.each(["harddrop-1", "harddrop-2", "fourlol-1", "fourlol-2", "youtube-1", "youtube-2"])(
  "recognizes %s", name => {
    const board = recognizeBoard(load(name));
    expect(board.cols).toBe(10);
    expect(toEmoji(board.cells, board.cols)).toEqual(expected(name));
  },
);

test("manual crop reads the selected area", () => {
  const first = recognizeBoard(load("harddrop-1"), { bounds: { x: 11, y: 15, width: 274, height: 219 } });
  expect(first.rows).toBe(8);
  expect(toEmoji(first.cells, first.cols)).toEqual(expected("harddrop-1"));
  const second = recognizeBoard(load("youtube-2"), { bounds: { x: 175, y: 100, width: 231, height: 462 } });
  expect(second.rows).toBe(20);
  expect(toEmoji(second.cells, second.cols)).toEqual(expected("youtube-2"));
});

test("an image shorter than one cell has no board", () => {
  const board = recognizeBoard({ width: 20, height: 1, data: new Uint8ClampedArray(80) });
  expect(board.rows).toBe(0);
  expect(board.cells).toHaveLength(0);
});
