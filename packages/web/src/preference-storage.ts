type PreferenceStorage = Pick<Storage, "getItem" | "setItem">;
const failedWrites = new WeakMap<PreferenceStorage, Map<string, string | null>>();

export function withPreferenceLock<T>(key: string, update: () => T): T | Promise<T> {
  const locks = globalThis.navigator?.locks;
  return locks ? locks.request(key, update) : update();
}

export function updatePreferences<T>(storage: () => PreferenceStorage, key: string, parse: (raw: string | null) => T,
  current: T, change: (preferences: T) => T): { preferences: T; saved: boolean } {
  let store: PreferenceStorage, raw: string | null, latest: T;
  try {
    store = storage();
    raw = store.getItem(key);
    latest = failedWrites.get(store)?.get(key) === raw ? current : parse(raw);
  } catch { return { preferences: change(current), saved: false }; }
  const preferences = change(latest);
  try {
    store.setItem(key, JSON.stringify(preferences));
    failedWrites.get(store)?.delete(key);
    return { preferences, saved: true };
  } catch {
    const failed = failedWrites.get(store) ?? new Map<string, string | null>();
    failed.set(key, raw);
    failedWrites.set(store, failed);
    return { preferences: Object.is(latest, current) ? preferences : change(current), saved: false };
  }
}
