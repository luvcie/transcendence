import { TETRIO_PIECE_OFFSETS, TETRIO_SKIN_ROWS } from "./tetrio-skins";

type SkinCanvas = HTMLCanvasElement | OffscreenCanvas;
type SkinContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export function drawTetrioFrame(ctx: SkinContext, image: CanvasImageSource, width: number, frame: number, frames: number, tile = 32) {
  const columns = Math.min(frames, 16), cell = width * 3 / 64, padding = width >= 2048 ? 2 : 1;
  for (let row = 0; row < TETRIO_SKIN_ROWS; row++) {
    TETRIO_PIECE_OFFSETS.forEach(([x, y], piece) => ctx.drawImage(image,
      frame % columns * width + (x + row % 4) * cell + padding,
      Math.floor(frame / columns) * width + (y + Math.floor(row / 4)) * cell + padding,
      cell - padding * 2, cell - padding * 2, piece * tile, row * tile, tile, tile));
  }
}

export async function packSkinFrames<T extends SkinCanvas>(frames: number, paint: (ctx: SkinContext, frame: number) => void | Promise<void>,
  makeCanvas: (width: number, height: number) => T, size = 32) {
  const scratch = makeCanvas(7 * size, TETRIO_SKIN_ROWS * size);
  const ctx = scratch.getContext("2d", { willReadFrequently: true }) as SkinContext | null;
  if (!ctx) throw new Error("Skin conversion needs a 2D canvas.");
  ctx.imageSmoothingEnabled = false;
  const tiles = new Uint16Array(frames * TETRIO_SKIN_ROWS * 7);
  const unique: Uint32Array[] = [], hashes = new Map<number, number[]>();
  try {
    for (let frame = 0; frame < frames; frame++) {
      ctx.clearRect(0, 0, scratch.width, scratch.height);
      await paint(ctx, frame);
      const data = ctx.getImageData(0, 0, scratch.width, scratch.height).data;
      const pixels = new Uint32Array(data.buffer, data.byteOffset, data.byteLength / 4);
      for (let tile = 0; tile < TETRIO_SKIN_ROWS * 7; tile++) {
        const offset = Math.floor(tile / 7) * size * scratch.width + tile % 7 * size;
        let hash = 2166136261;
        for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) hash = Math.imul(hash ^ pixels[offset + y * scratch.width + x], 16777619);
        const matches = hashes.get(hash) ?? [];
        let index = matches.find(index => unique[index].every((pixel, i) => pixel === pixels[offset + Math.floor(i / size) * scratch.width + i % size]));
        if (index === undefined) {
          index = unique.length;
          const copy = new Uint32Array(size * size);
          for (let y = 0; y < size; y++) copy.set(pixels.subarray(offset + y * scratch.width, offset + y * scratch.width + size), y * size);
          unique.push(copy); matches.push(index); hashes.set(hash, matches);
        }
        tiles[frame * TETRIO_SKIN_ROWS * 7 + tile] = index;
      }
    }
    const columns = Math.ceil(Math.sqrt(unique.length)), image = makeCanvas(columns * size, Math.ceil(unique.length / columns) * size);
    const output = image.getContext("2d") as SkinContext | null;
    if (!output) throw new Error("Skin conversion needs a 2D canvas.");
    unique.forEach((pixels, i) => {
      const data = output.createImageData(size, size);
      data.data.set(new Uint8ClampedArray(pixels.buffer));
      output.putImageData(data, i % columns * size, Math.floor(i / columns) * size);
    });
    return { image, tiles, tile: size };
  } finally { scratch.width = 0; }
}
