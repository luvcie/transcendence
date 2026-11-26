import { BUILTIN_SOUNDS, SILENT, type SoundDef } from "./sound-catalog";
import { fetchExternalFile } from "./external-file";
import { MAX_PACK_LENGTH, parseSoundPack, soundUrl, type SoundPack } from "./sound-pack";
import type { LoadedSounds } from "./sound-player";
import { isTetrioExportUrl } from "./tetrio-sounds";
import { MAX_CUSTOM_SOUNDS, soundClips, soundExports, soundFileUrls, type SoundLoadMode } from "./sound-files";
import { updatePreferences, withPreferenceLock } from "./preference-storage";

export const SOUND_STORAGE_KEY = "42tris.sounds.v1";
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
      || !Number.isFinite(data.volume) || data.volume < 0 || data.volume > 2 || !Array.isArray(data.customs) || data.customs.length > MAX_CUSTOM_SOUNDS) return defaults;
    const customs = data.customs.map((custom: CustomSound) => ({ pack: parseSoundPack(custom.pack), ...(custom.url ? { url: soundUrl(custom.url) } : {}) }));
    const preferences = { active: data.active, enabled: data.enabled, volume: data.volume, customs };
    preferences.active = resolveSound(preferences).id;
    return preferences;
  } catch { return defaults; }
}

function soundIndex(preferences: SoundPreferences, target: CustomSound) {
  return preferences.customs.findIndex(custom => target.url
    ? custom.url === target.url
    : !custom.url && JSON.stringify(custom.pack) === JSON.stringify(target.pack));
}

function removeSound(preferences: SoundPreferences, target: CustomSound): SoundPreferences {
  const index = soundIndex(preferences, target);
  if (index < 0) return preferences;
  const selected = Number(preferences.active.slice(7));
  const active = !preferences.active.startsWith("custom:") || selected < index ? preferences.active
    : selected === index ? "silent" : `custom:${selected - 1}`;
  return { ...preferences, active, customs: preferences.customs.filter((_, i) => i !== index) };
}

