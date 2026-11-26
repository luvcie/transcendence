export async function fetchExternalFile(url: string, limit: number, signal?: AbortSignal, timeoutMs?: number): Promise<ArrayBuffer> {
  return (await downloadFile(url, limit, downloadSignal(signal, timeoutMs))).bytes;
}

function downloadSignal(signal?: AbortSignal, timeoutMs = 12000) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

interface ExternalFile { bytes: ArrayBuffer; type: string }

async function downloadFile(url: string, limit: number, signal: AbortSignal) {
  const response = await fetch(url, { signal, credentials: "omit", referrerPolicy: "no-referrer" });
  return readFile(response, limit, signal);
}

async function readFile(response: Response, limit: number, signal: AbortSignal): Promise<ExternalFile> {
  signal.throwIfAborted();
  if (!response.ok) throw new Error(`Could not load file (HTTP ${response.status}).`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("The file was empty.");
  const chunks: Uint8Array[] = [];
  let length = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      length += value.byteLength;
      if (length > limit) throw new Error("The file is too large.");
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return { bytes: bytes.buffer, type: response.headers.get("Content-Type") ?? "" };
}

export function externalFileKey(url: string) {
  const key = new URL(url);
  key.hash = "";
  return key.href;
}

export class ExternalFileCache {
  private writes = Promise.resolve();
  private pendingAdds = 0;
  private readonly additionLock: string;
  constructor(private name: string, private maxEntries: number, private maxBytes?: number) {
    this.additionLock = name + ".additions";
  }

  async duringAdd<T>(add: () => Promise<T>): Promise<T> {
    const locks = globalThis.navigator?.locks;
    if (locks) return locks.request(this.additionLock, { mode: "shared" }, add);
    this.pendingAdds++;
    try { return await add(); }
    finally { this.pendingAdds--; }
  }

  private update(change: (cache: Cache) => Promise<void>) {
    const apply = async () => {
      const cache = await globalThis.caches?.open(this.name);
      if (cache) await change(cache);
    };
    const write = this.writes.then(async () => {
      // workers and tabs can write to the same cache
      const locks = globalThis.navigator?.locks;
      if (locks) await locks.request(this.name, apply);
      else await apply();
    }).catch(() => {});
    this.writes = write;
    return write;
  }

  retain(urls: () => readonly string[]) {
    return this.update(async cache => {
      const prune = async () => {
        const entries = await cache.keys();
        if (this.pendingAdds) return;
        const keep = new Set(urls().map(externalFileKey));
        let bytes = 0;
        for (const entry of entries) {
          if (keep.has(entry.url)) {
            if (this.maxBytes === undefined) continue;
            const size = await this.entrySize(cache, entry);
            if (bytes + size <= this.maxBytes) { bytes += size; continue; }
          }
          await cache.delete(entry);
        }
      };
      // an add can cache several files before saving the preference that keeps them
      const locks = globalThis.navigator?.locks;
      if (locks) await locks.request(this.additionLock, { ifAvailable: true }, lock => lock ? prune() : undefined);
      else await prune();
    });
  }

  remove(url: string) {
    return this.update(async cache => { await cache.delete(externalFileKey(url)); });
  }

  private async entrySize(cache: Cache, entry: Request | string) {
    const response = await cache.match(entry);
    if (!response) return 0;
    const length = response.headers.get("Content-Length");
    return length === null ? (await response.blob()).size : Number(length);
  }

  async sizeOf(url: string) {
    try {
      const cache = await globalThis.caches?.open(this.name);
      return cache ? await this.entrySize(cache, externalFileKey(url)) : 0;
    } catch { return 0; }
  }

  async load<T>(url: string, limit: number, signal: AbortSignal | undefined, validate: (file: ExternalFile) => Promise<T> | T,
    timeoutMs?: number, source: string | typeof fetchExternalFile = url, shouldStore?: (file: ExternalFile) => boolean | Promise<boolean>): Promise<T> {
    const key = externalFileKey(url);
    const request = downloadSignal(signal, timeoutMs);
    let cached: Response | undefined;
    try { cached = await (await globalThis.caches?.open(this.name))?.match(key); } catch {}
    request.throwIfAborted();
    let file: ExternalFile, value: T;
    try {
      file = cached ? await readFile(cached, limit, request)
        : typeof source === "string" ? await downloadFile(source, limit, request)
        : { bytes: await source(url, limit, request, timeoutMs), type: "" };
      request.throwIfAborted();
      if (file.bytes.byteLength > limit) throw new Error("The file is too large.");
      value = await validate(file);
    } catch (error) {
      if (cached && !signal?.aborted && error !== request.reason) await this.remove(url);
      throw error;
    }
    if (!cached && (!shouldStore || await shouldStore(file))) await this.update(async cache => {
      const entries = await cache.keys();
      if (signal?.aborted || entries.some(entry => entry.url === key) || entries.length >= this.maxEntries) return;
      const length = file.bytes.byteLength;
      if (this.maxBytes !== undefined) {
        let total = length;
        if (total > this.maxBytes) return;
        for (const entry of entries) {
          total += await this.entrySize(cache, entry);
          if (total > this.maxBytes) return;
        }
      }
      if (signal?.aborted) return;
      await cache.put(key, new Response(file.bytes, { headers: { "Content-Type": file.type, "Content-Length": String(length) } }));
    });
    signal?.throwIfAborted();
    return value;
  }
}
