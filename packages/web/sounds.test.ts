import { describe, expect, spyOn, test } from "bun:test";
import { Game, INITIAL_FINESSE, INITIAL_STATS, Input, Piece, type LockResult } from "@42tris/core";
import { BUILTIN_SOUNDS } from "./src/sound-catalog";
import { clearClips, comboClip, parseSoundPack, soundUrl, soundUrls, type SoundClip, type SoundPack } from "./src/sound-pack";
import { fetchSoundFile, SoundPlayer, type LoadedSounds } from "./src/sound-player";
import { MAX_CUSTOM_SOUNDS, parseSoundPreferences, resolveSound, SoundState } from "./src/sound-state";
import { GameSounds } from "./src/game-sounds";
import { snapshotDisplay } from "./src/game-display";
import { setupSettingsTabs } from "./src/skin-settings";

const a = "https://example.com/a.ogg", b = "https://example.com/b.ogg", c = "https://example.com/c.ogg";
const pack: SoundPack = { name: "Test", move: a, rotate: b, harddrop: c, lock: a, hold: b };
function loaded(pack: SoundPack): LoadedSounds { return { pack, buffers: new Map(), failed: 0 }; }
function storage() {
  let raw: string | null = null;
  return { getItem: () => raw, setItem: (_key: string, value: string) => { raw = value; } };
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function result(overrides: Partial<LockResult> = {}): LockResult {
  return { type: "lock", sequence: 1, atMs: 100, piece: Piece.I, rows: [36, 37, 38, 39], spin: "none", allClear: false,
    stats: { ...INITIAL_STATS, pieces: 1, combo: 0, lines: 4, chainLength: 1 }, finesse: INITIAL_FINESSE, attacks: [], ...overrides };
}

describe("sound pack compatibility", () => {
  test("catalog has all seven Jstris+ packs and 26 additional community packs", () => {
    expect(BUILTIN_SOUNDS).toHaveLength(34);
    expect(new Set(BUILTIN_SOUNDS.map(def => def.id)).size).toBe(34);
    for (const def of BUILTIN_SOUNDS.slice(1)) {
      expect(parseSoundPack(def.pack)).toEqual(def.pack);
      expect(soundUrls(def.pack).length).toBeGreaterThan(0);
      expect(def.source).toStartWith("https://github.com/");
    }
  });
  test("accepts all piece voices, null combo slots, and zero sprite spacing", () => {
    const parsed = parseSoundPack({ name: " Voices ", spawns: { I: a, O: b, T: c }, comboTones: [null, a, b] });
    expect(parsed.name).toBe("Voices");
    expect(parsed.spawns?.I).toBe(a);
    expect(comboClip(parsed, 0)).toBeUndefined();
    expect(comboClip(parsed, 100)).toEqual({ url: b });
    const sprite = parseSoundPack({ comboTones: { url: c, cnt: 3, duration: 1000, spacing: 0 } });
    expect(comboClip(sprite, 2)).toEqual({ url: c, offset: 2, duration: 1 });
    expect(comboClip(sprite, 20)).toEqual(comboClip(sprite, 2));
  });
  test("rejects unsafe URLs and malformed pack structures", () => {
    for (const url of ["http://example.com/a", "javascript:alert(1)", "data:audio/wav;base64,eA==", "https://u:p@example.com/a", "https://", "https://example.com/" + "x".repeat(2048)]) expect(() => soundUrl(url)).toThrow();
    for (const value of [null, [], {}, { move: 7 }, { scoring: [] }, { comboTones: [42] },
      { comboTones: { url: a, cnt: 2.5, duration: 100, spacing: 0 } },
      { move: a, specialScoring: { CLEAR4: [{ url: b, b2b: "yes" }] } }]) expect(() => parseSoundPack(value)).toThrow();
  });
  test("requires every condition, then chooses specificity and the highest matching combo", () => {
    const sounds = parseSoundPack({ scoring: { CLEAR4: a }, specialScoring: { CLEAR4: [
      { url: b, b2b: true, override: true }, { url: c, b2b: true, combo: 2, override: true },
      { url: a, b2b: true, combo: 5, override: true },
    ] } });
    expect(clearClips(sounds, result())).toEqual([{ url: a }]);
    expect(clearClips(sounds, result({ stats: { ...INITIAL_STATS, chainLength: 2, combo: 1 } }))).toEqual([{ url: b }]);
    expect(clearClips(sounds, result({ stats: { ...INITIAL_STATS, chainLength: 2, combo: 3 } }))).toEqual([{ url: c }]);
  });
  test("layers combo, all clear and special sounds while deduplicating repeated B2B clips", () => {
    const sounds = parseSoundPack({ b2b: b, comboTones: [null, c], scoring: { CLEAR4: a, PERFECT_CLEAR: c },
      specialScoring: { CLEAR4: [{ url: b, b2b: true }], TSPINORTETRIS: [{ url: b, b2b: true }] } });
    expect(clearClips(sounds, result({ allClear: true, stats: { ...INITIAL_STATS, chainLength: 2, combo: 1 } }))).toEqual([{ url: b }, { url: a }, { url: c }]);
  });
  test("all-spin rules do not replace the regular clear of a non-T piece", () => {
    const sounds = parseSoundPack({ scoring: { CLEAR2: a, TSPIN_DOUBLE: b }, specialScoring: { ALLSPIN: [{ url: c, b2b: false }] } });
    expect(clearClips(sounds, result({ piece: Piece.L, spin: "mini", rows: [38, 39] }))).toEqual([{ url: c }, { url: a }]);
    expect(clearClips(sounds, result({ piece: Piece.T, spin: "full", rows: [38, 39] }))).toEqual([{ url: b }]);
  });
});

describe("sound selection and storage", () => {
  test("imports a JSON link as a saved snapshot and reports malformed or missing files", async () => {
    const fetch = spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(pack)));
    try {
      const saved = storage();
      const state = new SoundState(() => saved, async next => loaded(next));
      expect(await state.add("https://example.com/sounds.json")).toBe(true);
      expect(state.preferences.customs[0]).toEqual({ url: "https://example.com/sounds.json", pack });
      expect(fetch.mock.calls[0][1]).toMatchObject({ credentials: "omit", referrerPolicy: "no-referrer" });
      const restored = new SoundState(() => saved, async next => loaded(next));
      expect(resolveSound(restored.preferences).pack).toEqual(pack);
      expect(fetch).toHaveBeenCalledTimes(1);
      fetch.mockResolvedValueOnce(new Response("Not found", { status: 404 }));
      expect(await state.add("https://example.com/missing.json")).toBe(false);
      expect(state.message).toContain("404");
      fetch.mockResolvedValueOnce(new Response("<html>Not JSON</html>"));
      expect(await state.add("https://example.com/page")).toBe(false);
      expect(state.message).toContain("Invalid JSON");
      expect(state.preferences.active).toBe("custom:0");
    } finally { fetch.mockRestore(); }
  });
  test("validates persisted data, restores pasted JSON, and falls back on unknown ids", () => {
    const preferences = { active: "custom:0", enabled: false, volume: 0.3, customs: [{ pack }] };
    expect(parseSoundPreferences(JSON.stringify(preferences))).toEqual(preferences);
    expect(parseSoundPreferences(JSON.stringify({ ...preferences, active: "missing" })).active).toBe("silent");
    for (const value of ["{", "null", JSON.stringify({ ...preferences, volume: 4 }), JSON.stringify({ ...preferences, customs: [{ pack: { move: "http://example.com" } }] })]) expect(parseSoundPreferences(value).active).toBe("silent");
  });
  test("newer selection wins over late success and late failure", async () => {
    for (const fail of [false, true]) {
      const pending = deferred<LoadedSounds>();
      const state = new SoundState(storage, next => next.name === "Tetrio Sound Pack" ? pending.promise : Promise.resolve(loaded(next)));
      const first = state.select("tetrio");
      await state.select("silent");
      if (fail) pending.reject(new Error("Late failure")); else pending.resolve(loaded(pack));
      await first;
      expect(state.preferences.active).toBe("silent");
      expect(state.loaded?.pack.name).toBe("Silent");
      expect(state.message).not.toContain("Late failure");
    }
  });
  test("failed or cancelled additions preserve the existing selection", async () => {
    const pending = deferred<LoadedSounds>();
    const state = new SoundState(storage, next => next.name === pack.name ? pending.promise : Promise.resolve(loaded(next)));
    const add = state.add(JSON.stringify(pack));
    await state.select("t99");
    pending.resolve(loaded(pack));
    expect(await add).toBe(false);
    expect(state.preferences.customs).toHaveLength(0);
    expect(state.preferences.active).toBe("t99");
    expect(await state.add('{"move":"javascript:alert(1)"}')).toBe(false);
    expect(state.preferences.active).toBe("t99");
  });
  test("custom packs persist, reject duplicates, and preserve selection when indexes shift", async () => {
    const saved = storage();
    const state = new SoundState(() => saved, async next => loaded(next));
    expect(await state.add(JSON.stringify(pack))).toBe(true);
    expect(await state.add(JSON.stringify(pack))).toBe(false);
    const second = { name: "Second", hold: c };
    expect(await state.add(JSON.stringify(second))).toBe(true);
    state.configure({ enabled: false });
    await state.remove(0);
    expect(state.preferences.active).toBe("custom:0");
    expect(state.preferences.enabled).toBe(false);
    expect(resolveSound(state.preferences).pack.name).toBe("Second");
    const restored = new SoundState(() => saved, async next => loaded(next));
    expect(restored.preferences).toEqual(state.preferences);
    await state.remove(0);
    expect(state.preferences.active).toBe("silent");
  });
  test("storage failures retain session settings and the custom-pack limit is enforced", async () => {
    const state = new SoundState(() => { throw new Error("Storage unavailable"); }, async next => loaded(next));
    for (let i = 0; i < MAX_CUSTOM_SOUNDS; i++) expect(await state.add(JSON.stringify({ name: String(i), move: a + i }))).toBe(true);
    expect(await state.add(JSON.stringify({ name: "Extra", move: b }))).toBe(false);
    expect(state.preferences.customs).toHaveLength(MAX_CUSTOM_SOUNDS);
    expect(state.loaded?.pack.name).toBe("11");
  });
});

