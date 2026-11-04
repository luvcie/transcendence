import { describe, expect, test } from "bun:test";
import { Game, Input } from "@42tris/core";
import { BUILTIN_SOUNDS } from "./src/sound-catalog";
import { GameSounds } from "./src/game-sounds";
import { parseSoundPack, soundUrls, type SoundClip } from "./src/sound-pack";
import { SoundPlayer } from "./src/sound-player";
import { parseSoundPreferences, SoundState } from "./src/sound-state";
import { isTetrioExportUrl, MAX_TETRIO_EXPORT_BYTES, parseTetrioExport, tetrioClipSource, tetrioClipUrl, tetrioSoundPack } from "./src/tetrio-sounds";

const url = "https://example.com/pizza.zip.tpse";
function exported(atlas = { move: [0, 250], harddrop: [1000, 500], menuclick: [2000, 1500] }) {
  return { customSounds: "data:audio/ogg;base64,AQID", customSoundAtlas: atlas, tetrioPlusEnabled: true, skinSvg: "ignored" };
}
function bytes(data: unknown) { return new TextEncoder().encode(JSON.stringify(data)).buffer; }
function buffer(channels: number, length: number, sampleRate = 8): AudioBuffer {
  const data = Array.from({ length: channels }, () => new Float32Array(length));
  return { numberOfChannels: channels, length, sampleRate, duration: length / sampleRate,
    getChannelData: (channel: number) => data[channel],
    copyToChannel: (source: Float32Array, channel: number) => { data[channel].set(source); },
  } as AudioBuffer;
}
function audio(source = buffer(2, 32)) {
  for (let c = 0; c < source.numberOfChannels; c++) source.getChannelData(c).set(Array.from({ length: source.length }, (_, i) => c * 100 + i));
  const started: { buffer: AudioBuffer; args: number[]; stopped: boolean }[] = [];
  let decoded = 0;
  const context = { sampleRate: source.sampleRate, state: "running", destination: {}, resume: async () => {},
    createGain: () => ({ gain: { value: 0 }, connect() {} }),
    decodeAudioData: async () => { decoded++; return source; },
    createBuffer: buffer,
    createBufferSource: () => {
      const node = { buffer: source, stopped: false, onended: null, connect() {}, disconnect() {},
        start: (...args: number[]) => started.push({ buffer: node.buffer, args, stopped: node.stopped }), stop() { this.stopped = true; } };
      return node;
    },
  } as unknown as AudioContext;
  return { context, started, decoded: () => decoded };
}

