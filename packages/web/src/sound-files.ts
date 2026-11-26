import { ExternalFileCache } from "./external-file";
import { MAX_SOUND_CLIPS, soundUrls, type SoundPack } from "./sound-pack";
import { MAX_TETRIO_EXPORT_BYTES, tetrioClipSource } from "./tetrio-sounds";

export const MAX_CUSTOM_SOUNDS = 12;
export type SoundLoadMode = "custom" | "import";
const MAX_CACHE_BYTES = 64 * 1024 * 1024;
export const MAX_CACHED_PACK_BYTES = 32 * 1024 * 1024;

export const soundClips = new ExternalFileCache("42tris.custom-sound-clips.v1", MAX_CUSTOM_SOUNDS * MAX_SOUND_CLIPS,
  MAX_CACHE_BYTES - MAX_TETRIO_EXPORT_BYTES);
export const soundExports = new ExternalFileCache("42tris.custom-sound-exports.v1", MAX_CUSTOM_SOUNDS * MAX_SOUND_CLIPS,
  MAX_TETRIO_EXPORT_BYTES);

export function soundFileUrls(pack: SoundPack) {
  const clips: string[] = [], exports = pack.tetrioPlus ? [pack.tetrioPlus] : [];
  for (const url of soundUrls(pack)) {
    try {
      const source = tetrioClipSource(url);
      if (source) exports.push(source.url);
      else clips.push(url);
    } catch {}
  }
  return { clips, exports };
}
