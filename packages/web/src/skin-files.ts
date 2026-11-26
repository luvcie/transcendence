import { ExternalFileCache, fetchExternalFile } from "./external-file";
import { MAX_SKIN_EXPORT_BYTES, parseTetrioSkin } from "./tetrio-skins";

export const MAX_CUSTOM_SKINS = 12;
export const skinFiles = new ExternalFileCache("42tris.custom-skins.v1", MAX_CUSTOM_SKINS);
export const skinAnimations = new ExternalFileCache("42tris.custom-skin-animations.v1", MAX_CUSTOM_SKINS);

export function loadSkinExport<T>(url: string, custom: boolean, timeoutMs: number, prepare: (skin: ReturnType<typeof parseTetrioSkin>) => Promise<T>) {
  const read = (bytes: ArrayBuffer) => prepare(parseTetrioSkin(JSON.parse(new TextDecoder().decode(bytes))));
  return custom ? skinFiles.load(url, MAX_SKIN_EXPORT_BYTES, undefined, ({ bytes }) => read(bytes), timeoutMs)
    : fetchExternalFile(url, MAX_SKIN_EXPORT_BYTES, undefined, timeoutMs).then(read);
}
