import { expect, mock, test } from "bun:test";
import { MUSIC_STORAGE_KEY, parseMusicPreferences, ZenMusic, ZEN_LOOP_END, ZEN_LOOP_START } from "./src/zen-music";
import { setupMusic } from "./src/music-settings";
import { FakeDocument } from "./test-dom";

function storage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}

async function start(music: ZenMusic) {
  const preparing = music.prepare();
  await music.setPlaying(true);
  await preparing;
}

function audio() {
  const sources: ReturnType<typeof source>[] = [];
  function source() {
    return { buffer: null, loop: false, loopStart: 0, loopEnd: 0,
      connect: mock(() => {}), disconnect: mock(() => {}), start: mock((_when: number, _offset: number) => {}), stop: mock(() => {}) };
  }
  const gain = { gain: { value: 0, setTargetAtTime: mock((_value: number, _time: number, _constant: number) => {}) },
    connect: mock(() => {}), disconnect: mock(() => {}) };
  const context = { state: "running", currentTime: 0, destination: {},
    resume: mock(async () => { context.state = "running"; }),
    decodeAudioData: mock(async (_bytes: ArrayBuffer) => ({ duration: ZEN_LOOP_END } as AudioBuffer)),
    createGain: () => gain,
    createBufferSource: () => { const next = source(); sources.push(next); return next; },
  };
  const getContext = mock(() => context as unknown as AudioContext);
  const fetch = mock(async (_url: string, _limit: number, _signal: AbortSignal) => new ArrayBuffer(1));
  const saved = storage();
  const music = new ZenMusic(getContext, () => saved, fetch);
  return { music, context, sources, gain, fetch, getContext, saved };
}

test("music stays lazy, and disabled or zero-volume music allocates no audio resources", async () => {
  for (const preference of [{ enabled: false }, { volume: 0 }]) {
    const { music, getContext, fetch } = audio();
    expect(getContext).not.toHaveBeenCalled();
    music.configure(preference);
    await music.prepare();
    await music.setPlaying(true);
    expect(getContext).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  }
});

