import { BUILTIN_SKINS, CLASSIC, type SkinDef } from "./skin-catalog";
import type { LoadedSkin } from "./skin-loader";

export type MultiplayerSkinMode = "player" | "local";
export const MULTIPLAYER_SKIN_STORAGE_KEY = "42tris.multiplayerSkins";
export const MULTIPLAYER_SKIN_RETRY_MS = 15_000;

export function parseMultiplayerSkinMode(raw: string | null | undefined): MultiplayerSkinMode {
  return raw === "local" ? "local" : "player";
}

/** Built-in ids are public and stable; custom links stay on the device that owns them. */
export function shareableSkinId(active: string): string {
  return BUILTIN_SKINS.some(def => def.id === active) ? active : CLASSIC.id;
}

export function skinDefForId(id: string | null | undefined): SkinDef {
  return BUILTIN_SKINS.find(def => def.id === id) ?? CLASSIC;
}

export class MultiplayerSkinPreference {
  mode: MultiplayerSkinMode = "player";
  constructor(private storage: () => Pick<Storage, "getItem" | "setItem"> = () => localStorage) {
    try { this.mode = parseMultiplayerSkinMode(this.storage().getItem(MULTIPLAYER_SKIN_STORAGE_KEY)); }
    catch { /* Defaults apply when storage is unavailable. */ }
  }
  set(mode: MultiplayerSkinMode): void {
    this.mode = mode;
    try { this.storage().setItem(MULTIPLAYER_SKIN_STORAGE_KEY, mode); }
    catch { /* The choice still applies for this session. */ }
  }
}

export function setupMultiplayerSkinSetting(preference: MultiplayerSkinPreference): void {
  const select = document.querySelector<HTMLSelectElement>("#multiplayer-skins");
  if (!select) return;
  select.value = preference.mode;
  select.addEventListener("change", () => preference.set(parseMultiplayerSkinMode(select.value)));
}

export interface MultiplayerSkinPlayer { playerId: string; skin?: string | null }

/**
 * Resolve one skin per board without touching Match state. The viewer's own
 * board keeps the locally loaded sheet (which may be a device-only custom
 * image), while every other board resolves through the shared built-in id.
 */
export function playerSkinAssignments(roster: readonly string[], players: readonly MultiplayerSkinPlayer[],
  viewerId: string, viewerSkin: LoadedSkin | undefined, mode: MultiplayerSkinMode,
  resolve: (skin: string | undefined) => LoadedSkin | undefined): Map<string, LoadedSkin | undefined> {
  const shared = new Map(players.map(player => [player.playerId, player.skin ?? undefined]));
  const assignments = new Map<string, LoadedSkin | undefined>();
  for (const id of roster) {
    assignments.set(id, mode === "local" || id === viewerId ? viewerSkin : resolve(shared.get(id)));
  }
  return assignments;
}

/** Loads each remote skin once. Failures retry after a cooldown, never per frame. */
export class MultiplayerSkinResolver {
  private loaded = new Map<string, LoadedSkin>();
  private failed = new Map<string, number>();
  private pending = new Set<string>();
  constructor(private load: (def: SkinDef) => Promise<LoadedSkin | undefined>,
    private changed: () => void = () => {},
    private now: () => number = () => performance.now()) {}
  get(id: string | null | undefined): LoadedSkin | undefined {
    const def = skinDefForId(id);
    if (!def.url) return undefined;
    const loaded = this.loaded.get(def.id);
    if (loaded) return loaded;
    if (this.pending.has(def.id)) return undefined;
    const failedAt = this.failed.get(def.id);
    if (failedAt !== undefined && this.now() - failedAt < MULTIPLAYER_SKIN_RETRY_MS) return undefined;
    this.failed.delete(def.id);
    this.pending.add(def.id);
    void this.load(def).then(skin => {
      if (skin) { this.loaded.set(def.id, skin); this.changed(); }
      else this.failed.set(def.id, this.now());
    }, () => { this.failed.set(def.id, this.now()); }).finally(() => this.pending.delete(def.id));
    return undefined;
  }
}
