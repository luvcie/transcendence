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
  expect(toEmoji(first.cells, first.cols)).toEqual(expected("harddrop-1"));
});

test.each([
  { name: "tetrio-panels", rows: 7, x: 125, y: 249, width: 149, height: 109 },
  { name: "harddrop-1", rows: 4, x: 11, y: 124, width: 274, height: 110 },
])("bottom crop matches the last $rows rows of $name", ({ name, rows, ...bounds }) => {
  const image = load(name);
  const full = recognizeBoard(image);
  const crop = recognizeBoard(image, { bounds });
  expect(crop.rows).toBe(rows);
  expect(crop.cells).toEqual(full.cells.slice(-rows * full.cols));
});

test.each([
  { x: 175, y: 100, width: 231, height: 462 },
  { x: 161, y: 74, width: 260, height: 510 },
])("keeps the selected empty rows of a 20-row manual crop at $x, $y", bounds => {
  const image = load("youtube-2");
  const full = recognizeBoard(image);
  const crop = recognizeBoard(image, { bounds });
  const emptyRows = 20 - full.rows;
  expect(crop.rows).toBe(20);
  expect(crop.cells.slice(0, emptyRows * crop.cols)).toEqual(new Uint8Array(emptyRows * crop.cols));
  expect(crop.cells.slice(emptyRows * crop.cols)).toEqual(full.cells);
  expect(toEmoji(crop.cells, crop.cols, false)).toHaveLength(20);
  expect(toEmoji(crop.cells, crop.cols, true)).toEqual(expected("youtube-2"));
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
  { name: "tetrio-panels", x: 109, y: 39, width: 174, height: 346, boardX: 124, boardY: 58 },
  { name: "tetrio-panels", x: 124, y: 31, width: 151, height: 354, boardX: 124, boardY: 58 },
  { name: "crop-c-padded", x: 9, y: 6, width: 445, height: 292, boardX: 106, boardY: 56 },
])("fits the board within a loose crop of $name", ({ name, boardX, boardY, ...bounds }) => {
  const board = recognizeBoard(load(name), { bounds });
  expect(board.rows).toBeLessThanOrEqual(20);
  expect(toEmoji(board.cells, board.cols)).toEqual(expected(name));
  expect(Math.abs(board.bounds.x - boardX)).toBeLessThan(2);
  expect(Math.abs(board.bounds.y - boardY)).toBeLessThan(2);
});

test.each([
  { name: "crop-c-padded", x: 0, y: 0, width: 80, height: 80 },
  { name: "tetrio-panels", x: 5, y: 5, width: 60, height: 60 },
  { name: "tetrio-panels", x: 282, y: 60, width: 70, height: 75 },
])("rejects a crop without a board in $name at $x, $y", ({ name, ...bounds }) => {
  const board = recognizeBoard(load(name), { bounds });
  expect(board.rows).toBe(0);
  expect(board.confidence).toHaveLength(0);
});

test("rejects a literal box taller than 20 rows when no grid fits", () => {
  const width = 40, height = 88;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = height - 4; y < height; y++) {
    for (let x = 0; x < 4; x++) data.set([0, 145, 210, 255], (y * width + x) * 4);
  }
  const board = recognizeBoard({ width, height, data }, { bounds: { x: 0, y: 0, width, height } });
  expect(board.rows).toBe(0);
});

test("reads grey garbage in a literal crop", () => {
  const width = 40, height = 12;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 8; y < 12; y++) {
    for (let x = 0; x < 4; x++) data.set([55, 55, 55, 255], (y * width + x) * 4);
  }
  const board = recognizeBoard({ width, height, data }, { bounds: { x: 0, y: 0, width, height } });
  expect(toEmoji(board.cells, board.cols)).toEqual(["🟫" + "⬛".repeat(9)]);
});

test.each(["harddrop-1", "harddrop-2"])("uniform grey garbage is confident in %s", name => {
  const board = recognizeBoard(load(name));
  const grey = [...board.confidence].filter((_, i) => board.cells[i] === 8);
  expect(grey.length).toBeGreaterThan(0);
  expect(Math.min(...grey)).toBeGreaterThan(0.5);
});

test("uncertain cells still get marked in youtube-2", () => {
  const board = recognizeBoard(load("youtube-2"));
  expect([...board.confidence].some((confidence, i) => confidence <= 0.5 && board.cells[i] === 0)).toBe(true);
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
  expect(board.confidence[board.cells.indexOf(5)]).toBeGreaterThan(0.5);
});

test("an image shorter than one cell has no board", () => {
  const board = recognizeBoard({ width: 20, height: 1, data: new Uint8ClampedArray(80) });
  expect(board.rows).toBe(0);
  expect(board.cells).toHaveLength(0);
});
