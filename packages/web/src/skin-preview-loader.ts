import type { SkinDef } from "./skin-catalog";
import { SkinCache, type LoadedSkin } from "./skin-loader";
import { isTetrioExportUrl } from "./tetrio-sounds";
import { canPrepareSkin, decodePreparedSkin, prepareSkin, type PreparedSkin } from "./skin-worker-client";

const MAX_PREVIEW_BYTES = 32 * 1024 * 1024;

export function createSkinPreviewLoader(fallback: (def: SkinDef) => Promise<LoadedSkin | undefined>) {
  const cache = new SkinCache<PreparedSkin>(MAX_PREVIEW_BYTES, preview => preview.blob.size + preview.tiles.byteLength);
  return async (def: SkinDef): Promise<LoadedSkin | undefined> => {
    const url = def.url;
    if (!url || def.id.startsWith("custom:") || !isTetrioExportUrl(url) || !canPrepareSkin()) return fallback(def);
    const prepared = await cache.load(url, () => prepareSkin(url));
    return { def, ...await decodePreparedSkin(prepared), preview: true };
  };
}