describe("game sound integration", () => {
  test("only successful actions sound; held keys repeat and hard drops sound once", () => {
    const played: SoundClip[] = [];
    const sounds = new GameSounds(() => pack, clips => played.push(...clips));
    const game = new Game(42); game.setZen(true); game.tick(0);
    sounds.observe(game, game);
    game.apply(Input.LeftDown, 0); sounds.observe(game, game, Input.LeftDown);
    expect(played).toEqual([{ url: a }]);
    game.tick(200); sounds.observe(game, game);
    expect(played.length).toBeGreaterThan(1);
    game.apply(Input.LeftUp, 200); sounds.observe(game, game, Input.LeftUp);
    played.length = 0;
    game.apply(Input.HardDrop, 200); sounds.observe(game, game, Input.HardDrop);
    sounds.observe(game, game);
    expect(played).toEqual([{ url: c }]);
    played.length = 0;
    game.apply(Input.Hold, 200); sounds.observe(game, game, Input.Hold);
    game.apply(Input.Hold, 200); sounds.observe(game, game, Input.Hold);
    expect(played).toEqual([{ url: b }]);
  });
  test("checkpoint rollbacks do not repeat lock effects, and a new epoch can play again", () => {
    const played: SoundClip[] = [];
    const sounds = new GameSounds(() => pack, clips => played.push(...clips));
    const game = new Game(42); game.tick(0);
    const before = game.saveState();
    sounds.observe(snapshotDisplay(before), "round:0");
    game.apply(Input.HardDrop, 0);
    const after = game.saveState();
    sounds.observe(snapshotDisplay(after), "round:0", Input.HardDrop);
    sounds.observe(snapshotDisplay(before), "round:0");
    sounds.observe(snapshotDisplay(after), "round:0");
    expect(played).toEqual([{ url: c }]);
    sounds.observe(snapshotDisplay(before), "round:1");
    sounds.observe(snapshotDisplay(after), "round:1", Input.HardDrop);
    expect(played).toEqual([{ url: c }, { url: c }]);
  });
  test("ready/go and I-piece spawn voices work; missing harddrop falls back to lock", () => {
    const played: SoundClip[] = [];
    const sounds = new GameSounds(() => ({ name: "Voices", ready: a, go: b, spawns: { I: c }, lock: a }), clips => played.push(...clips));
    const game = new Game(42, 500, 5, undefined, 100);
    sounds.observe(game, game);
    expect(played).toEqual([{ url: a }]);
    game.tick(0); game.tick(100); game.piece = Piece.I;
    sounds.observe(game, game);
    expect(played).toEqual([{ url: a }, { url: b }, { url: c }]);
    played.length = 0;
    game.apply(Input.HardDrop, 100); sounds.observe(game, game, Input.HardDrop);
    expect(played[0]).toEqual({ url: a });
  });
});

