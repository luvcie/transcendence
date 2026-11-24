import { expect, test } from "bun:test";
import { CLASSIC } from "./src/skin-catalog";
import { releaseSkinTiles } from "./src/tile-cache";
import { drawTile } from "./src/tile-renderer";

function context() {
  const document = { createElement: () => makeContext().canvas };
  function makeContext() {
    const draws: unknown[][] = [];
    const canvas = { width: 0, height: 0, ownerDocument: document, style: {}, getContext: () => ctx };
    const ctx = { canvas, imageSmoothingEnabled: true, drawImage: (...args: unknown[]) => { draws.push(args); } };
    return { canvas, ctx, draws };
  }
  return makeContext();
}

test("reuses scaled atlas tiles across frames and releases their old backing pixels on resize", () => {
  const output = context();
  const ctx = output.ctx as unknown as CanvasRenderingContext2D;
  const image = { width: 48 * 9 } as HTMLCanvasElement;
  const skin = { def: CLASSIC, image, tile: 48, tiles: new Uint16Array(2 * 24 * 9) };
  try {
    drawTile(ctx, 1, 0, 0, 96, skin, 0, false, 0);
    drawTile(ctx, 1, 96, 0, 96, skin, 0, false, 1);
    const page = output.draws[0][0] as HTMLCanvasElement;
    expect(output.draws).toEqual([
      [page, 0, 0, 96, 96, 0, 0, 96, 96],
      [page, 0, 0, 96, 96, 96, 0, 96, 96],
    ]);
    expect(page).not.toBe(image);
    expect(page.getContext("2d")!.imageSmoothingEnabled).toBe(false);
    expect(ctx.imageSmoothingEnabled).toBe(false);
    drawTile(ctx, 1, 0, 0, 30, skin);
    expect(page.width).toBe(0);
    const smaller = output.draws[2][0] as HTMLCanvasElement;
    expect(output.draws[2]).toEqual([smaller, 0, 0, 30, 30, 0, 0, 30, 30]);
    expect(smaller.getContext("2d")!.imageSmoothingEnabled).toBe(true);
    releaseSkinTiles(skin);
    expect(smaller.width).toBe(0);
  } finally { releaseSkinTiles(skin); }
});

test("evicts the least recently drawn page at 8 MiB and releases the remaining pages", () => {
  const output = context();
  const ctx = output.ctx as unknown as CanvasRenderingContext2D;
  const skin = { def: CLASSIC, image: { width: 144 } as HTMLCanvasElement, tile: 16 };
  try {
    for (const id of [1, 2, 1, 3]) drawTile(ctx, id, 0, 0, 1024, skin);
    const [first, second, reused, third] = output.draws.map(draw => draw[0] as HTMLCanvasElement);
    expect(first).toBe(reused);
    expect([first.width, second.width, third.width]).toEqual([1024, 0, 1024]);
    releaseSkinTiles(skin);
    expect([first.width, third.width]).toEqual([0, 0]);
  } finally { releaseSkinTiles(skin); }
});