describe("TETR.IO+ format", () => {
  test("reads only sound data and converts milliseconds into seconds", () => {
    const parsed = parseTetrioExport(exported());
    expect([...new Uint8Array(parsed.audio)]).toEqual([1, 2, 3]);
    expect(parsed.atlas.harddrop).toEqual([1, 0.5]);
    expect(Object.keys(parsed)).toEqual(["audio", "atlas"]);
  });
  test("rejects invalid audio, invalid names, and unbounded timings", () => {
    for (const data of [null, {}, { ...exported(), customSounds: "data:text/html;base64,AQID" },
      { ...exported(), customSounds: "data:audio/ogg;base64,???" },
      { ...exported(), customSoundAtlas: [] }, { ...exported(), customSoundAtlas: {} },
      ...[[-1, 1], [0, 0], [0, Infinity], [0, 600001], [0], [0, "10"]].map(timing => ({ ...exported(), customSoundAtlas: { harddrop: timing } })),
      { ...exported(), customSoundAtlas: { "../drop": [0, 10] } },
    ]) expect(() => parseTetrioExport(data)).toThrow();
  });
  test("references stay HTTPS and preserve query strings while naming individual clips", () => {
    const clip = tetrioClipUrl(url + "?v=2", "harddrop");
    expect(tetrioClipSource(clip)).toEqual({ url: url + "?v=2", name: "harddrop" });
    expect(tetrioClipSource("https://example.com/drop.ogg")).toBeUndefined();
    expect(() => tetrioClipSource(url + "#tpse=../bad")).toThrow();
    expect(() => parseSoundPack({ tetrioPlus: "http://example.com/export.tpse" })).toThrow();
    expect(parseSoundPack({ name: "Mine", tetrioPlus: url + "#old" }).tetrioPlus).toBe(url);
    expect(isTetrioExportUrl(url + "?v=2")).toBe(true);
    expect(isTetrioExportUrl("https://you.have.fail/tetrioplus/data/tpsefiles/sfx/old.zip")).toBe(true);
    expect(isTetrioExportUrl("https://example.com/sounds.json")).toBe(false);
  });
  test("maps clears, spins and combos without adding piece cues or overlapping drop events", () => {
    const pack = tetrioSoundPack("Test", url, ["harddrop", "clearline", "clearquad", "clearspin", "spin", "clearbtb", "combo_1", "combo_16", "i"]);
    expect(pack.scoring?.CLEAR4).toBe(tetrioClipUrl(url, "clearquad"));
    expect(pack.scoring?.TSPIN_DOUBLE).toBe(tetrioClipUrl(url, "clearspin"));
    expect(pack.comboTones).toEqual([null, tetrioClipUrl(url, "combo_1"), ...Array(14).fill(null), tetrioClipUrl(url, "combo_16")]);
    expect(pack.spawns).toBeUndefined();
    const played: SoundClip[] = [];
    const sounds = new GameSounds(() => pack, clips => played.push(...clips));
    const game = new Game(42); game.tick(0); sounds.observe(game, game);
    played.length = 0;
    game.apply(Input.HardDrop, 1); sounds.observe(game, game, Input.HardDrop);
    expect(played).toEqual([{ url: pack.harddrop! }]);
  });
  test("every catalog reference has credits and contains no embedded audio", () => {
    for (const def of BUILTIN_SOUNDS.filter(def => def.pack.tetrioPlus)) {
      expect(def.credit).toEndWith("(TETR.IO+)");
      expect(def.source).toContain("#sfx-");
      expect(def.pack.spawns).toBeUndefined();
      for (const clip of soundUrls(def.pack)) expect(tetrioClipSource(clip)?.url).toBe(def.pack.tetrioPlus);
      expect(JSON.stringify(def)).not.toContain("base64");
    }
  });
});

