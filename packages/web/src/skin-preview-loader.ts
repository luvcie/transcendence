import type { SkinDef } from "./skin-catalog";
import { SKIN_CACHE_LIMIT, type LoadedSkin } from "./skin-loader";
import { isTetrioExportUrl } from "./tetrio-sounds";
import { canPrepareSkin, decodePreparedSkin, prepareSkin, type PreparedSkin } from "./skin-worker-client";

const MAX_PREVIEW_BYTES = 32 * 1024 * 1024;

export function createSkinPreviewLoader(fallback: (def: SkinDef) => Promise<LoadedSkin | undefined>) {
  const cache = new Map<string, { request: Promise<PreparedSkin>; bytes: number }>();
  return async (def: SkinDef): Promise<LoadedSkin | undefined> => {
    if (!def.url || !isTetrioExportUrl(def.url) || !canPrepareSkin()) return fallback(def);
    let entry = cache.get(def.url);
    if (entry) { cache.delete(def.url); cache.set(def.url, entry); }
    else {
      const url = def.url;
      entry = { request: prepareSkin(url), bytes: 0 };
      cache.set(url, entry);
      const current = entry;
      void entry.request.then(preview => {
        current.bytes = preview.blob.size + preview.tiles.byteLength;
        let bytes = 0, settled = 0;
        for (const entry of cache.values()) if (entry.bytes) { bytes += entry.bytes; settled++; }
        for (const [key, entry] of cache) {
          if (settled <= SKIN_CACHE_LIMIT && bytes <= MAX_PREVIEW_BYTES) break;
          if (entry.bytes) { cache.delete(key); bytes -= entry.bytes; settled--; }
        }
      }, () => { if (cache.get(url) === current) cache.delete(url); });
    }
    return { def, ...await decodePreparedSkin(await entry.request), preview: true };
  };
}