export class SoundState {
  preferences: SoundPreferences;
  loaded?: LoadedSounds;
  message = "Sounds are saved on this device.";
  changed = () => {};
  private selection?: AbortController;
  private addition?: AbortController;
  constructor(private storage: () => Pick<Storage, "getItem" | "setItem">,
    readonly load: (pack: SoundPack, signal: AbortSignal, mode?: SoundLoadMode) => Promise<LoadedSounds>) {
    this.preferences = parseSoundPreferences(null);
    try {
      this.preferences = parseSoundPreferences(storage().getItem(SOUND_STORAGE_KEY));
      void this.pruneFiles();
    }
    catch { this.message = "Saved sounds could not be loaded. Using Silent."; }
  }
  private pruneFiles() {
    const customs = () => parseSoundPreferences(this.storage().getItem(SOUND_STORAGE_KEY)).customs;
    return Promise.all([
      soundClips.retain(() => customs().flatMap(({ pack }) => soundFileUrls(pack).clips)),
      soundExports.retain(() => customs().flatMap(({ pack }) => soundFileUrls(pack).exports)),
    ]);
  }
  private save(change: (preferences: SoundPreferences) => SoundPreferences) {
    const { preferences, saved } = updatePreferences(this.storage, SOUND_STORAGE_KEY, parseSoundPreferences, this.preferences, change);
    this.message = saved ? "Sounds saved on this device." : "Sounds apply for this session; browser storage is unavailable.";
    return preferences;
  }
  configure(value: Partial<Pick<SoundPreferences, "volume" | "enabled">>, persist = true) {
    Object.assign(this.preferences, value);
    this.changed();
    if (persist) return withPreferenceLock(SOUND_STORAGE_KEY, () => {
      this.save(preferences => ({ ...preferences, ...value }));
      this.changed();
    });
  }
  select(active: string, persist = true) {
    const def = resolveSound({ ...this.preferences, active });
    const custom = def.id.startsWith("custom:") ? this.preferences.customs[Number(def.id.slice(7))] : undefined;
    return this.choose(def, persist ? preferences => {
      const index = custom ? soundIndex(preferences, custom) : -1;
      return custom && index < 0 ? preferences : { ...preferences, active: custom ? `custom:${index}` : def.id };
    } : undefined);
  }
  private async choose(def: SoundDef, change?: (preferences: SoundPreferences) => SoundPreferences) {
    this.selection?.abort(); this.cancelPendingAdd();
    const request = this.selection = new AbortController();
    this.preferences.active = def.id;
    this.loaded = undefined;
    const saving = change && withPreferenceLock(SOUND_STORAGE_KEY, () => { this.save(change); });
    if (saving) await saving;
    if (request.signal.aborted) return;
    const savedMessage = this.message;
    this.message = def.id === "silent" ? savedMessage : `Loading ${def.label}…`;
    this.changed();
    try {
      const loaded = await this.load(def.pack, request.signal, def.id.startsWith("custom:") ? "custom" : undefined);
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
    const prepare = (data: unknown) => this.load(parseSoundPack(data), request.signal, "import");
    const prepareJson = (json: string) => {
      if (json.length > MAX_PACK_LENGTH) throw new Error("Use a JSON pack smaller than 64 KB.");
      let data: unknown;
      try { data = JSON.parse(json); } catch { throw new Error("Invalid JSON. Paste a JSON object with quoted keys and no comments."); }
      return prepare(data);
    };
    try {
      return await soundClips.duringAdd(() => soundExports.duringAdd(async () => {
        request.signal.throwIfAborted();
        const text = raw.trim();
        const url = text.startsWith("{") ? undefined : soundUrl(text);
        let latest = this.preferences;
        try { latest = parseSoundPreferences(this.storage().getItem(SOUND_STORAGE_KEY)); } catch {}
        if (latest.customs.length >= MAX_CUSTOM_SOUNDS) throw new Error("The list is full. Remove a custom pack first.");
        if (url && latest.customs.some(custom => custom.url === url)) throw new Error("That pack is already saved.");
        let loaded: LoadedSounds;
        if (!url) loaded = await prepareJson(text);
        else if (isTetrioExportUrl(url)) {
          const name = decodeURIComponent(new URL(url).pathname.split("/").pop()!).replace(/(?:\.zip)?\.tpse$|\.zip$/i, "").replaceAll("_", " ");
          loaded = await prepare({ name, tetrioPlus: url });
        } else {
          const bytes = await fetchExternalFile(url, MAX_PACK_LENGTH, request.signal);
          loaded = await prepareJson(new TextDecoder().decode(bytes));
        }
        return await withPreferenceLock(SOUND_STORAGE_KEY, () => {
          if (request.signal.aborted) return false;
          const target = { pack: loaded.pack, ...(url ? { url } : {}) };
          const { active, customs, enabled } = this.save(preferences => {
            if (preferences.customs.length >= MAX_CUSTOM_SOUNDS) throw new Error("The list is full. Remove a custom pack first.");
            if (preferences.customs.some(custom => url ? custom.url === url : JSON.stringify(custom.pack) === JSON.stringify(target.pack))) {
              throw new Error("That pack is already saved.");
            }
            return { ...preferences, active: `custom:${preferences.customs.length}`, enabled: true, customs: [...preferences.customs, target] };
          });
          this.selection?.abort();
          Object.assign(this.preferences, { active, customs, enabled });
          this.loaded = loaded;
          if (loaded.failed) this.message += ` ${loaded.failed} audio files could not be loaded.`;
          this.changed();
          return true;
        });
      }));
    } catch (error) {
      if (!request.signal.aborted) { this.message = (error as Error).message; this.changed(); }
      return false;
    } finally {
      if (this.addition === request) this.addition = undefined;
      await this.pruneFiles();
    }
  }
  async remove(index: number) {
    const target = this.preferences.customs[index];
    if (!target) return;
    this.preferences = removeSound(this.preferences, target);
    await this.choose(resolveSound(this.preferences), preferences => removeSound(preferences, target));
    await this.pruneFiles();
  }
  cancelPendingAdd() { this.addition?.abort(); }
}
