import type { LoadedSkin } from "./skin-loader";

type Image = LoadedSkin["image"];
type Tile = { page: Page; x: number; y: number };
type Atlas = { tiles: Map<number, Tile>; tail?: Page };
type Page = {
  atlas: Atlas;
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  bitmap?: ImageBitmap;
  width: number;
  side: number;
  slots: number[];
  used: number;
};

const maxBytes = 8 * 1024 * 1024;
const images = new WeakMap<Image, Map<number, Atlas>>();
const pages = new Set<Page>();
const scratchpads = new WeakMap<Document, CanvasRenderingContext2D>();
const views = new WeakMap<CanvasRenderingContext2D, { sizes: Map<number, Atlas>; size: number; atlas: Atlas }>();
let bytes = 0;
let clock = 0;

function drop(page: Page) {
  pages.delete(page);
  bytes -= page.width ** 2 * 4;
  page.bitmap?.close();
  page.ctx.canvas.width = 0;
  for (const slot of page.slots) page.atlas.tiles.delete(slot);
  if (page.atlas.tail === page) page.atlas.tail = undefined;
}

function release(atlas: Atlas) {
  for (const page of pages) if (page.atlas === atlas) drop(page);
}

export function releaseSkinTiles(skin?: LoadedSkin) {
  const sizes = skin && images.get(skin.image);
  if (sizes) for (const atlas of sizes.values()) release(atlas);
}

export function clearSkinTiles() {
  for (const page of pages) drop(page);
}

function newPage(document: Document, atlas: Atlas, size: number) {
  const side = Math.max(1, Math.min(4, Math.floor(1024 / size)));
  const width = side * size, cost = width * width * 4;
  while (bytes + cost > maxBytes) {
    let oldest: Page | undefined;
    for (const page of pages) if (!oldest || page.used < oldest.used) oldest = page;
    drop(oldest!);
  }
  const canvas = typeof OffscreenCanvas !== "undefined" && "transferToImageBitmap" in OffscreenCanvas.prototype
    ? new OffscreenCanvas(width, width) : document.createElement("canvas");
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== width) canvas.height = width;
  const ctx = canvas.getContext("2d")!;
  const page = { atlas, ctx, width, slots: [], side, used: 0 };
  pages.add(page);
  bytes += cost;
  return page;
}

function openPage(page: Page) {
  const canvas = page.ctx.canvas;
  if (!("transferToImageBitmap" in canvas)) return;
  if (page.bitmap) {
    canvas.width = canvas.height = page.width;
    page.ctx.drawImage(page.bitmap, 0, 0);
    page.bitmap.close();
    page.bitmap = undefined;
  } else if (page.slots.length) return;
  // seal the page after the draw so later draws can reuse its bitmap
  queueMicrotask(() => {
    if (!canvas.width) return;
    page.bitmap = canvas.transferToImageBitmap();
    canvas.width = canvas.height = 0;
  });
}

function paint(document: Document, ctx: Page["ctx"], image: Image, sx: number, sy: number, source: number, x: number, y: number, size: number) {
  if (size >= source) {
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(image, sx, sy, source, source, x, y, size, size);
    return;
  }
  // isolate the tile so its neighbors don't bleed in
  let scratch = scratchpads.get(document);
  if (!scratch) {
    scratch = document.createElement("canvas").getContext("2d")!;
    scratchpads.set(document, scratch);
  }
  const canvas = scratch.canvas;
  if (canvas.width !== source || canvas.height !== source) canvas.width = canvas.height = source;
  scratch.globalCompositeOperation = "copy";
  scratch.drawImage(image, sx, sy, source, source, 0, 0, source, source);
  let width = source;
  while (width >= size * 2) {
    const half = Math.ceil(width / 2);
    scratch.drawImage(canvas, 0, 0, width, width, 0, 0, half, half);
    width = half;
  }
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(canvas, 0, 0, width, width, x, y, size, size);
}

export function scaledTile(ctx: CanvasRenderingContext2D, skin: LoadedSkin, size: number, slot: number, sx: number, sy: number) {
  let view = views.get(ctx);
  if (size === skin.tile || size > 1024) {
    if (view) {
      release(view.atlas);
      views.delete(ctx);
    }
    return;
  }
  let sizes = images.get(skin.image);
  if (!view || view.sizes !== sizes || view.size !== size) {
    const canvas = ctx.canvas;
    if (!canvas?.ownerDocument || !canvas.style) return;
    if (view) release(view.atlas);
    if (!sizes) images.set(skin.image, sizes = new Map());
    let atlas = sizes.get(size);
    if (!atlas) sizes.set(size, atlas = { tiles: new Map() });
    views.set(ctx, view = { sizes, size, atlas });
  }
  const { atlas } = view;
  let tile = atlas.tiles.get(slot);
  if (!tile) {
    let page = atlas.tail;
    if (!page || page.slots.length === page.side ** 2) atlas.tail = page = newPage(ctx.canvas.ownerDocument, atlas, size);
    const index = page.slots.length;
    const x = index % page.side * size, y = Math.floor(index / page.side) * size;
    openPage(page);
    paint(ctx.canvas.ownerDocument, page.ctx, skin.image, sx, sy, skin.tile, x, y, size);
    page.slots.push(slot);
    atlas.tiles.set(slot, tile = { page, x, y });
  }
  tile.page.used = ++clock;
  return tile;
}
