import type { SkinDef } from "./skin-catalog";
import { SKIN_CACHE_LIMIT, type LoadedSkin } from "./skin-loader";
import { isTetrioExportUrl } from "./tetrio-sounds";

interface Preview { blob: Blob; frames: number; delay: number }
const MAX_PREVIEW_BYTES = 32 * 1024 * 1024;

function prepare(url: string): Promise<Preview> {
  const worker = new Worker(new URL("./skin-preview-worker.ts", import.meta.url), { type: "module" });
  let timer: ReturnType<typeof setTimeout>;
  return new Promise<Preview>((resolve, reject) => {
    timer = setTimeout(() => reject(new Error("Skin preview timed out. Try again.")), 20_000);
    worker.onmessage = ({ data }: MessageEvent<Preview | { error: string }>) => {
      if ("error" in data) reject(new Error(data.error));
      else resolve(data);
    };
    worker.onerror = () => reject(new Error("Skin preview could not load. Try again."));
    worker.onmessageerror = () => reject(new Error("Skin preview could not be read. Try again."));
    worker.postMessage(url);
  }).finally(() => { clearTimeout(timer); worker.terminate(); });
}

export function createSkinPreviewLoader(fallback: (def: SkinDef) => Promise<LoadedSkin | undefined>) {
  const cache = new Map<string, { request: Promise<Preview>; bytes: number }>();
  return async (def: SkinDef): Promise<LoadedSkin | undefined> => {
    if (!def.url || !isTetrioExportUrl(def.url) || typeof Worker === "undefined"
      || typeof OffscreenCanvas === "undefined" || typeof createImageBitmap === "undefined") return fallback(def);
    let entry = cache.get(def.url);
    if (entry) { cache.delete(def.url); cache.set(def.url, entry); }
    else {
      const url = def.url;
      entry = { request: prepare(url), bytes: 0 };
      cache.set(url, entry);
      const current = entry;
      void entry.request.then(preview => {
        current.bytes = preview.blob.size;
        let bytes = 0, settled = 0;
        for (const entry of cache.values()) if (entry.bytes) { bytes += entry.bytes; settled++; }
        for (const [key, entry] of cache) {
          if (settled <= SKIN_CACHE_LIMIT && bytes <= MAX_PREVIEW_BYTES) break;
          if (entry.bytes) { cache.delete(key); bytes -= entry.bytes; settled--; }
        }
      }, () => { if (cache.get(url) === current) cache.delete(url); });
    }
    const preview = await entry.request;
    const url = URL.createObjectURL(preview.blob), image = new Image();
    try {
      image.decoding = "async";
      image.src = url;
      await image.decode();
      return { def, image, tile: 32, preview: true,
        ...(preview.frames > 1 ? { animation: { frames: preview.frames, delay: preview.delay } } : {}) };
    } finally { URL.revokeObjectURL(url); }
  };
}
