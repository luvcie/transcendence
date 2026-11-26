type PreferenceStorage = Pick<Storage, "getItem" | "setItem">;

export function withPreferenceLock<T>(key: string, update: () => T): T | Promise<T> {
  const locks = globalThis.navigator?.locks;
  return locks ? locks.request(key, update) : update();
}

export function updatePreferences<T>(storage: () => PreferenceStorage, key: string, parse: (raw: string | null) => T,
  current: T, change: (preferences: T) => T): { preferences: T; saved: boolean } {
  let store: PreferenceStorage, latest: T;
  try {
    store = storage();
    latest = parse(store.getItem(key));
  } catch { return { preferences: change(current), saved: false }; }
  const preferences = change(latest);
  try {
    store.setItem(key, JSON.stringify(preferences));
    return { preferences, saved: true };
  } catch { return { preferences: change(current), saved: false }; }
}
