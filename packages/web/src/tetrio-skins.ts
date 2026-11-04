export const MAX_SKIN_EXPORT_BYTES = 8 * 1024 * 1024;

export function parseTetrioSkin(value: unknown): string {
  if (!value || typeof value !== "object") throw new Error("Invalid TETR.IO+ skin export.");
  const data = value as Record<string, unknown>;
  if (data.skinAnim != null || data.skinAnimMeta != null) throw new Error("Animated TETR.IO+ skins are not supported.");
  if (typeof data.skin !== "string" || data.skin.length > MAX_SKIN_EXPORT_BYTES
    || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(data.skin)) {
    throw new Error("This export does not contain a static PNG skin.");
  }
  const header = atob(data.skin.slice(data.skin.indexOf(",") + 1, data.skin.indexOf(",") + 33));
  if (header.length < 24 || header.slice(0, 8) !== "\x89PNG\r\n\x1a\n" || header.slice(12, 16) !== "IHDR") throw new Error("Invalid skin PNG header.");
  const bytes = Uint8Array.from(header, char => char.charCodeAt(0));
  const view = new DataView(bytes.buffer);
  const width = view.getUint32(16), height = view.getUint32(20);
  if (width !== height || width < 64 || width > 2048 || width % 64) throw new Error("Use a square TETR.IO+ atlas, up to 2048px and divisible by 64.");
  return data.skin;
}

export function convertTetrioSkin(image: HTMLImageElement, makeCanvas = () => document.createElement("canvas")): HTMLCanvasElement {
  const width = image.naturalWidth;
  if (width !== image.naturalHeight || width < 64 || width > 2048 || width % 64) throw new Error("Unsupported TETR.IO+ skin atlas dimensions.");
  const cell = width * 3 / 64, padding = width >= 2048 ? 2 : 1;
  const tile = cell - padding * 2;
  const canvas = makeCanvas();
  canvas.width = tile * 9; canvas.height = tile;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Skin conversion needs a 2D canvas.");
  ctx.imageSmoothingEnabled = false;
  // TETR.IO+ normalized atlases: isolated Z, L, O, S, I, J, T blocks, excluding texture padding.
  const cells = [[0, 3], [4, 3], [8, 3], [12, 3], [0, 9], [4, 9], [8, 9]];
  cells.forEach(([x, y], i) => ctx.drawImage(image, x * cell + padding, y * cell + padding,
    tile, tile, (i + 2) * tile, 0, tile, tile));
  return canvas;
}
