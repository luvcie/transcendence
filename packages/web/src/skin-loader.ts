import type { SkinDef } from "./skin-catalog";
import { fetchExternalFile } from "./external-file";
import { isTetrioExportUrl } from "./tetrio-sounds";
import { convertTetrioSkin, MAX_SKIN_EXPORT_BYTES, parseTetrioSkin } from "./tetrio-skins";

type SkinImage = HTMLImageElement | HTMLCanvasElement;
export interface LoadedSkin { def: SkinDef; image: SkinImage; tile: number }
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

export function createSkinLoader(makeImage = () => new Image(), timeoutMs = 10_000, makeCanvas = () => document.createElement("canvas")) {
  const images = new Map<string, { request: Promise<SkinImage>; pending: boolean }>();
  function discard(url: string, request: Promise<SkinImage>) {
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
  function image(url: string): Promise<SkinImage> {
    const cached = images.get(url);
    if (cached) {
      images.delete(url);
      images.set(url, cached);
      return cached.request;
    }
    const request = isTetrioExportUrl(url)
      ? fetchExternalFile(url, MAX_SKIN_EXPORT_BYTES, new AbortController().signal, timeoutMs)
        .then(bytes => parseTetrioSkin(JSON.parse(new TextDecoder().decode(bytes))))
        .then(loadImage).then(img => convertTetrioSkin(img, makeCanvas))
      : loadImage(url);
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
      const width = "naturalWidth" in img ? img.naturalWidth : img.width;
      const height = "naturalHeight" in img ? img.naturalHeight : img.height;
      return { def, image: img, tile: sheetTile(width, height, def) };
    } catch (error) {
      discard(def.url, request);
      throw error;
    }
  };
}
