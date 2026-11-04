import { parseSoundPack, soundUrl, type SoundPack } from "./sound-pack";

export type SoundAtlas = Record<string, readonly [number, number]>;
export const MAX_TETRIO_EXPORT_BYTES = 24 * 1024 * 1024;
const MAX_TETRIO_AUDIO_BYTES = 16 * 1024 * 1024;
const SOUND_NAME = /^[a-z][a-z0-9_]{0,63}$/;

export function isTetrioExportUrl(value: string): boolean {
  const url = new URL(value);
  return /\.tpse$/i.test(url.pathname) || url.hostname === "you.have.fail" && url.pathname.startsWith("/tetrioplus/data/tpsefiles/");
}

export function tetrioClipUrl(source: string, name: string): string {
  const url = new URL(soundUrl(source));
  url.hash = `tpse=${name}`;
  return url.href;
}

export function tetrioClipSource(value: string): { url: string; name: string } | undefined {
  const url = new URL(value);
  if (!url.hash.startsWith("#tpse=")) return;
  const name = url.hash.slice(6);
  if (!SOUND_NAME.test(name)) throw new Error("Invalid TETR.IO+ sound name.");
  url.hash = "";
  return { url: url.href, name };
}

export function tetrioSoundPack(name: string, source: string, sounds: Iterable<string>): SoundPack {
  const available = new Set(sounds);
  const clip = (...names: string[]) => {
    const name = names.find(key => available.has(key));
    return name ? tetrioClipUrl(source, name) : undefined;
  };
  return parseSoundPack({
    name, tetrioPlus: soundUrl(source),
    move: clip("move"), rotate: clip("rotate"), hold: clip("hold"),
    harddrop: clip("harddrop"), lock: clip("harddrop"), land: clip("floor"),
    ready: clip("rsg"), go: clip("go", "rsg_go"), died: clip("topout", "gameover"),
    success: clip("finish", "victory"), garbage: clip("garbagerise", "garbage_in_small"), fault: clip("finessefault"),
    scoring: {
      SOFT_DROP: clip("softdrop"), CLEAR1: clip("clearline"), CLEAR2: clip("clearline"), CLEAR3: clip("clearline"),
      CLEAR4: clip("clearquad"), TSPIN: clip("spin"), TSPIN_MINI: clip("spin"),
      TSPIN_MINI_SINGLE: clip("clearspin"), TSPIN_SINGLE: clip("clearspin"),
      TSPIN_DOUBLE: clip("clearspin"), TSPIN_TRIPLE: clip("clearspin"), PERFECT_CLEAR: clip("allclear"),
    },
    comboTones: [null, ...Array.from({ length: 16 }, (_, i) => clip(`combo_${i + 1}`) ?? null)],
    ...(available.has("clearbtb") ? { specialScoring: {
      TSPINORTETRIS: [{ url: tetrioClipUrl(source, "clearbtb"), b2b: true }],
    } } : {}),
  });
}

export function parseTetrioExport(value: unknown): { audio: ArrayBuffer; atlas: SoundAtlas } {
  if (!value || typeof value !== "object") throw new Error("Invalid TETR.IO+ export.");
  const data = value as Record<string, unknown>;
  if (typeof data.customSounds !== "string" || !/^data:audio\/(ogg|mpeg|mp3|wav|webm);base64,/.test(data.customSounds)
    || !data.customSoundAtlas || typeof data.customSoundAtlas !== "object" || Array.isArray(data.customSoundAtlas)) {
    throw new Error("This TETR.IO+ export does not contain a sound pack.");
  }
  const atlas: SoundAtlas = {};
  const entries = Object.entries(data.customSoundAtlas);
  if (!entries.length || entries.length > 512) throw new Error("Use a TETR.IO+ atlas with 1 to 512 sounds.");
  for (const [name, timing] of entries) {
    if (!SOUND_NAME.test(name) || !Array.isArray(timing) || timing.length !== 2
      || !timing.every(n => typeof n === "number" && Number.isFinite(n))
      || timing[0] < 0 || timing[1] <= 0 || timing[0] + timing[1] > 600000) {
      throw new Error("Invalid TETR.IO+ sound timing.");
    }
    atlas[name] = [timing[0] / 1000, timing[1] / 1000];
  }
  const encoded = data.customSounds.slice(data.customSounds.indexOf(",") + 1);
  if (!encoded.length || encoded.length > Math.ceil(MAX_TETRIO_AUDIO_BYTES / 3) * 4) throw new Error("The TETR.IO+ audio is too large or empty.");
  let binary: string;
  try { binary = atob(encoded); }
  catch { throw new Error("Invalid TETR.IO+ audio encoding."); }
  if (binary.length > MAX_TETRIO_AUDIO_BYTES) throw new Error("The TETR.IO+ audio is too large.");
  const audio = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) audio[i] = binary.charCodeAt(i);
  return { audio: audio.buffer, atlas };
}
