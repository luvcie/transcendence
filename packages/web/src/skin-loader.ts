import type { SkinDef } from "./skin-catalog";
import { isTetrioExportUrl } from "./tetrio-sounds";
import { convertTetrioSkin, MAX_SKIN_EXPORT_BYTES, packedTileSize, tetrioSourceTile } from "./tetrio-skins";
import { canPrepareSkin, decodePreparedSkin, prepareSkin } from "./skin-worker-client";
import { drawTetrioFrame, packSkinFrames } from "./skin-atlas";
import { skinSourceAnimation } from "./skin-animation";
import { loadSkinExport, skinAnimations, skinFiles } from "./skin-files";

type SkinImage = HTMLImageElement | HTMLCanvasElement;
interface SkinSheet { image: SkinImage; connected?: boolean; ghost?: boolean; preview?: boolean; tiles?: Uint16Array; tile?: number; animation?: { frames: number; delay: number; frameEnds?: number[] } }
export interface LoadedSkin extends SkinSheet { def: SkinDef; tile: number }
export type SkinLoad = ((def: SkinDef) => Promise<LoadedSkin | undefined>) & { forget?: (url: string) => void };
export const SKIN_CACHE_LIMIT = 96;
const SKIN_CACHE_BYTES = 64 * 1024 * 1024;

export class SkinCache<T> {
  private entries = new Map<string, { request: Promise<T>; bytes?: number }>();

  constructor(private maxBytes: number, private sizeOf: (value: T) => number) {}

  load(key: string, prepare: () => Promise<T>): Promise<T> {
    const cached = this.entries.get(key);
    if (cached) {
      this.entries.delete(key);
      this.entries.set(key, cached);
      return cached.request;
    }
    const entry: { request: Promise<T>; bytes?: number } = { request: prepare() };
    this.entries.set(key, entry);
    void entry.request.then(value => {
      entry.bytes = this.sizeOf(value);
      let settled = 0, bytes = 0;
      for (const item of this.entries.values()) if (item.bytes !== undefined) { settled++; bytes += item.bytes; }
      for (const [key, item] of this.entries) {
        if (settled <= SKIN_CACHE_LIMIT && bytes <= this.maxBytes) break;
        if (item.bytes !== undefined) { this.entries.delete(key); settled--; bytes -= item.bytes; }
      }
    }, () => this.forget(key, entry.request));
    return entry.request;
  }

  forget(key: string, request?: Promise<T>) {
    if (!request || this.entries.get(key)?.request === request) this.entries.delete(key);
  }
}

export function sheetTile(width: number, height: number, def: SkinDef): number {
  const tile = def.tile || width / 9;
  const rows = def.join ? Math.max(def.join.open, def.join.joined) + 1 : 1;
  if (!Number.isInteger(tile) || tile < 1 || width !== tile * 9 || height < tile * rows
    || height % tile !== 0 || width > 8192 || height > 8192) {
    throw new Error("Image must contain nine equal square columns and all required rows (maximum 8192px).");
  }
  return tile;
}

export function createSkinLoader(makeImage = () => new Image(), timeoutMs = 10_000, makeCanvas = () => document.createElement("canvas")): SkinLoad {
  const images = new SkinCache<SkinSheet>(SKIN_CACHE_BYTES, ({ image, tiles }) => {
    const pixels = "naturalWidth" in image ? image.naturalWidth * image.naturalHeight : image.width * image.height;
    return pixels * 4 + (tiles?.byteLength ?? 0);
  });
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
    }).then(async img => { await img.decode?.(); return img; });
  }
  function requestSheet(url: string, def: SkinDef, custom: boolean): Promise<SkinSheet> {
    if (!isTetrioExportUrl(url)) {
      if (!custom) return loadImage(url).then(image => ({ image, ghost: true }));
      return skinFiles.load(url, MAX_SKIN_EXPORT_BYTES, undefined, async ({ bytes, type }) => {
        const local = URL.createObjectURL(new Blob([bytes], { type }));
        try {
          const image = await loadImage(local + new URL(url).hash);
          sheetTile(image.naturalWidth, image.naturalHeight, def);
          return { image, ghost: true };
        } finally { URL.revokeObjectURL(local); }
      }, timeoutMs);
    }
    if (canPrepareSkin()) {
      return prepareSkin(url, custom).then(prepared => decodePreparedSkin(prepared).catch(async error => {
        if (custom) await Promise.all([skinFiles.remove(url), skinAnimations.remove(url)]);
        throw error;
      }));
    }
    return loadSkinExport(url, custom, timeoutMs, async data => {
      const img = await loadImage(data.image);
      let ghost: HTMLImageElement | undefined;
      try {
        if (data.ghost) ghost = await loadImage(data.ghost);
        if (data.frames === 1) return { image: convertTetrioSkin(img, makeCanvas, ghost), connected: true, ghost: !!ghost };
        const source = await skinSourceAnimation(url, data.frames, custom);
        const width = img.naturalWidth / Math.min(data.frames, 16);
        const tile = packedTileSize(tetrioSourceTile(width), data.frames);
        const sheet = await packSkinFrames(data.frames, async (ctx, frame) => {
          if (frame) await new Promise(resolve => setTimeout(resolve, 0));
          drawTetrioFrame(ctx, img, width, frame, data.frames, tile, ghost);
        }, (width, height) => { const canvas = makeCanvas(); canvas.width = width; canvas.height = height; return canvas; }, tile);
        return { ...sheet, connected: true, ghost: !!ghost,
          animation: { frames: data.frames, delay: data.delay, frameEnds: source?.frameEnds } };
      } finally { img.src = ""; if (ghost) ghost.src = ""; }
    });
  }
  const load = async (def: SkinDef): Promise<LoadedSkin | undefined> => {
    if (!def.url) return;
    const url = def.url, custom = def.id.startsWith("custom:"), key = custom ? `custom:${url}` : url;
    const request = images.load(key, () => requestSheet(url, def, custom));
    const sheet = await request, img = sheet.image;
    try {
      const width = "naturalWidth" in img ? img.naturalWidth : img.width;
      const height = "naturalHeight" in img ? img.naturalHeight : img.height;
      return { def, ...sheet, tile: sheet.tile ?? sheetTile(width, height, def) };
    } catch (error) {
      images.forget(key, request);
      if (custom) await skinFiles.remove(url);
      throw error;
    }
  };
  return Object.assign(load, { forget: (url: string) => images.forget(`custom:${url}`) });
}
