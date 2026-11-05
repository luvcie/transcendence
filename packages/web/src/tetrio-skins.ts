export const MAX_SKIN_EXPORT_BYTES = 16 * 1024 * 1024;
export const TETRIO_SKIN_ROWS = 24;
export const TETRIO_PIECE_OFFSETS = [[0, 0], [4, 0], [8, 0], [12, 0], [0, 6], [4, 6], [8, 6]];
// TETR.IO+ atlas rows for top/right/bottom/left bits 8/4/2/1, plus bit 16 for an inner corner.
export const TETRIO_CONNECTION_ROWS = [12, 15, 0, 3, 13, 14, 1, 2, 8, 11, 4, 7, 9, 10, 5, 6,
  12, 15, 0, 17, 13, 14, 16, 22, 8, 21, 4, 23, 20, 18, 19, 6];

function pngSize(value: unknown): [number, number] {
  if (typeof value !== "string" || value.length > MAX_SKIN_EXPORT_BYTES
    || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error("This export does not contain a PNG skin.");
  const header = atob(value.slice(value.indexOf(",") + 1, value.indexOf(",") + 33));
  if (header.length < 24 || header.slice(0, 8) !== "\x89PNG\r\n\x1a\n" || header.slice(12, 16) !== "IHDR") throw new Error("Invalid skin PNG header.");
  const view = new DataView(Uint8Array.from(header, char => char.charCodeAt(0)).buffer);
  return [view.getUint32(16), view.getUint32(20)];
}

export function parseTetrioSkin(value: unknown): { image: string; frames: number; delay: number } {
  if (!value || typeof value !== "object") throw new Error("Invalid TETR.IO+ skin export.");
  const data = value as Record<string, unknown>;
  const [width, height] = pngSize(data.skin);
  if (width !== height || width < 64 || width > 2048 || width % 64) throw new Error("Use a square TETR.IO+ atlas, up to 2048px and divisible by 64.");
  if (data.skinAnim == null && data.skinAnimMeta == null) return { image: data.skin as string, frames: 1, delay: 0 };
  const meta = data.skinAnimMeta as { frames?: number; delay?: number } | null;
  if (!meta || !Number.isInteger(meta.frames) || meta.frames! < 1 || meta.frames! > 64
    || !Number.isFinite(meta.delay) || meta.delay! < 1 || meta.delay! > 3600) throw new Error("Use 1–64 animation frames and a delay of 1–3600 ticks.");
  const frames = meta.frames!, delay = meta.delay!;
  const [animatedWidth, animatedHeight] = pngSize(data.skinAnim);
  // The exporter packs 1024px frames, at most 16 per row (256 MiB decoded at the frame limit).
  if (animatedWidth !== Math.min(frames, 16) * 1024 || animatedHeight !== Math.ceil(frames / 16) * 1024) throw new Error("Invalid TETR.IO+ animation atlas dimensions.");
  return { image: data.skinAnim as string, frames, delay };
}

export async function convertTetrioSkin(image: HTMLImageElement, makeCanvas = () => document.createElement("canvas"), frames = 1): Promise<HTMLCanvasElement> {
  const columns = Math.min(frames, 16), rows = Math.ceil(frames / 16);
  const width = image.naturalWidth / columns;
  if (!Number.isInteger(frames) || frames < 1 || frames > 64 || width !== image.naturalHeight / rows
    || width < 64 || width > 2048 || width % 64) throw new Error("Unsupported TETR.IO+ skin atlas dimensions.");
  const cell = width * 3 / 64, padding = width >= 2048 ? 2 : 1;
  const sourceTile = cell - padding * 2, tile = Math.min(sourceTile, 32);
  const canvas = makeCanvas();
  canvas.width = tile * 9 * columns; canvas.height = tile * TETRIO_SKIN_ROWS * rows;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Skin conversion needs a 2D canvas.");
  ctx.imageSmoothingEnabled = false;
  for (let frame = 0; frame < frames; frame++) {
    // Let input and scrolling run between animation frames.
    if (frame > 0) await new Promise(resolve => setTimeout(resolve, 0));
    const fx = frame % columns, fy = Math.floor(frame / columns);
    for (let row = 0; row < TETRIO_SKIN_ROWS; row++) {
      TETRIO_PIECE_OFFSETS.forEach(([x, y], i) => ctx.drawImage(image,
        fx * width + (x + row % 4) * cell + padding, fy * width + (y + Math.floor(row / 4)) * cell + padding,
        sourceTile, sourceTile, (fx * 9 + i + 2) * tile, (fy * TETRIO_SKIN_ROWS + row) * tile, tile, tile));
    }
  }
  return canvas;
}