describe("audio loading and playback", () => {
  test("caps streamed files without trusting Content-Length", async () => {
    const fetch = spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(new Uint8Array(1025), { headers: { "Content-Length": "1" } }));
    try {
      await expect(fetchSoundFile(a, 1024, new AbortController().signal)).rejects.toThrow("too large");
    } finally { fetch.mockRestore(); }
  });
  function audio() {
    const started: number[][] = [];
    const sources: { stopped: boolean }[] = [];
    const buffer = { length: 48000, numberOfChannels: 1, duration: 10 } as AudioBuffer;
    const context = { state: "running", destination: {}, resume: async () => {},
      createGain: () => ({ gain: { value: 0 }, connect() {} }),
      decodeAudioData: async () => buffer,
      createBufferSource: () => {
        const source = { buffer: null, stopped: false, onended: null, connect() {}, disconnect() {}, start: (...args: number[]) => started.push(args), stop() { this.stopped = true; } };
        sources.push(source); return source;
      },
    } as unknown as AudioContext;
    return { context, started, sources };
  }
  test("preloads each URL once, permits partial failures, and retries failed URLs", async () => {
    const { context } = audio();
    const requests: string[] = [];
    let fail = true;
    const player = new SoundPlayer(() => context, async url => { requests.push(url); if (url === b && fail) throw new Error("404"); return new ArrayBuffer(1); });
    const first = await player.load(pack, new AbortController().signal);
    expect(first.failed).toBe(1);
    expect(first.buffers.size).toBe(2);
    fail = false;
    expect((await player.load(pack, new AbortController().signal)).failed).toBe(0);
    expect(requests.filter(url => url === a)).toHaveLength(1);
    expect(requests.filter(url => url === b)).toHaveLength(2);
    const cancelled = new AbortController(); cancelled.abort();
    await expect(player.load(pack, cancelled.signal)).rejects.toThrow();
  });
  test("plays only the requested sprite segment and stops sources on mute or tab close", async () => {
    const { context, started, sources } = audio();
    const player = new SoundPlayer(() => context, async () => new ArrayBuffer(1));
    await player.preview([{ url: a, offset: 3, duration: 1 }]);
    expect(started).toEqual([[0, 3, 1]]);
    player.stop();
    expect(sources.every(source => source.stopped)).toBe(true);
    player.setVolume(0);
    await player.preview([{ url: b }]);
    expect(started).toHaveLength(1);
  });
});

