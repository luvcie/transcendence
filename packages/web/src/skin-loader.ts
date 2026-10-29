import type { SkinDef } from "./skin-catalog";

export interface LoadedSkin { def: SkinDef; image: HTMLImageElement; tile: number }
export const SKIN_CACHE_LIMIT = 96;

export function sheetTile(width: number, height: number, def: SkinDef): number {
  const tile = def.tile || width / 9;
  const rows = def.join ? Math.max(def.join.open, def.join.joined) + 1 : 1;
  if (!Number.isInteger(tile) || tile < 1 || width !== tile * 9 || height < tile * rows
    || height % tile !== 0 || width > 8192 || height > 8192) {
    throw new Error("Image must contain nine equal square columns and all required rows (maximum 8192px).");
  }
  return tile;
}

export function createSkinLoader(makeImage = () => new Image(), timeoutMs = 10_000) {
  const images = new Map<string, { request: Promise<HTMLImageElement>; pending: boolean }>();
  function discard(url: string, request: Promise<HTMLImageElement>) {
    if (images.get(url)?.request === request) images.delete(url);
  }
  function trim() {
    let settled = 0;
    for (const entry of images.values()) if (!entry.pending) settled++;
    for (const [url, entry] of images) {
      if (settled <= SKIN_CACHE_LIMIT) break;
      // In-flight entries remain available for deduplication until they settle.
      if (!entry.pending) { images.delete(url); settled--; }
    }
  }
  function image(url: string): Promise<HTMLImageElement> {
    const cached = images.get(url);
    if (cached) {
      images.delete(url);
      images.set(url, cached);
      return cached.request;
    }
    const request = new Promise<HTMLImageElement>((resolve, reject) => {
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
    const entry = { request, pending: true };
    images.set(url, entry);
    void request.then(() => {
      entry.pending = false;
      trim();
    }, () => discard(url, request));
    return request;
  }
  return async (def: SkinDef): Promise<LoadedSkin | undefined> => {
    if (!def.url) return;
    const request = image(def.url);
    const img = await request;
    try {
      return { def, image: img, tile: sheetTile(img.naturalWidth, img.naturalHeight, def) };
    } catch (error) {
      discard(def.url, request);
      throw error;
    }
  };
}
