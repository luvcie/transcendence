export const MAX_SKIN_EXPORT_BYTES = 16 * 1024 * 1024;
export const TETRIO_SKIN_ROWS = 24;
export const TETRIO_PIECE_OFFSETS = [[0, 0], [4, 0], [8, 0], [12, 0], [0, 6], [4, 6], [8, 6]];
// the unconnected tile of the garbage block, top right of the atlas
export const TETRIO_GARBAGE_OFFSET = [16, 3];
// TETR.IO+ atlas rows for top/right/bottom/left bits 8/4/2/1, plus bit 16 for an inner corner.
export const TETRIO_CONNECTION_ROWS = [12, 15, 0, 3, 13, 14, 1, 2, 8, 11, 4, 7, 9, 10, 5, 6,
  12, 15, 0, 17, 13, 14, 16, 22, 8, 21, 4, 23, 20, 18, 19, 6];

export function tetrioSourceTile(width: number) {
  return width * 3 / 64 - (width >= 2048 ? 4 : 2);
}

export function packedTileSize(source: number, frames: number) {
  // bound the decoded atlas even if every tile is different
  return Math.min(source, Math.floor(Math.sqrt(64 * 1024 * 1024 / (frames * TETRIO_SKIN_ROWS * 9 * 4))));
}

function pngSize(value: unknown): [number, number] {
  if (typeof value !== "string" || value.length > MAX_SKIN_EXPORT_BYTES
    || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error("This export does not contain a PNG skin.");
  const header = atob(value.slice(value.indexOf(",") + 1, value.indexOf(",") + 33));
  if (header.length < 24 || header.slice(0, 8) !== "\x89PNG\r\n\x1a\n" || header.slice(12, 16) !== "IHDR") throw new Error("Invalid skin PNG header.");
  const view = new DataView(Uint8Array.from(header, char => char.charCodeAt(0)).buffer);
  return [view.getUint32(16), view.getUint32(20)];
}

// a ghost atlas is half the size of its skin, a broken one only loses the ghost
function ghostImage(value: unknown, width: number, height: number): string | undefined {
  try {
    const [ghostWidth, ghostHeight] = pngSize(value);
    return ghostWidth * 2 === width && ghostHeight * 2 === height ? value as string : undefined;
  } catch { return undefined; }
}

export function parseTetrioSkin(value: unknown): { image: string; frames: number; delay: number; ghost?: string } {
  if (!value || typeof value !== "object") throw new Error("Invalid TETR.IO+ skin export.");
  const data = value as Record<string, unknown>;
  const [width, height] = pngSize(data.skin);
  if (width !== height || width < 64 || width > 2048 || width % 64) throw new Error("Use a square TETR.IO+ atlas, up to 2048px and divisible by 64.");
  if (data.skinAnim == null && data.skinAnimMeta == null) return { image: data.skin as string, frames: 1, delay: 0, ghost: ghostImage(data.ghost, width, height) };
  const meta = data.skinAnimMeta as { frames?: number; delay?: number } | null;
  if (!meta || !Number.isInteger(meta.frames) || meta.frames! < 1 || meta.frames! > 64
    || !Number.isFinite(meta.delay) || meta.delay! < 1 || meta.delay! > 3600) throw new Error("Use 1–64 animation frames and a delay of 1–3600 ticks.");
  const frames = meta.frames!, delay = meta.delay!;
  const [animatedWidth, animatedHeight] = pngSize(data.skinAnim);
  // The exporter packs 1024px frames, at most 16 per row (256 MiB decoded at the frame limit).
  if (animatedWidth !== Math.min(frames, 16) * 1024 || animatedHeight !== Math.ceil(frames / 16) * 1024) throw new Error("Invalid TETR.IO+ animation atlas dimensions.");
  const ghost = (data.ghostAnimMeta as { frames?: number } | null)?.frames === frames ? ghostImage(data.ghostAnim, animatedWidth, animatedHeight) : undefined;
  return { image: data.skinAnim as string, frames, delay, ghost };
}

export function convertTetrioSkin(image: HTMLImageElement, makeCanvas: () => HTMLCanvasElement, ghost?: HTMLImageElement) {
  const width = image.naturalWidth;
  if (width !== image.naturalHeight || width < 64 || width > 2048 || width % 64) {
    throw new Error("Unsupported TETR.IO+ skin atlas dimensions.");
  }
  const cell = width * 3 / 64, tile = tetrioSourceTile(width);
  const padding = (cell - tile) / 2;
  const canvas = makeCanvas();
  canvas.width = tile * 9; canvas.height = tile * TETRIO_SKIN_ROWS;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Skin conversion needs a 2D canvas.");
  ctx.imageSmoothingEnabled = false;
  for (let row = 0; row < TETRIO_SKIN_ROWS; row++) {
    TETRIO_PIECE_OFFSETS.forEach(([x, y], i) => ctx.drawImage(image,
      (x + row % 4) * cell + padding, (y + Math.floor(row / 4)) * cell + padding,
      tile, tile, (i + 2) * tile, row * tile, tile, tile));
    ctx.drawImage(image, TETRIO_GARBAGE_OFFSET[0] * cell + padding, TETRIO_GARBAGE_OFFSET[1] * cell + padding,
      tile, tile, 0, row * tile, tile, tile);
    if (ghost) ctx.drawImage(ghost, row % 4 * cell + padding, Math.floor(row / 4) * cell + padding,
      tile, tile, tile, row * tile, tile, tile);
  }
  return canvas;
}
