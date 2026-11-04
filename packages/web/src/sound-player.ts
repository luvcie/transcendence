import { soundUrls, type SoundClip, type SoundPack } from "./sound-pack";
import { MAX_TETRIO_EXPORT_BYTES, parseTetrioExport, tetrioClipSource, tetrioClipUrl, tetrioSoundPack, type SoundAtlas } from "./tetrio-sounds";
import { fetchExternalFile } from "./external-file";

export interface LoadedSounds { pack: SoundPack; buffers: Map<string, AudioBuffer>; failed: number }
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const MAX_DECODED_BYTES = 64 * 1024 * 1024;
const MAX_TETRIO_DECODED_BYTES = 256 * 1024 * 1024;

export class SoundPlayer {
  private context?: AudioContext;
  private gain?: GainNode;
  private cache = new Map<string, AudioBuffer>();
  private cacheBytes = 0;
  private atlases = new Map<string, SoundAtlas>();
  private tetrioQueue: Promise<void> = Promise.resolve();
  private sources = new Set<AudioBufferSourceNode>();
  private previewRequest?: AbortController;
  volume = 0.5;

  constructor(private makeContext = () => new AudioContext({ latencyHint: "interactive" }), private fetchFile = fetchExternalFile) {}

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
  private remember(url: string, buffer: AudioBuffer) {
    const existing = this.cache.get(url);
    if (existing) this.cacheBytes -= this.size(existing);
    this.cache.delete(url);
    while (this.cache.size && (this.cacheBytes + this.size(buffer) > MAX_DECODED_BYTES || this.cache.size >= 128)) {
      const first = this.cache.keys().next().value!;
      this.cacheBytes -= this.size(this.cache.get(first)!);
      this.cache.delete(first);
    }
    this.cache.set(url, buffer); this.cacheBytes += this.size(buffer);
  }
  private async tetrioPack(pack: SoundPack, signal: AbortSignal, extra: string[] = []): Promise<SoundPack> {
    // Full exports include menu audio. Decode one at a time, then retain only gameplay clips.
    const previous = this.tetrioQueue;
    let release!: () => void;
    this.tetrioQueue = new Promise(resolve => { release = resolve; });
    await previous;
    try {
      signal.throwIfAborted();
      const url = pack.tetrioPlus!;
      const urls = soundUrls(pack);
      let atlas = this.atlases.get(url);
      const resolve = () => urls.length ? pack : tetrioSoundPack(pack.name, url, Object.keys(atlas!));
      const names = (resolved: SoundPack) => [...new Set([...soundUrls(resolved).flatMap(value => {
        const clip = tetrioClipSource(value);
        return clip?.url === url ? [clip.name] : [];
      }), ...extra])];
      if (urls.length && !names(pack).length) return pack;
      if (atlas && names(resolve()).every(name => this.cache.has(tetrioClipUrl(url, name)))) return resolve();
      const bytes = await this.fetchFile(url, MAX_TETRIO_EXPORT_BYTES, signal, 45000);
      signal.throwIfAborted();
      let data: unknown;
      try { data = JSON.parse(new TextDecoder().decode(bytes)); }
      catch { throw new Error("Use a TETR.IO+ .tpse export link, not a ZIP download."); }
      const exported = parseTetrioExport(data);
      atlas = exported.atlas;
      const resolved = resolve();
      const wanted = names(resolved).filter(name => atlas![name]);
      if (!wanted.length) throw new Error("This export has no sounds for 42tris gameplay.");
      const context = this.audio();
      const seconds = Math.max(...Object.values(atlas).map(([offset, duration]) => offset + duration));
      if (seconds * context.sampleRate * 2 * 4 > MAX_TETRIO_DECODED_BYTES) throw new Error("This TETR.IO+ recording is too long.");
      const audio = await context.decodeAudioData(exported.audio);
      signal.throwIfAborted();
      if (audio.numberOfChannels > 2 || this.size(audio) > MAX_TETRIO_DECODED_BYTES) throw new Error("This TETR.IO+ recording exceeds the decoding limit.");
      let total = 0;
      const clips: [string, AudioBuffer][] = [];
      for (const name of wanted) {
        const [offset, duration] = atlas[name];
        if (duration > 30 || offset + duration > audio.duration + 1 / audio.sampleRate) throw new Error("TETR.IO+ sound timing exceeds the audio clip.");
        const start = Math.round(offset * audio.sampleRate), end = Math.min(audio.length, Math.round((offset + duration) * audio.sampleRate));
        if (end <= start) throw new Error("A TETR.IO+ sound is empty.");
        total += (end - start) * audio.numberOfChannels * 4;
        if (total > MAX_DECODED_BYTES) throw new Error("This pack exceeds the audio memory limit.");
        const clip = context.createBuffer(audio.numberOfChannels, end - start, audio.sampleRate);
        for (let channel = 0; channel < audio.numberOfChannels; channel++) clip.copyToChannel(audio.getChannelData(channel).subarray(start, end), channel);
        clips.push([tetrioClipUrl(url, name), clip]);
      }
      signal.throwIfAborted();
      for (const [url, clip] of clips) this.remember(url, clip);
      if (this.atlases.size >= 32) this.atlases.delete(this.atlases.keys().next().value!);
      this.atlases.set(url, atlas);
      return resolved;
    } finally { release(); }
  }
  private async buffer(url: string, signal: AbortSignal): Promise<AudioBuffer> {
    const cached = this.cache.get(url);
    if (cached) { this.cache.delete(url); this.cache.set(url, cached); return cached; }
    const clip = tetrioClipSource(url);
    if (clip) {
      await this.tetrioPack({ name: "TETR.IO+ sound pack", tetrioPlus: clip.url }, signal, [clip.name]);
      const buffer = this.cache.get(url);
      if (!buffer) throw new Error(`This TETR.IO+ export has no ${clip.name} sound.`);
      return buffer;
    }
    const context = this.audio();
    const bytes = await this.fetchFile(url, MAX_AUDIO_BYTES, signal);
    const buffer = await context.decodeAudioData(bytes);
    signal.throwIfAborted();
    const size = this.size(buffer);
    if (size > MAX_DECODED_BYTES) throw new Error("This audio clip is too long.");
    // A preview and a pack load can finish the same URL concurrently.
    const existing = this.cache.get(url);
    if (existing) return existing;
    this.remember(url, buffer);
    return buffer;
  }
  async load(pack: SoundPack, signal: AbortSignal): Promise<LoadedSounds> {
    if (pack.tetrioPlus) pack = await this.tetrioPack(pack, signal);
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
    request.signal.throwIfAborted();
    const buffers = new Map<string, AudioBuffer>();
    for (const clip of clips) buffers.set(clip.url, await this.buffer(clip.url, request.signal));
    request.signal.throwIfAborted();
    this.play(clips, { pack: { name: "Preview" }, buffers, failed: 0 });
  }
}
