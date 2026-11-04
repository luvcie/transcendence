import { Piece, type LockResult } from "@42tris/core";

export const SOUND_EVENTS = ["hold", "linefall", "lock", "harddrop", "rotate", "success", "garbage", "b2b", "land", "move", "died", "ready", "go", "golive", "ding", "msg", "fault", "item", "pickup"] as const;
export type SoundEvent = typeof SOUND_EVENTS[number];
export const SCORE_EVENTS = ["SOFT_DROP", "HARD_DROP", "CLEAR1", "CLEAR2", "CLEAR3", "CLEAR4", "TSPIN_MINI", "TSPIN", "TSPIN_MINI_SINGLE", "TSPIN_SINGLE", "TSPIN_DOUBLE", "TSPIN_TRIPLE", "PERFECT_CLEAR", "COMBO", "CLEAR5"] as const;
export type ScoreEvent = typeof SCORE_EVENTS[number];
export interface SoundClip { url: string; offset?: number; duration?: number }
export interface SpecialSound { url: string; b2b?: boolean; combo?: number; override?: boolean }
export interface ComboSprite { url: string; duration: number; spacing: number; cnt: number }
export interface SoundPack extends Partial<Record<SoundEvent, string>> {
  name: string;
  tetrioPlus?: string;
  scoring?: Partial<Record<ScoreEvent, string>>;
  spawns?: Partial<Record<string, string>>;
  comboTones?: (string | null)[] | ComboSprite;
  specialScoring?: Record<string, SpecialSound[]>;
}
export const MAX_PACK_LENGTH = 65536;

export function soundUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048) throw new Error("Use HTTPS links for pack files and audio clips.");
  try {
    const url = new URL(value.trim());
    if (url.protocol === "https:" && !url.username && !url.password && url.href.length <= 2048) return url.href;
  } catch { /* Report invalid user input below. */ }
  throw new Error("Use HTTPS links for pack files and audio clips, without credentials.");
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("A sound pack must be a JSON object.");
  return value as Record<string, unknown>;
}
function number(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new Error("Invalid combo timing or threshold.");
  return value;
}

export function parseSoundPack(value: unknown): SoundPack {
  const data = record(value);
  const pack: SoundPack = { name: typeof data.name === "string" && data.name.trim() ? data.name.trim().slice(0, 100) : "Custom sound pack" };
  if (data.tetrioPlus !== undefined) {
    const url = new URL(soundUrl(data.tetrioPlus));
    url.hash = "";
    pack.tetrioPlus = url.href;
  }
  for (const key of SOUND_EVENTS) if (data[key] != null && data[key] !== "") pack[key] = soundUrl(data[key]);
  for (const key of ["scoring", "spawns"] as const) if (data[key] != null) {
    const entries = record(data[key]);
    const result: Record<string, string> = {};
    for (const event of key === "scoring" ? SCORE_EVENTS : ["I", "O", "T", "L", "J", "S", "Z"]) {
      if (entries[event] != null && entries[event] !== "") result[event] = soundUrl(entries[event]);
    }
    pack[key] = result;
  }
  if (data.comboTones != null) {
    if (Array.isArray(data.comboTones)) {
      if (data.comboTones.length > 128) throw new Error("Use at most 128 combo tones.");
      pack.comboTones = data.comboTones.map(url => url == null ? null : soundUrl(url));
    } else {
      const sprite = record(data.comboTones);
      const cnt = number(sprite.cnt, 1, 128);
      if (!Number.isInteger(cnt)) throw new Error("Combo count must be a whole number.");
      pack.comboTones = { url: soundUrl(sprite.url), duration: number(sprite.duration, 1, 30000), spacing: number(sprite.spacing, 0, 30000), cnt };
    }
  }
  if (data.specialScoring != null) {
    const entries = record(data.specialScoring);
    pack.specialScoring = {};
    for (const key of [...SCORE_EVENTS, "TSPINORTETRIS", "ALLSPIN", "ANY"]) if (entries[key] != null) {
      const rules = entries[key];
      if (!Array.isArray(rules) || rules.length > 128) throw new Error("Special scoring must contain arrays of at most 128 sounds.");
      pack.specialScoring[key] = rules.map(value => {
        const rule = record(value);
        const result: SpecialSound = { url: soundUrl(rule.url) };
        for (const flag of ["b2b", "override"] as const) if (rule[flag] !== undefined) {
          if (typeof rule[flag] !== "boolean") throw new Error(`${flag} must be true or false.`);
          result[flag] = rule[flag];
        }
        if (rule.combo !== undefined) result.combo = number(rule.combo, 0, 1000000);
        return result;
      });
    }
  }
  const count = soundUrls(pack).length;
  if (count === 0 && !pack.tetrioPlus) throw new Error("Add at least one audio link to this pack.");
  if (count > 256) throw new Error("Use at most 256 different audio clips per pack.");
  return pack;
}

