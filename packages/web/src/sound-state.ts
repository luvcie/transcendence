import { BUILTIN_SOUNDS, SILENT, type SoundDef } from "./sound-catalog";
import { MAX_PACK_LENGTH, parseSoundPack, soundUrl, type SoundPack } from "./sound-pack";
import type { LoadedSounds } from "./sound-player";
import { fetchExternalFile } from "./external-file";
import { isTetrioExportUrl } from "./tetrio-sounds";

export const SOUND_STORAGE_KEY = "42tris.sounds.v1";
export const MAX_CUSTOM_SOUNDS = 12;
export interface CustomSound { pack: SoundPack; url?: string }
export interface SoundPreferences { active: string; enabled: boolean; volume: number; customs: CustomSound[] }
export function customSound(custom: CustomSound, index: number): SoundDef {
  return { id: `custom:${index}`, label: custom.pack.name, pack: custom.pack, source: custom.url };
}
export function resolveSound(preferences: SoundPreferences): SoundDef {
  return BUILTIN_SOUNDS.find(def => def.id === preferences.active)
    ?? preferences.customs.map(customSound).find(def => def.id === preferences.active) ?? SILENT;
}
export function parseSoundPreferences(raw: string | null): SoundPreferences {
  const defaults: SoundPreferences = { active: "silent", enabled: true, volume: 0.5, customs: [] };
  try {
    if (!raw || raw.length > MAX_PACK_LENGTH * MAX_CUSTOM_SOUNDS + 4096) return defaults;
    const data = JSON.parse(raw);
    if (!data || typeof data.active !== "string" || typeof data.enabled !== "boolean" || typeof data.volume !== "number"
      || !Number.isFinite(data.volume) || data.volume < 0 || data.volume > 1 || !Array.isArray(data.customs) || data.customs.length > MAX_CUSTOM_SOUNDS) return defaults;
    const customs = data.customs.map((custom: CustomSound) => ({ pack: parseSoundPack(custom.pack), ...(custom.url ? { url: soundUrl(custom.url) } : {}) }));
    const preferences = { active: data.active, enabled: data.enabled, volume: data.volume, customs };
    preferences.active = resolveSound(preferences).id;
    return preferences;
  } catch { return defaults; }
}

export class SoundState {
  preferences: SoundPreferences;
  loaded?: LoadedSounds;
  message = "Sounds are saved on this device.";
  changed = () => {};
  private selection?: AbortController;
  private addition?: AbortController;
  constructor(private storage: () => Pick<Storage, "getItem" | "setItem">,
    readonly load: (pack: SoundPack, signal: AbortSignal) => Promise<LoadedSounds>) {
    this.preferences = parseSoundPreferences(null);
    try { this.preferences = parseSoundPreferences(storage().getItem(SOUND_STORAGE_KEY)); }
    catch { this.message = "Saved sounds could not be loaded. Using Silent."; }
  }
  private save() {
    try { this.storage().setItem(SOUND_STORAGE_KEY, JSON.stringify(this.preferences)); this.message = "Sounds saved on this device."; }
    catch { this.message = "Sounds apply for this session; browser storage is unavailable."; }
  }
  configure(value: Partial<Pick<SoundPreferences, "volume" | "enabled">>) {
    Object.assign(this.preferences, value); this.save(); this.changed();
  }
  async select(active: string, persist = true) {
    this.selection?.abort(); this.cancelPendingAdd();
    const request = this.selection = new AbortController();
    this.preferences.active = active;
    const def = resolveSound(this.preferences);
    this.preferences.active = def.id;
    this.loaded = undefined;
    if (persist) this.save();
    const savedMessage = this.message;
    this.message = def.id === "silent" ? savedMessage : `Loading ${def.label}…`;
    this.changed();
    try {
      const loaded = await this.load(def.pack, request.signal);
      if (request.signal.aborted) return;
      this.loaded = loaded;
      this.message = loaded.failed ? `${def.label}: ${loaded.failed} audio files could not be loaded; the remaining sounds are ready. Select again to retry.` : savedMessage;
    } catch (error) {
      if (request.signal.aborted) return;
      this.message = `${(error as Error).message} Using silence; select again to retry.`;
    }
    this.changed();
  }
  async add(raw: string): Promise<boolean> {
    this.cancelPendingAdd();
    const request = this.addition = new AbortController();
    try {
      if (this.preferences.customs.length >= MAX_CUSTOM_SOUNDS) throw new Error("The list is full. Remove a custom pack first.");
      const text = raw.trim();
      let json = text, url: string | undefined;
      if (!text.startsWith("{")) {
        url = soundUrl(text);
        if (isTetrioExportUrl(url)) {
          const name = decodeURIComponent(new URL(url).pathname.split("/").pop()!).replace(/(?:\.zip)?\.tpse$|\.zip$/i, "").replaceAll("_", " ");
          json = JSON.stringify({ name, tetrioPlus: url });
        } else {
          const bytes = await fetchExternalFile(url, MAX_PACK_LENGTH, request.signal);
          json = new TextDecoder().decode(bytes);
        }
      }
      if (json.length > MAX_PACK_LENGTH) throw new Error("Use a JSON pack smaller than 64 KB.");
      let data: unknown;
      try { data = JSON.parse(json); } catch { throw new Error("Invalid JSON. Paste a JSON object with quoted keys and no comments."); }
      const pack = parseSoundPack(data);
      if (url && this.preferences.customs.some(custom => custom.url === url)) throw new Error("That pack is already saved.");
      const loaded = await this.load(pack, request.signal);
      if (request.signal.aborted) return false;
      if (!url && this.preferences.customs.some(custom => JSON.stringify(custom.pack) === JSON.stringify(loaded.pack))) throw new Error("That pack is already saved.");
      this.selection?.abort();
      const index = this.preferences.customs.length;
      this.preferences.customs.push({ pack: loaded.pack, ...(url ? { url } : {}) });
      this.preferences.active = `custom:${index}`;
      this.preferences.enabled = true;
      this.loaded = loaded;
      this.save();
      if (loaded.failed) this.message += ` ${loaded.failed} audio files could not be loaded.`;
      this.changed();
      return true;
    } catch (error) {
      if (!request.signal.aborted) { this.message = (error as Error).message; this.changed(); }
      return false;
    }
  }
  remove(index: number) {
    const selected = resolveSound(this.preferences).pack;
    this.preferences.customs.splice(index, 1);
    if (this.preferences.active.startsWith("custom:")) {
      const next = this.preferences.customs.findIndex(custom => custom.pack === selected);
      this.preferences.active = next < 0 ? "silent" : `custom:${next}`;
    }
    return this.select(this.preferences.active);
  }
  cancelPendingAdd() { this.addition?.abort(); }
}
