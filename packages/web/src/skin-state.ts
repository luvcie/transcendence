import { releaseSkinTiles } from "./tile-cache";
import { customSkin, type SkinDef } from "./skin-catalog";
import { createSkinLoader, type LoadedSkin, type SkinLoad } from "./skin-loader";
import { parseCustomSkinUrl, parseSkinPreferences, removeCustom, resolveSkin, SKIN_STORAGE_KEY, type SkinPreferences } from "./skin-preferences";
import { MAX_CUSTOM_SKINS, skinAnimations, skinFiles } from "./skin-files";
import { updatePreferences, withPreferenceLock } from "./preference-storage";

export class SkinState {
  preferences: SkinPreferences = { active: "classic", customs: [] };
  loaded?: LoadedSkin;
  message = "Skins are saved on this device.";
  private revision = 0;
  private addRevision = 0;
  private pendingUrl?: string;
  readonly load = async (def: SkinDef) => {
    try { return await this.loadSkin(def); }
    finally {
      if (def.id.startsWith("custom:") && def.url && this.forgetUnsaved(def.url)) await this.pruneFiles();
    }
  };
  constructor(private storage: () => Pick<Storage, "getItem" | "setItem">,
    private loadSkin: SkinLoad = createSkinLoader()) {
    try {
      this.preferences = parseSkinPreferences(storage().getItem(SKIN_STORAGE_KEY));
      void this.pruneFiles();
    }
    catch { this.message = "Saved skins could not be loaded. Using Classic."; }
  }
  private forgetUnsaved(url: string) {
    if (url === this.pendingUrl || this.preferences.customs.includes(url)) return false;
    this.loadSkin.forget?.(url);
    return true;
  }
  private pruneFiles() {
    const urls = () => parseSkinPreferences(this.storage().getItem(SKIN_STORAGE_KEY)).customs;
    return Promise.all([skinFiles.retain(urls), skinAnimations.retain(urls)]);
  }
  private save(change: (preferences: SkinPreferences) => SkinPreferences) {
    const { preferences, saved } = updatePreferences(this.storage, SKIN_STORAGE_KEY, parseSkinPreferences, this.preferences, change);
    this.message = saved ? "Skins saved on this device." : "Skin applies for this session; browser storage is unavailable.";
    return preferences;
  }
  select(active: string, persist = true) {
    const def = resolveSkin({ ...this.preferences, active });
    return this.choose(def, persist ? preferences => {
      if (!def.id.startsWith("custom:")) return { ...preferences, active: def.id };
      const index = preferences.customs.indexOf(def.url!);
      return index < 0 ? preferences : { ...preferences, active: `custom:${index}` };
    } : undefined);
  }
  private async choose(def: SkinDef, change?: (preferences: SkinPreferences) => SkinPreferences) {
    const revision = ++this.revision;
    this.cancelPendingAdd();
    this.preferences = { ...this.preferences, active: def.id };
    releaseSkinTiles(this.loaded);
    this.loaded = undefined;
    const saving = change && withPreferenceLock(SKIN_STORAGE_KEY, () => { this.save(change); });
    if (saving) await saving;
    if (revision !== this.revision) return;
    try {
      const loaded = await this.load(def);
      if (revision === this.revision) this.loaded = loaded;
    } catch (error) {
      if (revision === this.revision) this.message = `${(error as Error).message} Using Classic colors; select again to retry.`;
    }
  }
  async add(raw: string): Promise<boolean> {
    const url = parseCustomSkinUrl(raw);
    if (!url) { this.message = "Paste an HTTPS image or .tpse link (maximum 512 characters, no credentials)."; return false; }
    let latest = this.preferences;
    try { latest = parseSkinPreferences(this.storage().getItem(SKIN_STORAGE_KEY)); } catch {}
    if (latest.customs.includes(url)) { this.message = "That link is already saved."; return false; }
    if (latest.customs.length >= MAX_CUSTOM_SKINS) { this.message = "The list is full. Remove a custom skin first."; return false; }
    const revision = ++this.addRevision;
    this.pendingUrl = url;
    try {
      return await skinFiles.duringAdd(() => skinAnimations.duringAdd(async () => {
        if (revision !== this.addRevision) return false;
        const loaded = await this.load(customSkin(url, this.preferences.customs.length));
        return await withPreferenceLock(SKIN_STORAGE_KEY, () => {
          if (revision !== this.addRevision) return false;
          this.preferences = this.save(preferences => {
            if (preferences.customs.includes(url)) throw new Error("That link is already saved.");
            if (preferences.customs.length >= MAX_CUSTOM_SKINS) throw new Error("The list is full. Remove a custom skin first.");
            return { active: `custom:${preferences.customs.length}`, customs: [...preferences.customs, url] };
          });
          ++this.revision;
          releaseSkinTiles(this.loaded);
          this.loaded = loaded && { ...loaded, def: resolveSkin(this.preferences) };
          return true;
        });
      }));
    } catch (error) {
      if (revision === this.addRevision) this.message = (error as Error).message;
      return false;
    } finally {
      if (revision === this.addRevision) this.pendingUrl = undefined;
      this.forgetUnsaved(url);
      await this.pruneFiles();
    }
  }
  async remove(index: number) {
    const url = this.preferences.customs[index];
    if (!url) return;
    this.loadSkin.forget?.(url);
    this.preferences = removeCustom(this.preferences, index);
    await this.choose(resolveSkin(this.preferences), preferences => removeCustom(preferences, preferences.customs.indexOf(url)));
    await this.pruneFiles();
  }
  cancelPendingAdd() { ++this.addRevision; this.pendingUrl = undefined; }
}