export function soundUrls(pack: SoundPack): string[] {
  return [...new Set([
    ...SOUND_EVENTS.map(key => pack[key]), ...Object.values(pack.scoring ?? {}), ...Object.values(pack.spawns ?? {}),
    ...(Array.isArray(pack.comboTones) ? pack.comboTones : [pack.comboTones?.url]),
    ...Object.values(pack.specialScoring ?? {}).flat().map(rule => rule.url),
  ].filter((url): url is string => typeof url === "string"))];
}

export function comboClip(pack: SoundPack, combo: number): SoundClip | undefined {
  const tones = pack.comboTones;
  if (!tones || combo < 0) return;
  if (Array.isArray(tones)) {
    const url = tones[Math.min(combo, tones.length - 1)];
    if (url) return { url };
  } else {
    const index = Math.min(combo, tones.cnt - 1);
    return { url: tones.url, offset: index * (tones.duration + tones.spacing) / 1000, duration: tones.duration / 1000 };
  }
}

export function clearClips(pack: SoundPack, result: LockResult): SoundClip[] {
  const lines = result.rows.length;
  const tspin = result.piece === Piece.T && result.spin !== "none";
  let key: ScoreEvent | undefined;
  if (tspin && result.spin === "mini") key = lines ? "TSPIN_MINI_SINGLE" : "TSPIN_MINI";
  else if (tspin) key = (["TSPIN", "TSPIN_SINGLE", "TSPIN_DOUBLE", "TSPIN_TRIPLE"] as const)[lines];
  else if (lines) key = `CLEAR${lines}` as ScoreEvent;
  const b2b = lines > 0 && result.stats.chainLength > 1;
  const combo = result.stats.combo;
  const clips: SoundClip[] = [];
  let override = false;
  const groups = [key, ...(lines && (tspin || lines >= 4) ? ["TSPINORTETRIS"] : []),
    ...(result.spin !== "none" && !tspin ? ["ALLSPIN"] : []), "ANY"];
  for (const group of groups) {
    if (!group) continue;
    let best: SpecialSound | undefined;
    let specificity = -1;
    for (const rule of pack.specialScoring?.[group] ?? []) {
      if ((rule.b2b !== undefined && rule.b2b !== b2b) || (rule.combo !== undefined && rule.combo > combo)) continue;
      const score = Number(rule.b2b !== undefined) + Number(rule.combo !== undefined);
      if (score > specificity || score === specificity && (rule.combo ?? -1) > (best?.combo ?? -1)) { best = rule; specificity = score; }
    }
    if (best) { clips.push({ url: best.url }); override ||= best.override === true; }
  }
  if (!override && key && pack.scoring?.[key]) clips.push({ url: pack.scoring[key]! });
  if (lines) {
    if (pack.linefall) clips.push({ url: pack.linefall });
    if (b2b && pack.b2b) clips.push({ url: pack.b2b });
    const tone = comboClip(pack, combo);
    if (tone) clips.push(tone);
    if (combo > 0 && pack.scoring?.COMBO) clips.push({ url: pack.scoring.COMBO });
  }
  if (result.allClear && pack.scoring?.PERFECT_CLEAR) clips.push({ url: pack.scoring.PERFECT_CLEAR });
  return clips.filter((clip, i) => clips.findIndex(other => other.url === clip.url && other.offset === clip.offset) === i);
}