test("settings tabs wrap across all three tabs and close resets the active panel", () => {
  class Tab extends EventTarget {
    tabIndex = -1; attributes = new Map<string, string>(); focused = false;
    setAttribute(key: string, value: string) { this.attributes.set(key, value); }
    focus() { this.focused = true; }
  }
  const tabs = [new Tab(), new Tab(), new Tab()];
  const dialog = new EventTarget() as HTMLDialogElement;
  dialog.querySelectorAll = (() => tabs) as unknown as HTMLDialogElement["querySelectorAll"];
  const general = { hidden: false };
  const original = globalThis.document;
  const panels = [false, false];
  Object.assign(globalThis, { document: { querySelector: (selector: string) => selector === "#settings-dialog" ? dialog : general } });
  try {
    setupSettingsTabs(() => {}, open => { panels[0] = open; }, open => { panels[1] = open; });
    const left = new Event("keydown"); Object.defineProperty(left, "key", { value: "ArrowLeft" });
    tabs[0].dispatchEvent(left);
    expect(panels).toEqual([false, true]);
    expect(general.hidden).toBe(true);
    expect(tabs[2].tabIndex).toBe(0);
    const end = new Event("keydown"); Object.defineProperty(end, "key", { value: "End" });
    tabs[1].dispatchEvent(end);
    expect(tabs[2].attributes.get("aria-selected")).toBe("true");
    dialog.dispatchEvent(new Event("close"));
    expect(general.hidden).toBe(false);
    expect(panels).toEqual([false, false]);
  } finally {
    if (original) Object.assign(globalThis, { document: original });
    else Reflect.deleteProperty(globalThis, "document");
  }
});
