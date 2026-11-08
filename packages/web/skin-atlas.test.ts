import { expect, spyOn, test } from "bun:test";
import { packSkinFrames } from "./src/skin-atlas";
import { drawTile } from "./src/tile-renderer";
import { TETRIO_CONNECTION_ROWS } from "./src/tetrio-skins";
import type { LoadedSkin } from "./src/skin-loader";

function raster(width: number, height: number) {
  const pixels = new Uint32Array(width * height);
  const context = {
    clearRect() { pixels.fill(0); },
    getImageData: () => ({ data: new Uint8ClampedArray(pixels.buffer) }),
    createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    putImageData(image: ImageData, x: number, y: number) {
      const data = new Uint32Array(image.data.buffer);
      for (let row = 0; row < 32; row++) pixels.set(data.subarray(row * 32, row * 32 + 32), (y + row) * width + x);
    },
    paint(frame: number, connected: boolean) {
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        pixels[y * width + x] = 0xff000000 | (frame * 168 + Math.floor(x / 32) + (connected ? Math.floor(y / 32) * 7 : 0));
      }
    },
  };
  return { width, height, pixels, context, getContext: () => context };
}

test("flat animation tiles share storage across all 24 connection variants", async () => {
  const canvases: ReturnType<typeof raster>[] = [];
  const packed = await packSkinFrames(60, (ctx, frame) => (ctx as unknown as ReturnType<typeof raster>["context"]).paint(frame, false),
    (width, height) => { const canvas = raster(width, height); canvases.push(canvas); return canvas as unknown as HTMLCanvasElement; });
  expect(canvases[0].width).toBe(0);
  expect(packed.tiles).toHaveLength(60 * 168);
  expect(new Set(packed.tiles).size).toBe(60 * 7);
  expect(packed.image.width * packed.image.height * 4).toBeLessThan(2 * 1024 * 1024);
  for (let frame = 0; frame < 60; frame++) for (let row = 0; row < 24; row++) for (let piece = 0; piece < 7; piece++) {
    expect(packed.tiles[(frame * 24 + row) * 7 + piece]).toBe(packed.tiles[frame * 168 + piece]);
  }
});

test("packing retains distinct pixels for every connected tile and animation frame", async () => {
  const canvases: ReturnType<typeof raster>[] = [];
  const packed = await packSkinFrames(2, (ctx, frame) => (ctx as unknown as ReturnType<typeof raster>["context"]).paint(frame, true),
    (width, height) => { const canvas = raster(width, height); canvases.push(canvas); return canvas as unknown as HTMLCanvasElement; });
  const output = canvases[1];
  expect(new Set(packed.tiles).size).toBe(2 * 168);
  for (let i = 0; i < packed.tiles.length; i++) {
    const slot = packed.tiles[i], columns = output.width / 32;
    expect(output.pixels[Math.floor(slot / columns) * 32 * output.width + slot % columns * 32]).toBe((0xff000000 | i) >>> 0);
  }
  const draws: unknown[][] = [], clock = spyOn(performance, "now").mockReturnValue(500);
  const skin = { def: { tile: 0 }, image: packed.image, tiles: packed.tiles, tile: 32, connected: true,
    animation: { frames: 2, delay: 30 } } as LoadedSkin;
  try {
    for (let mask = 0; mask < 32; mask++) {
      drawTile({ drawImage: (...args: unknown[]) => draws.push(args) } as CanvasRenderingContext2D, 1, 0, 0, 30, skin, mask);
      const slot = packed.tiles[(24 + TETRIO_CONNECTION_ROWS[mask]) * 7];
      expect(draws.at(-1)!.slice(1, 5)).toEqual([slot % (output.width / 32) * 32, Math.floor(slot / (output.width / 32)) * 32, 32, 32]);
    }
  } finally { clock.mockRestore(); }
});

test("tile hash collisions compare pixels before sharing storage", async () => {
  const canvases: ReturnType<typeof raster>[] = [];
  const packed = await packSkinFrames(1, () => {
    const pixels = canvases[0].pixels;
    pixels[32] = 1;
    pixels[33] = (Math.imul(2166136261, 16777619) ^ Math.imul(2166136261 ^ 1, 16777619)) >>> 0;
  }, (width, height) => { const canvas = raster(width, height); canvases.push(canvas); return canvas as unknown as HTMLCanvasElement; });
  expect(packed.tiles[0]).not.toBe(packed.tiles[1]);
  expect(new Set(packed.tiles).size).toBe(2);
});