test("playback never starts a fetch or decode without explicit preparation", async () => {
  const { music, getContext, fetch } = audio();
  await music.setPlaying(true);
  expect(getContext).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

test("concurrent preparation decodes once and native playback starts with the intro", async () => {
  const { music, context, sources, fetch, gain } = audio();
  context.state = "suspended";
  await Promise.all([music.prepare(), music.prepare()]);
  expect(context.resume).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(context.decodeAudioData).toHaveBeenCalledTimes(1);
  await Promise.all([music.setPlaying(true), music.setPlaying(true)]);
  expect(sources).toHaveLength(1);
  expect(sources[0].loop).toBe(true);
  expect(sources[0].loopStart).toBe(ZEN_LOOP_START);
  expect(sources[0].loopEnd).toBe(ZEN_LOOP_END);
  expect(sources[0].start.mock.calls).toEqual([[0, 0]]);
  expect(gain.gain.value).toBe(0.5);
});

test("pause and resume preserve the intro position and wrap correctly after multiple loops", async () => {
  const { music, context, sources } = audio();
  await start(music);
  context.currentTime = 10;
  await music.setPlaying(false);
  expect(sources[0].stop).toHaveBeenCalledTimes(1);
  expect(sources[0].disconnect).toHaveBeenCalledTimes(1);
  context.currentTime = 100;
  await music.setPlaying(true);
  expect(sources[1].start.mock.calls).toEqual([[0, 10]]);
  context.currentTime = 100 + ZEN_LOOP_END - 10 + 2 * (ZEN_LOOP_END - ZEN_LOOP_START) + 3;
  await music.setPlaying(false);
  await music.setPlaying(true);
  expect(sources[2].start.mock.calls[0][1]).toBeCloseTo(ZEN_LOOP_START + 3);
});

test("preparing an existing Zen game keeps its current music source uninterrupted", async () => {
  const { music, context, sources } = audio();
  await start(music);
  context.currentTime = 40;
  await music.prepare();
  await music.setPlaying(true);
  expect(sources).toHaveLength(1);
  expect(sources[0].stop).not.toHaveBeenCalled();
  expect(sources[0].disconnect).not.toHaveBeenCalled();
  expect(context.decodeAudioData).toHaveBeenCalledTimes(1);
});

test("leaving Zen releases decoded audio and the next visit starts with the intro", async () => {
  const { music, context, sources, gain } = audio();
  await start(music);
  context.currentTime = 50;
  music.release();
  expect(sources[0].stop).toHaveBeenCalledTimes(1);
  expect(gain.disconnect).toHaveBeenCalledTimes(1);
  await start(music);
  expect(sources[1].start.mock.calls).toEqual([[0, 0]]);
  expect(context.decodeAudioData).toHaveBeenCalledTimes(2);
});

test("leaving during decoding discards the late result and prevents delayed playback", async () => {
  const { music, context, sources, fetch } = audio();
  let finish!: (buffer: AudioBuffer) => void;
  const decoding = new Promise<AudioBuffer>(resolve => { finish = resolve; });
  context.decodeAudioData.mockImplementationOnce(() => decoding);
  const playing = start(music);
  await Promise.resolve();
  await Promise.resolve();
  expect(context.decodeAudioData).toHaveBeenCalledTimes(1);
  const signal = fetch.mock.calls[0][2];
  music.release();
  expect(signal.aborted).toBe(true);
  finish({ duration: ZEN_LOOP_END } as AudioBuffer);
  await playing;
  expect(sources).toHaveLength(0);
  await start(music);
  expect(context.decodeAudioData).toHaveBeenCalledTimes(2);
  expect(sources).toHaveLength(1);
});

test("pausing or muting during loading prevents late playback", async () => {
  for (const mute of [false, true]) {
    const { music, context, sources } = audio();
    let finish!: (buffer: AudioBuffer) => void;
    context.decodeAudioData.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const playing = start(music);
    await Promise.resolve();
    await Promise.resolve();
    if (mute) music.configure({ enabled: false });
    else await music.setPlaying(false);
    finish({ duration: ZEN_LOOP_END } as AudioBuffer);
    await playing;
    expect(sources).toHaveLength(0);
  }
});

test("music mute and volume persist independently and resume without decoding again", async () => {
  const { music, context, sources, gain, saved } = audio();
  await start(music);
  music.configure({ volume: 0.25 });
  expect(gain.gain.setTargetAtTime.mock.calls).toEqual([[0.25, 0, 0.015]]);
  music.configure({ enabled: false });
  expect(sources[0].stop).toHaveBeenCalledTimes(1);
  expect(parseMusicPreferences(saved.getItem(MUSIC_STORAGE_KEY))).toEqual({ enabled: false, volume: 0.25 });
  expect(new ZenMusic(() => context as unknown as AudioContext, () => saved).preferences).toEqual(music.preferences);
  music.configure({ enabled: true });
  await music.setPlaying(true);
  expect(gain.gain.value).toBe(0.25);
  expect(context.decodeAudioData).toHaveBeenCalledTimes(1);
});

test("failed music loads report the error and can be retried", async () => {
  const { music, fetch, sources } = audio();
  fetch.mockRejectedValueOnce(new Error("Network offline"));
  await start(music);
  expect(sources).toHaveLength(0);
  expect(music.message).toContain("Network offline");
  await music.setPlaying(true);
  expect(fetch).toHaveBeenCalledTimes(1);
  await start(music);
  expect(sources).toHaveLength(1);
});

test("invalid saved music preferences use defaults and storage failures allow session changes", () => {
  for (const raw of [null, "{", "null", '{"enabled":true,"volume":2}', '{"enabled":false,"volume":"0.5"}']) {
    expect(parseMusicPreferences(raw)).toEqual({ enabled: true, volume: 0.5 });
  }
  const music = new ZenMusic(() => { throw new Error("Should stay lazy"); }, () => { throw new Error("Storage disabled"); });
  music.configure({ volume: 0.2, enabled: false });
  expect(music.preferences).toEqual({ enabled: false, volume: 0.2 });
  expect(music.message).toContain("session");
});

test("Audio controls apply and display saved music volume and mute", () => {
  const document = new FakeDocument();
  const original = globalThis.document;
  Object.assign(globalThis, { document });
  try {
    const { music } = audio();
    music.configure({ enabled: false, volume: 0.3 });
    const sync = mock(() => {});
    setupMusic(music, sync);
    expect(document.querySelector("#music-enabled").checked).toBe(false);
    expect(document.querySelector("#music-volume").value).toBe("30");
    expect(document.querySelector("#music-volume-value").value).toBe("30%");
    const volume = document.querySelector("#music-volume");
    Object.defineProperty(volume, "valueAsNumber", { value: 75 });
    volume.dispatchEvent(new Event("input"));
    expect(music.preferences.volume).toBe(0.75);
    expect(volume.getAttribute("aria-valuetext")).toBe("75%");
    const enabled = document.querySelector("#music-enabled");
    enabled.checked = true;
    enabled.dispatchEvent(new Event("change"));
    expect(music.preferences.enabled).toBe(true);
    expect(sync).toHaveBeenCalledTimes(2);
  } finally {
    if (original) Object.assign(globalThis, { document: original });
    else Reflect.deleteProperty(globalThis, "document");
  }
});