describe("TETR.IO+ loading", () => {
  test("extracts the requested samples and reuses them for preview and gameplay", async () => {
    const { context, started, decoded } = audio();
    const requests: [string, number][] = [];
    const player = new SoundPlayer(() => context, async (url, limit) => { requests.push([url, limit]); return bytes(exported()); });
    const drop = tetrioClipUrl(url, "harddrop");
    await player.preview([{ url: drop }]);
    const loaded = await player.load({ name: "Pizza", tetrioPlus: url }, new AbortController().signal);
    expect(requests).toEqual([[url, MAX_TETRIO_EXPORT_BYTES]]);
    expect(decoded()).toBe(1);
    expect(loaded.failed).toBe(0);
    expect(loaded.buffers.size).toBe(2);
    expect([...loaded.buffers.get(drop)!.getChannelData(0)]).toEqual([8, 9, 10, 11]);
    expect([...loaded.buffers.get(drop)!.getChannelData(1)]).toEqual([108, 109, 110, 111]);
    expect(started[0].args).toEqual([0, 0, 0.5]);
    player.play([{ url: loaded.pack.harddrop! }], loaded);
    expect(started[1].buffer).toBe(started[0].buffer);
    expect(started[1].args).toEqual(started[0].args);
    expect(loaded.buffers.get(tetrioClipUrl(url, "menuclick"))).toBeUndefined();
  });
  test("imports and restores a direct export link without persisting its audio", async () => {
    let raw: string | null = null;
    const saved = () => ({ getItem: () => raw, setItem: (_key: string, value: string) => { raw = value; } });
    const { context } = audio();
    const player = new SoundPlayer(() => context, async () => bytes(exported()));
    const state = new SoundState(saved, (pack, signal) => player.load(pack, signal));
    expect(await state.add(url)).toBe(true);
    expect(state.preferences.customs[0].pack.name).toBe("pizza");
    expect(state.preferences.customs[0].pack.harddrop).toBe(tetrioClipUrl(url, "harddrop"));
    expect(raw!.length).toBeLessThan(2000);
    expect(raw!).not.toContain("customSounds");
    expect(parseSoundPreferences(raw)).toEqual(state.preferences);
    expect(await state.add(url)).toBe(false);
    const restored = new SoundState(saved, (pack, signal) => player.load(pack, signal));
    await restored.select("custom:0", false);
    expect(restored.loaded?.pack).toEqual(state.loaded?.pack);
  });
  test("a named JSON reference can override individual events with regular audio links", async () => {
    const { context } = audio();
    const requests: string[] = [];
    const player = new SoundPlayer(() => context, async source => { requests.push(source); return bytes(exported()); });
    const pack = parseSoundPack({ name: "Custom", tetrioPlus: url, harddrop: tetrioClipUrl(url, "harddrop"), move: "https://example.com/move.ogg" });
    const loaded = await player.load(pack, new AbortController().signal);
    expect(loaded.pack).toEqual(pack);
    expect(requests).toEqual([url, pack.move!]);
    expect(loaded.failed).toBe(0);
    const replaced = parseSoundPack({ name: "Replaced", tetrioPlus: "https://example.com/unused.tpse", move: pack.move });
    expect((await player.load(replaced, new AbortController().signal)).failed).toBe(0);
    expect(requests).toEqual([url, pack.move!]);
  });
  test("rejects a repeated JSON reference after resolving its event mappings", async () => {
    const { context } = audio();
    const player = new SoundPlayer(() => context, async () => bytes(exported()));
    const state = new SoundState(() => ({ getItem: () => null, setItem() {} }), (pack, signal) => player.load(pack, signal));
    const reference = JSON.stringify({ name: "Mine", tetrioPlus: url });
    expect(await state.add(reference)).toBe(true);
    expect(await state.add(reference)).toBe(false);
    expect(state.preferences.customs).toHaveLength(1);
    expect(state.message).toBe("That pack is already saved.");
  });
  test("validates clip bounds and decoding limits before caching anything", async () => {
    for (const data of [exported({ move: [0, 250], harddrop: [3900, 500], menuclick: [2000, 1500] }),
      { ...exported(), customSoundAtlas: { harddrop: [0, 31000] } }]) {
      const { context } = audio();
      const player = new SoundPlayer(() => context, async () => bytes(data));
      await expect(player.load({ name: "Bad", tetrioPlus: url }, new AbortController().signal)).rejects.toThrow("timing");
    }
    const { context } = audio(buffer(3, 32));
    const player = new SoundPlayer(() => context, async () => bytes(exported()));
    await expect(player.load({ name: "Bad", tetrioPlus: url }, new AbortController().signal)).rejects.toThrow("decoding limit");
  });
  test("a cancelled preview releases the queue and cannot poison the next load", async () => {
    const { context, started, decoded } = audio();
    let finish!: (bytes: ArrayBuffer) => void, requested!: () => void;
    const waiting = new Promise<void>(resolve => { requested = resolve; });
    let calls = 0;
    const player = new SoundPlayer(() => context, async () => {
      if (++calls === 1) { requested(); return new Promise<ArrayBuffer>(resolve => { finish = resolve; }); }
      return bytes(exported());
    });
    const preview = player.preview([{ url: tetrioClipUrl(url, "harddrop") }]);
    await waiting;
    player.stop();
    const next = player.load({ name: "Next", tetrioPlus: url }, new AbortController().signal);
    finish(bytes(exported()));
    await expect(preview).rejects.toMatchObject({ name: "AbortError" });
    expect((await next).failed).toBe(0);
    expect(started).toHaveLength(0);
    expect(decoded()).toBe(1);
    expect(calls).toBe(2);
  });
  test("failed exports can be retried, and identical filenames on different hosts stay separate", async () => {
    const { context } = audio();
    let fail = true;
    const player = new SoundPlayer(() => context, async () => {
      if (fail) throw new Error("HTTP 404");
      return bytes(exported());
    });
    await expect(player.load({ name: "First", tetrioPlus: url }, new AbortController().signal)).rejects.toThrow("404");
    fail = false;
    const first = await player.load({ name: "First", tetrioPlus: url }, new AbortController().signal);
    const second = await player.load({ name: "Second", tetrioPlus: url.replace("example.com", "other.example") }, new AbortController().signal);
    expect(first.pack.harddrop).not.toBe(second.pack.harddrop);
    expect(first.buffers.get(first.pack.harddrop!)).not.toBe(second.buffers.get(second.pack.harddrop!));
  });
});
