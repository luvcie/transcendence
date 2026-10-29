import { BUILTIN_SKINS, CLASSIC, customSkin } from "./skin-catalog";

export interface SkinPreferences { active: string; customs: string[] }
export const SKIN_STORAGE_KEY = "42tris.skins.v1";
export const MAX_CUSTOM_SKINS = 12;

export function parseCustomSkinUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  const text = value.trim();
  if (text.length > 512) return;
  try {
    const url = new URL(text);
    if (url.protocol === "https:" && !url.username && !url.password && url.href.length <= 512) return url.href;
  } catch { /* Invalid user input. */ }
}

export function resolveSkin(settings: SkinPreferences) {
  const builtin = BUILTIN_SKINS.find(def => def.id === settings.active);
  if (builtin) return builtin;
  const index = settings.customs.findIndex((_, i) => `custom:${i}` === settings.active);
  return index < 0 ? CLASSIC : customSkin(settings.customs[index], index);
}

export function parseSkinPreferences(raw: string | null): SkinPreferences {
  const defaults = { active: "classic", customs: [] };
  try {
    const value = JSON.parse(raw ?? "null");
    if (!value || typeof value.active !== "string" || !Array.isArray(value.customs)
      || value.customs.length > MAX_CUSTOM_SKINS) return defaults;
    const customs = value.customs.map(parseCustomSkinUrl);
    if (customs.some((url: string | undefined) => !url) || new Set(customs).size !== customs.length) return defaults;
    const settings = { active: value.active, customs: customs as string[] };
    settings.active = resolveSkin(settings).id;
    return settings;
  } catch { return defaults; }
}

export function removeCustom(settings: SkinPreferences, index: number): SkinPreferences {
  const selectedUrl = resolveSkin(settings).url;
  const customs = settings.customs.filter((_, i) => i !== index);
  const active = settings.active.startsWith("custom:")
    ? (customs.includes(selectedUrl!) ? `custom:${customs.indexOf(selectedUrl!)}` : "classic")
    : settings.active;
  return { active, customs };
}
