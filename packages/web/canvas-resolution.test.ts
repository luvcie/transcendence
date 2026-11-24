import { expect, test } from "bun:test";
import { cellPixels } from "./src/canvas-resolution";

test("rounds responsive cells to whole device pixels, including fractional display scales", () => {
  expect([1, 1.25, 1.5, 2, 3].map(ratio => cellPixels(15.6, ratio))).toEqual([16, 20, 23, 31, 47]);
  expect(cellPixels(0, 3)).toBe(1);
});
