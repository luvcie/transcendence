import { fetchExternalFile } from "./external-file";

export const MUSIC_STORAGE_KEY = "42tris.music.v1";
export const ZEN_LOOP_START = 1008000 / 44100;
export const ZEN_LOOP_END = 4032000 / 44100;
const MUSIC_URL = new URL("./assets/zen.mp3", import.meta.url).href;

export interface MusicPreferences { enabled: boolean; volume: number }
export function parseMusicPreferences(raw: string | null): MusicPreferences {
  try {
    const data = raw && JSON.parse(raw);
    if (data && typeof data.enabled === "boolean" && typeof data.volume === "number"
      && Number.isFinite(data.volume) && data.volume >= 0 && data.volume <= 1) {
      return { enabled: data.enabled, volume: data.volume };
    }
  } catch { /* Invalid saved settings use the defaults. */ }
  return { enabled: true, volume: 0.5 };
}

export class ZenMusic {
  preferences: MusicPreferences;
  message = "Music settings are saved on this device.";
  changed = () => {};
  private buffer?: AudioBuffer;
  private gain?: GainNode;
  private source?: AudioBufferSourceNode;
  private request?: AbortController;
  private loading?: Promise<void>;
  private playing = false;
  private offset = 0;
  private startedAt = 0;

  constructor(private audio: () => AudioContext,
    private storage: () => Pick<Storage, "getItem" | "setItem">,
    private fetchFile = fetchExternalFile) {
    this.preferences = parseMusicPreferences(null);
    try { this.preferences = parseMusicPreferences(storage().getItem(MUSIC_STORAGE_KEY)); }
    catch { this.message = "Saved music settings could not be loaded. Using defaults."; }
  }

  configure(value: Partial<MusicPreferences>) {
    Object.assign(this.preferences, value);
    if (!this.preferences.enabled || !this.preferences.volume) this.pause();
    if (this.gain) this.gain.gain.setTargetAtTime(this.preferences.volume, this.audio().currentTime, 0.015);
    try {
      this.storage().setItem(MUSIC_STORAGE_KEY, JSON.stringify(this.preferences));
      this.message = "Music settings saved on this device.";
    } catch { this.message = "Music applies for this session; browser storage is unavailable."; }
    this.changed();
  }

  prepare(): Promise<void> {
    if (!this.preferences.enabled || !this.preferences.volume) return Promise.resolve();
    if (this.loading) return this.loading;
    const request = this.request = new AbortController();
    this.loading = (async () => {
      const context = this.audio();
      if (context.state === "suspended") await context.resume();
      request.signal.throwIfAborted();
      if (this.buffer) return;
      this.message = "Loading Zen music…";
      this.changed();
      const bytes = await this.fetchFile(MUSIC_URL, 4 * 1024 * 1024, request.signal);
      request.signal.throwIfAborted();
      const buffer = await context.decodeAudioData(bytes);
      request.signal.throwIfAborted();
      this.buffer = buffer;
      this.message = "Zen music ready.";
    })().catch((error: Error) => {
      if (!request.signal.aborted) this.message = `Music unavailable: ${error.message}. You can still play; resume Zen to retry.`;
    }).finally(() => {
      if (this.request !== request) return;
      this.request = undefined;
      this.loading = undefined;
      this.changed();
    });
    return this.loading;
  }

  async setPlaying(playing: boolean) {
    this.playing = playing;
    if (!playing) { this.pause(); return; }
    if (this.loading) await this.loading;
    if (!this.playing || this.source || !this.buffer || !this.preferences.enabled || !this.preferences.volume) return;
    const context = this.audio();
    if (context.state !== "running") return;
    if (!this.gain) {
      this.gain = context.createGain();
      this.gain.connect(context.destination);
    }
    this.gain.gain.value = this.preferences.volume;
    const source = context.createBufferSource();
    source.buffer = this.buffer;
    source.loop = true;
    source.loopStart = ZEN_LOOP_START;
    source.loopEnd = ZEN_LOOP_END;
    source.connect(this.gain);
    source.start(0, this.offset);
    this.startedAt = context.currentTime;
    this.source = source;
  }

  private pause() {
    if (!this.source) return;
    this.offset += Math.max(0, this.audio().currentTime - this.startedAt);
    if (this.offset >= ZEN_LOOP_END) this.offset = ZEN_LOOP_START + (this.offset - ZEN_LOOP_START) % (ZEN_LOOP_END - ZEN_LOOP_START);
    this.source.stop();
    this.source.disconnect();
    this.source = undefined;
  }

  release() {
    this.playing = false;
    this.pause();
    this.offset = 0;
    this.request?.abort();
    this.request = undefined;
    this.loading = undefined;
    this.buffer = undefined;
    this.gain?.disconnect();
    this.gain = undefined;
  }
}
