import type { SkinDef } from "./skin-catalog";
import { fetchExternalFile } from "./external-file";
import { isTetrioExportUrl } from "./tetrio-sounds";
import { convertTetrioSkin, MAX_SKIN_EXPORT_BYTES, parseTetrioSkin } from "./tetrio-skins";

type SkinImage = HTMLImageElement | HTMLCanvasElement;
interface SkinSheet { image: SkinImage; connected?: boolean; animation?: { frames: number; delay: number } }
export interface LoadedSkin extends SkinSheet { def: SkinDef; tile: number }
export const SKIN_CACHE_LIMIT = 96;
export const SKIN_CACHE_BYTES = 64 * 1024 * 1024;

export function sheetTile(width: number, height: number, def: SkinDef): number {
  const tile = def.tile || width / 9;
  const rows = def.join ? Math.max(def.join.open, def.join.joined) + 1 : 1;
  if (!Number.isInteger(tile) || tile < 1 || width !== tile * 9 || height < tile * rows
    || height % tile !== 0 || width > 8192 || height > 8192) {
    throw new Error("Image must contain nine equal square columns and all required rows (maximum 8192px).");
  }
  return tile;
}

export function createSkinLoader(makeImage = () => new Image(), timeoutMs = 10_000, makeCanvas = () => document.createElement("canvas")) {
  const images = new Map<string, { request: Promise<SkinSheet>; pending: boolean; bytes: number }>();
  function discard(url: string, request: Promise<SkinSheet>) {
    if (images.get(url)?.request === request) images.delete(url);
  }
  function trim() {
    let settled = 0, bytes = 0;
    for (const entry of images.values()) if (!entry.pending) { settled++; bytes += entry.bytes; }
    for (const [url, entry] of images) {
      if (settled <= SKIN_CACHE_LIMIT && bytes <= SKIN_CACHE_BYTES) break;
      // In-flight entries remain available for deduplication until they settle.
      if (!entry.pending) { images.delete(url); settled--; bytes -= entry.bytes; }
    }
  }
  function loadImage(url: string): Promise<HTMLImageElement> {
    return new Promise<HTMLImageElement>((resolve, reject) => {
      const img = makeImage();
      const finish = (error?: Error) => {
        clearTimeout(timer);
        img.onload = img.onerror = null;
        if (error) { img.src = ""; reject(error); }
        else resolve(img);
      };
      const timer = setTimeout(() => finish(new Error("Skin image timed out. Try again.")), timeoutMs);
      img.decoding = "async";
      img.crossOrigin = "anonymous";
      img.onload = () => finish();
      img.onerror = () => finish(new Error("Skin image could not load. Check the link or try again."));
      img.src = url;
    });
  }
  function image(url: string): Promise<SkinSheet> {
    const cached = images.get(url);
    if (cached) {
      images.delete(url);
      images.set(url, cached);
      return cached.request;
    }
    const request = isTetrioExportUrl(url)
      ? fetchExternalFile(url, MAX_SKIN_EXPORT_BYTES, new AbortController().signal, timeoutMs)
        .then(bytes => parseTetrioSkin(JSON.parse(new TextDecoder().decode(bytes))))
        .then(async data => ({ image: convertTetrioSkin(await loadImage(data.image), makeCanvas, data.frames), connected: true,
          ...(data.frames > 1 ? { animation: { frames: data.frames, delay: data.delay } } : {}) }))
      : loadImage(url).then(image => ({ image }));
    const entry = { request, pending: true, bytes: 0 };
    images.set(url, entry);
    void request.then(({ image }) => {
      entry.pending = false;
      entry.bytes = ("naturalWidth" in image ? image.naturalWidth * image.naturalHeight : image.width * image.height) * 4;
      trim();
    }, () => discard(url, request));
    return request;
  }
  return async (def: SkinDef): Promise<LoadedSkin | undefined> => {
    if (!def.url) return;
    const request = image(def.url);
    const sheet = await request, img = sheet.image;
    try {
      const width = "naturalWidth" in img ? img.naturalWidth : img.width;
      const height = "naturalHeight" in img ? img.naturalHeight : img.height;
      const columns = Math.min(sheet.animation?.frames ?? 1, 16);
      return { def, ...sheet, tile: sheetTile(width / columns, height, def) };
    } catch (error) {
      discard(def.url, request);
      throw error;
    }
  };
}
