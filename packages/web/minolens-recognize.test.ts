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

test.each([
  "harddrop-1", "harddrop-2", "fourlol-1", "fourlol-2", "youtube-1", "youtube-2",
  "crop-a-stack", "crop-b-garbage", "crop-c-padded", "tetrio-panels",
])(
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

test.each([
  { name: "crop-a-stack", x: 6, y: 8, width: 200, height: 100 },
  { name: "crop-b-garbage", x: 1, y: 5, width: 200, height: 200 },
  { name: "crop-c-padded", x: 106, y: 56, width: 200, height: 200 },
  { name: "tetrio-panels", x: 124, y: 58, width: 151, height: 300 },
])("recognizes manual crop for $name", ({ name, ...bounds }) => {
  const board = recognizeBoard(load(name), { bounds });
  expect(toEmoji(board.cells, board.cols)).toEqual(expected(name));
});

test.each([
  { x: 6, width: 200 },
  { x: 16, width: 190 },
  { x: 6, width: 190 },
])("keeps all ten columns in a tight crop at x=$x width=$width", ({ x, width }) => {
  const source = load("crop-a-stack");
  const height = source.height - 8;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const start = ((y + 8) * source.width + x) * 4;
    data.set(source.data.subarray(start, start + width * 4), y * width * 4);
  }
  const board = recognizeBoard({ width, height, data });
  expect(toEmoji(board.cells, board.cols)).toEqual(expected("crop-a-stack"));
});

test("saturated cyan near the blue hue boundary is confident", () => {
  const width = 100, height = 20;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 10; y < 20; y++) {
    for (let x = 0; x < 10; x++) data.set([0, 145, 210, 255], (y * width + x) * 4);
  }
  const board = recognizeBoard({ width, height, data }, { bounds: { x: 0, y: 0, width, height } });
  expect(toEmoji(board.cells, board.cols)).toEqual(["⬜" + "⬛".repeat(9)]);
  expect(board.confidence[10]).toBeGreaterThan(0.5);
});

test("an image shorter than one cell has no board", () => {
  const board = recognizeBoard({ width: 20, height: 1, data: new Uint8ClampedArray(80) });
  expect(board.rows).toBe(0);
  expect(board.cells).toHaveLength(0);
});
