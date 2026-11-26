import { soundUrls, type SoundClip, type SoundPack } from "./sound-pack";
import { MAX_TETRIO_EXPORT_BYTES, parseTetrioExport, tetrioClipSource, tetrioClipUrl, tetrioSoundPack, type SoundAtlas } from "./tetrio-sounds";
import { externalFileKey, fetchExternalFile } from "./external-file";
import { MAX_CACHED_PACK_BYTES, soundClips, soundExports, soundFileUrls, type SoundLoadMode } from "./sound-files";

type CacheBytes = (url: string, bytes: number) => boolean | Promise<boolean>;

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
  private sources = new Set<AudioScheduledSourceNode>();
  private nextFeedbackAt = 0;
  private previewRequest?: AbortController;
  volume = 0.5;

  constructor(private makeContext = () => new AudioContext({ latencyHint: "interactive" }), private fetchFile?: typeof fetchExternalFile) {}

  audio() {
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
  volumeFeedback() {
    if (!this.volume) return;
    const context = this.audio(), now = context.currentTime;
    if (context.state !== "running" || now < this.nextFeedbackAt) return;
    this.nextFeedbackAt = now + 0.05;
    const tone = context.createOscillator(), envelope = context.createGain();
    tone.frequency.value = 880;
    envelope.gain.setValueAtTime(0.1, now);
    envelope.gain.exponentialRampToValueAtTime(0.001, now + 0.05);
    tone.connect(envelope); envelope.connect(this.gain!);
    tone.onended = () => { this.sources.delete(tone); tone.disconnect(); envelope.disconnect(); };
    this.sources.add(tone);
    tone.start(now); tone.stop(now + 0.05);
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
  private async tetrioPack(pack: SoundPack, signal: AbortSignal, extra: string[], mode: SoundLoadMode | undefined,
    accept: (url: string, buffer: AudioBuffer) => boolean, cacheBytes?: CacheBytes): Promise<SoundPack> {
    // decode one export at a time: full exports include menu audio
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
      if (mode !== "import" && atlas) {
        const resolved = resolve();
        const keys = names(resolved).map(name => tetrioClipUrl(url, name));
        if (keys.every(key => this.cache.has(key))) {
          for (const key of keys) accept(key, this.cache.get(key)!);
          return resolved;
        }
      }
      let accepted = false;
      const decode = async ({ bytes }: { bytes: ArrayBuffer }) => {
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
        for (const [url, clip] of clips) if (accept(url, clip)) {
          accepted = true;
          this.remember(url, clip);
        }
        if (this.atlases.size >= 32) this.atlases.delete(this.atlases.keys().next().value!);
        this.atlases.set(url, atlas);
        return resolved;
      };
      return mode ? await soundExports.load(url, MAX_TETRIO_EXPORT_BYTES, signal, decode, 45000, this.fetchFile,
        ({ bytes }) => accepted && (cacheBytes?.(url, bytes.byteLength) ?? true))
        : await decode({ bytes: await (this.fetchFile ?? fetchExternalFile)(url, MAX_TETRIO_EXPORT_BYTES, signal, 45000) });
    } finally { release(); }
  }
  private async buffer(url: string, signal: AbortSignal, mode?: SoundLoadMode,
    accept = (_buffer: AudioBuffer) => true, cacheBytes?: CacheBytes): Promise<AudioBuffer> {
    const clip = tetrioClipSource(url);
    const key = mode && !clip ? `custom:${url}` : url;
    const cached = this.cache.get(key);
    if (cached && mode !== "import") {
      if (accept(cached)) { this.cache.delete(key); this.cache.set(key, cached); }
      return cached;
    }
    if (clip) {
      let buffer: AudioBuffer | undefined;
      await this.tetrioPack({ name: "TETR.IO+ sound pack", tetrioPlus: clip.url, ...(mode ? { move: url } : {}) },
        signal, [clip.name], mode, (key, decoded) => {
          if (key !== url) return true;
          buffer = decoded;
          return accept(decoded);
        }, cacheBytes);
      if (!buffer) throw new Error(`This TETR.IO+ export has no ${clip.name} sound.`);
      return buffer;
    }
    const context = this.audio();
    let accepted = false;
    const decode = async (bytes: ArrayBuffer) => {
      const buffer = await context.decodeAudioData(bytes);
      signal.throwIfAborted();
      if (this.size(buffer) > MAX_DECODED_BYTES) throw new Error("This audio clip is too long.");
      accepted = accept(buffer);
      return buffer;
    };
    // decodeAudioData detaches its input
    const buffer = mode ? await soundClips.load(url, MAX_AUDIO_BYTES, signal, ({ bytes }) => decode(bytes.slice(0)), undefined, this.fetchFile,
      ({ bytes }) => accepted && (cacheBytes?.(url, bytes.byteLength) ?? true))
      : await decode(await (this.fetchFile ?? fetchExternalFile)(url, MAX_AUDIO_BYTES, signal));
    if (accepted) this.remember(key, buffer);
    return buffer;
  }
  async load(pack: SoundPack, signal: AbortSignal, mode?: SoundLoadMode): Promise<LoadedSounds> {
    const buffers = new Map<string, AudioBuffer>();
    let next = 0, decodedBytes = 0, cachedBytes = 0;
    let sizing: Promise<void> | undefined;
    const counted = new Set<string>();
    const sources = mode && soundFileUrls(pack);
    const cacheBytes: CacheBytes = async (url, bytes) => {
      // count already saved bytes before competing downloads reserve space
      sizing ??= Promise.all(sources ? [
        ...[...new Set(sources.clips.map(externalFileKey))].map(async key => [key, await soundClips.sizeOf(key)] as const),
        ...[...new Set(sources.exports)].map(async key => [key, await soundExports.sizeOf(key)] as const),
      ] : []).then(sizes => {
        for (const [key, size] of sizes) if (size && !counted.has(key)) {
          counted.add(key);
          cachedBytes += size;
        }
      });
      await sizing;
      const key = externalFileKey(url);
      if (counted.has(key)) return true;
      if (cachedBytes + bytes > MAX_CACHED_PACK_BYTES) return false;
      cachedBytes += bytes;
      counted.add(key);
      return true;
    };
    const accept = (url: string, buffer: AudioBuffer) => {
      const size = this.size(buffer);
      if (decodedBytes + size > MAX_DECODED_BYTES) return false;
      decodedBytes += size;
      buffers.set(url, buffer);
      return true;
    };
    if (pack.tetrioPlus) pack = await this.tetrioPack(pack, signal, [], mode, accept, cacheBytes);
    const urls = soundUrls(pack);
    await Promise.all(Array.from({ length: Math.min(6, urls.length) }, async () => {
      while (next < urls.length) {
        signal.throwIfAborted();
        const url = urls[next++];
        try {
          if (pack.tetrioPlus && tetrioClipSource(url)?.url === pack.tetrioPlus) continue;
          await this.buffer(url, signal, mode, buffer => accept(url, buffer), cacheBytes);
        } catch { signal.throwIfAborted(); }
      }
    }));
    if (urls.length && !buffers.size) throw new Error("No audio could be loaded. Check the links and the host's CORS settings, then retry.");
    return { pack, buffers, failed: urls.length - buffers.size };
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
  async preview(clips: SoundClip[], custom = false) {
    this.stop();
    const request = new AbortController();
    this.previewRequest = request;
    await this.unlock();
    request.signal.throwIfAborted();
    const buffers = new Map<string, AudioBuffer>();
    for (const clip of clips) {
      buffers.set(clip.url, await this.buffer(clip.url, request.signal, custom ? "custom" : undefined, undefined, () => false));
    }
    request.signal.throwIfAborted();
    this.play(clips, { pack: { name: "Preview" }, buffers, failed: 0 });
  }
}
