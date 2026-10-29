import { customSkin, type SkinDef } from "./skin-catalog";
import { createSkinLoader, type LoadedSkin } from "./skin-loader";
import { MAX_CUSTOM_SKINS, parseCustomSkinUrl, parseSkinPreferences, removeCustom, resolveSkin, SKIN_STORAGE_KEY, type SkinPreferences } from "./skin-preferences";

export class SkinState {
  preferences: SkinPreferences = { active: "classic", customs: [] };
  loaded?: LoadedSkin;
  message = "Skins are saved on this device.";
  private revision = 0;
  private addRevision = 0;
  constructor(private storage: () => Pick<Storage, "getItem" | "setItem">,
    readonly load: (def: SkinDef) => Promise<LoadedSkin | undefined> = createSkinLoader()) {
    try { this.preferences = parseSkinPreferences(storage().getItem(SKIN_STORAGE_KEY)); }
    catch { this.message = "Saved skins could not be loaded. Using Classic."; }
  }
  private save() {
    try {
      this.storage().setItem(SKIN_STORAGE_KEY, JSON.stringify(this.preferences));
      this.message = "Skins saved on this device.";
    } catch { this.message = "Skin applies for this session; browser storage is unavailable."; }
  }
  async select(active: string, persist = true) {
    const revision = ++this.revision;
    ++this.addRevision;
    this.preferences = { ...this.preferences, active };
    const def = resolveSkin(this.preferences);
    this.preferences.active = def.id;
    this.loaded = undefined;
    if (persist) this.save();
    try {
      const loaded = await this.load(def);
      if (revision === this.revision) this.loaded = loaded;
    } catch (error) {
      if (revision === this.revision) this.message = `${(error as Error).message} Using Classic colors; select again to retry.`;
    }
  }
  async add(raw: string): Promise<boolean> {
    const url = parseCustomSkinUrl(raw);
    if (!url) { this.message = "Paste an HTTPS image link (maximum 512 characters, no credentials)."; return false; }
    if (this.preferences.customs.includes(url)) { this.message = "That link is already saved."; return false; }
    if (this.preferences.customs.length >= MAX_CUSTOM_SKINS) { this.message = "The list is full. Remove a custom skin first."; return false; }
    const revision = ++this.addRevision;
    try {
      const loaded = await this.load(customSkin(url, this.preferences.customs.length));
      if (revision !== this.addRevision) return false;
      ++this.revision;
      this.preferences = { active: `custom:${this.preferences.customs.length}`, customs: [...this.preferences.customs, url] };
      this.loaded = loaded;
      this.save();
      return true;
    } catch (error) {
      if (revision === this.addRevision) this.message = (error as Error).message;
      return false;
    }
  }
  remove(index: number) {
    this.preferences = removeCustom(this.preferences, index);
    return this.select(this.preferences.active);
  }
  cancelPendingAdd() { ++this.addRevision; }
}
