import { soundUrls, type SoundClip, type SoundPack } from "./sound-pack";

export interface LoadedSounds { pack: SoundPack; buffers: Map<string, AudioBuffer>; failed: number }
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const MAX_DECODED_BYTES = 64 * 1024 * 1024;

export async function fetchSoundFile(url: string, limit: number, signal: AbortSignal): Promise<ArrayBuffer> {
  const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(12000)]), credentials: "omit", referrerPolicy: "no-referrer" });
  if (!response.ok) throw new Error(`Could not load file (HTTP ${response.status}).`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("The file was empty.");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) throw new Error("The file is too large.");
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes.buffer;
}

export class SoundPlayer {
  private context?: AudioContext;
  private gain?: GainNode;
  private cache = new Map<string, AudioBuffer>();
  private cacheBytes = 0;
  private sources = new Set<AudioBufferSourceNode>();
  private previewRequest?: AbortController;
  volume = 0.5;

  constructor(private makeContext = () => new AudioContext({ latencyHint: "interactive" }), private fetchFile = fetchSoundFile) {}

  private audio() {
    if (!this.context) {
      this.context = this.makeContext();
      this.gain = this.context.createGain();
      this.gain.gain.value = this.volume;
      this.gain.connect(this.context.destination);
    }
    return this.context;
  }
  async unlock() {
    const context = this.audio();
    if (context.state === "suspended") await context.resume();
  }
  setVolume(volume: number) {
    this.volume = volume;
    if (this.gain) this.gain.gain.value = volume;
  }
  stop() {
    this.previewRequest?.abort();
    this.previewRequest = undefined;
    for (const source of this.sources) source.stop();
    this.sources.clear();
  }
  private size(buffer: AudioBuffer) { return buffer.length * buffer.numberOfChannels * 4; }
  private async buffer(url: string, signal: AbortSignal): Promise<AudioBuffer> {
    const cached = this.cache.get(url);
    if (cached) { this.cache.delete(url); this.cache.set(url, cached); return cached; }
    const context = this.audio();
    const bytes = await this.fetchFile(url, MAX_AUDIO_BYTES, signal);
    const buffer = await context.decodeAudioData(bytes);
    signal.throwIfAborted();
    const size = this.size(buffer);
    if (size > MAX_DECODED_BYTES) throw new Error("This audio clip is too long.");
    // A preview and a pack load can finish the same URL concurrently.
    const existing = this.cache.get(url);
    if (existing) return existing;
    while (this.cache.size && (this.cacheBytes + size > MAX_DECODED_BYTES || this.cache.size >= 128)) {
      const first = this.cache.keys().next().value!;
      this.cacheBytes -= this.size(this.cache.get(first)!);
      this.cache.delete(first);
    }
    this.cache.set(url, buffer); this.cacheBytes += size;
    return buffer;
  }
  async load(pack: SoundPack, signal: AbortSignal): Promise<LoadedSounds> {
    const urls = soundUrls(pack);
    const loaded: LoadedSounds = { pack, buffers: new Map(), failed: 0 };
    let next = 0, bytes = 0;
    await Promise.all(Array.from({ length: Math.min(6, urls.length) }, async () => {
      while (next < urls.length) {
        signal.throwIfAborted();
        const url = urls[next++];
        try {
          const buffer = await this.buffer(url, signal);
          bytes += this.size(buffer);
          if (bytes > MAX_DECODED_BYTES) throw new Error("This pack exceeds the audio memory limit.");
          loaded.buffers.set(url, buffer);
        } catch {
          signal.throwIfAborted();
          loaded.failed++;
        }
      }
    }));
    if (urls.length && !loaded.buffers.size) throw new Error("No audio could be loaded. Check the links and the host's CORS settings, then retry.");
    return loaded;
  }
  play(clips: SoundClip[], loaded: LoadedSounds) {
    if (!this.context || this.context.state !== "running" || this.volume === 0) return;
    for (const clip of clips) {
      const buffer = loaded.buffers.get(clip.url);
      if (!buffer || (clip.offset ?? 0) >= buffer.duration) continue;
      if (this.sources.size >= 24) { const first = this.sources.values().next().value!; first.stop(); this.sources.delete(first); }
      const source = this.context.createBufferSource();
      source.buffer = buffer; source.connect(this.gain!);
      source.onended = () => { this.sources.delete(source); source.disconnect(); };
      this.sources.add(source);
      source.start(0, clip.offset ?? 0, clip.duration ?? buffer.duration);
    }
  }
  async preview(clips: SoundClip[]) {
    this.stop();
    const request = new AbortController();
    this.previewRequest = request;
    await this.unlock();
    const buffers = new Map<string, AudioBuffer>();
    for (const clip of clips) buffers.set(clip.url, await this.buffer(clip.url, request.signal));
    request.signal.throwIfAborted();
    this.play(clips, { pack: { name: "Preview" }, buffers, failed: 0 });
  }
}
