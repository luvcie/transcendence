import { expect, spyOn, test } from "bun:test";
import { customSkin } from "./src/skin-catalog";
import { createSkinPreviewLoader } from "./src/skin-preview-loader";

function preset(url: string, index: number) { return { ...customSkin(url, index), id: `preset-${index}` }; }

test("preview workers deduplicate preparation, cache compressed results, and release resources", async () => {
  const jobs: PreviewWorker[] = [], revoked: string[] = [];
  class PreviewWorker {
    onmessage?: (event: { data: unknown }) => void;
    onerror?: () => void;
    onmessageerror?: () => void;
    url = "";
    terminated = 0;
    constructor() { jobs.push(this); }
    postMessage({ url }: { url: string }) { this.url = url; }
    terminate() { this.terminated++; }
  }
  class PreviewImage {
    src = "";
    decoding = "";
    decode() { return Promise.resolve(); }
  }
  const names = ["Worker", "OffscreenCanvas", "createImageBitmap", "Image"];
  const originals = names.map(name => Object.getOwnPropertyDescriptor(globalThis, name));
  Object.assign(globalThis, { Worker: PreviewWorker, OffscreenCanvas: class {}, Image: PreviewImage,
    createImageBitmap: () => { throw new Error("Bitmap preparation must stay in the worker"); },
  });
  const revoke = spyOn(URL, "revokeObjectURL").mockImplementation(url => { revoked.push(url); });
  const blob = new Blob([new Uint8Array(12 * 1024 * 1024)]), def = preset("https://example.com/skin.tpse", 0);
  const flush = () => new Promise(resolve => setImmediate(resolve));
  const finish = (index: number) => jobs[index].onmessage!({ data: { blob, frames: 22, delay: 30, tile: 32, tiles: new Uint16Array(22 * 216) } });
  let fallback = 0;
  const load = createSkinPreviewLoader(async () => { fallback++; return undefined; });
  try {
    const first = load(def), second = load(def);
    await flush();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].url).toBe(def.url!);
    finish(0);
    const [a, b] = await Promise.all([first, second]);
    expect(a).toMatchObject({ preview: true, tile: 32, animation: { frames: 22, delay: 30 } });
    expect(a!.image).not.toBe(b!.image);
    expect(jobs[0].terminated).toBe(1);
    await load(def);
    expect(jobs).toHaveLength(1);
    expect(revoked).toHaveLength(3);
    for (let i = 1; i <= 2; i++) {
      const pending = load(preset(`https://example.com/${i}.tpse`, i));
      await flush(); finish(i); await pending;
    }
    const evicted = load(def);
    await flush();
    expect(jobs).toHaveLength(4);
    finish(3); await evicted;
    const failedDef = preset("https://example.com/broken.tpse", 0), failed = load(failedDef);
    await flush();
    jobs[4].onmessage!({ data: { error: "Invalid skin export" } });
    await expect(failed).rejects.toThrow("Invalid skin export");
    expect(jobs[4].terminated).toBe(1);
    const retry = load(failedDef);
    await flush();
    expect(jobs).toHaveLength(6);
    finish(5); await retry;
    const crashed = load(preset("https://example.com/crash.tpse", 0));
    await flush(); jobs[6].onerror!();
    await expect(crashed).rejects.toThrow("could not load");
    expect(jobs[6].terminated).toBe(1);
    const unreadable = load(preset("https://example.com/unreadable.tpse", 0));
    await flush(); jobs[7].onmessageerror!();
    await expect(unreadable).rejects.toThrow("could not be read");
    expect(jobs[7].terminated).toBe(1);
    const timer = spyOn(globalThis, "setTimeout").mockImplementationOnce((callback: TimerHandler) => {
      queueMicrotask(callback as () => void); return 0 as unknown as ReturnType<typeof setTimeout>;
    });
    try {
      await expect(load(preset("https://example.com/timeout.tpse", 0))).rejects.toThrow("timed out");
      expect(jobs[8].terminated).toBe(1);
    } finally { timer.mockRestore(); }
    const queuedA = load(preset("https://skins.test/queued-a.tpse", 0));
    const queuedB = load(preset("https://skins.test/queued-b.tpse", 1));
    await flush();
    expect(jobs).toHaveLength(10);
    finish(9); await queuedA; await flush();
    expect(jobs[9].terminated).toBe(1);
    expect(jobs).toHaveLength(11);
    finish(10); await queuedB;
    await load(preset("https://example.com/skin.png", 0));
    await load(customSkin(def.url!, 0));
    expect(fallback).toBe(2);
    Object.assign(globalThis, { OffscreenCanvas: undefined });
    await load(def);
    expect(fallback).toBe(3);
  } finally {
    revoke.mockRestore();
    revoked.forEach(url => URL.revokeObjectURL(url));
    names.forEach((name, index) => {
      if (originals[index]) Object.defineProperty(globalThis, name, originals[index]!);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
});

test("the worker validates exports, prepares compact frames, and closes decoded resources on failure", async () => {
  function png(width: number, height = width) {
    const bytes = new Uint8Array(24);
    bytes.set([137, 80, 78, 71, 13, 10, 26, 10]); bytes.set([73, 72, 68, 82], 12);
    const header = new DataView(bytes.buffer);
    header.setUint32(16, width); header.setUint32(20, height);
    return "data:image/png;base64," + btoa(String.fromCharCode(...bytes));
  }
  async function execute(data: unknown, failEncoding = false, gifDecoder?: "native" | "unsupported" | "failed" | "retry") {
    const sourceUrl = "https://you.have.fail/tetrioplus/data/tpsefiles/skin/future/skin.gif.tpse";
    const exportUrl = "data:application/json," + encodeURIComponent(JSON.stringify(data));
    const gif = [...new TextEncoder().encode("GIF89a"), 124, 0, 10, 0, 0, 0, 0];
    for (const ticks of [3, 4, 3]) gif.push(0x21, 0xf9, 4, 0, ticks, 0, 0, 0,
      0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x44, 1, 0);
    gif.push(0x3b);
    const script = `
      let closed = 0, crops = 0, exports = 0, decoderClosed = 0, sourceRequests = 0, canvas;
      const entries = new Map();
      const source = ${JSON.stringify(sourceUrl)};
      globalThis.caches = { open: async name => ({
        keys: async () => [...entries.keys()].filter(key => key.startsWith(name)).map(key => new Request(key.slice(name.length))),
        match: async url => entries.get(name + url)?.clone(),
        put: async (url, response) => { entries.set(name + url, response); },
        delete: async url => entries.delete(name + url),
      }) };
      const send = postMessage.bind(globalThis);
      globalThis.postMessage = data => queueMicrotask(() => send({ ...data, closed, crops, exports, decoderClosed, sourceRequests,
        gifCached: entries.has("42tris.custom-skin-animations.v1" + source), released: !canvas || canvas.width === 0 }));
      if (${!!gifDecoder}) {
        const originalFetch = fetch.bind(globalThis);
        globalThis.fetch = (url, options) => {
          if (String(url).startsWith("/api/skin-source?")) {
            const bytes = new Uint8Array(${JSON.stringify(gif)});
            if (++sourceRequests === 1 && ${gifDecoder === "retry"}) bytes[31] = 20;
            return Promise.resolve(new Response(bytes));
          }
          if (url === source) { exports++; return originalFetch(${JSON.stringify(exportUrl)}, options); }
          return originalFetch(url, options);
        };
        globalThis.ImageDecoder = class {
          static async isTypeSupported() { return ${gifDecoder !== "unsupported"}; }
          tracks = { ready: Promise.resolve() };
          constructor({ data }) { this.corrupt = new Uint8Array(data)[31] === 20; }
          async decode() {
            if (${gifDecoder === "failed"} || this.corrupt) throw new Error("GIF decoding failed");
            return { image: { close() { closed++; } } };
          }
          close() { decoderClosed++; }
        };
      }
      globalThis.createImageBitmap = async blob => {
        const header = new DataView(await blob.arrayBuffer());
        return { width: header.getUint32(16), height: header.getUint32(20), close() { closed++; } };
      };
      globalThis.OffscreenCanvas = class {
        constructor(width, height) { this.width = width; this.height = height; canvas = this; }
        getContext() { return { canvas: this, drawImage() { crops++; }, clearRect() {},
          getImageData: () => ({ data: new Uint8ClampedArray(this.width * this.height * 4) }),
          createImageData: (width, height) => ({ data: new Uint8ClampedArray(width * height * 4) }), putImageData() {},
        }; }
        async convertToBlob() {
          if (${failEncoding}) throw new Error("Preview encoding failed");
          return new Blob(["prepared preview"]);
        }
      };
      await import(${JSON.stringify(new URL("./src/skin-worker.ts", import.meta.url).href)});
      send("ready");
    `;
    const worker = new Worker("data:application/javascript;base64," + btoa(script));
    try {
      return await new Promise<{ blob?: Blob; error?: string }>((resolve, reject) => {
        const retry = gifDecoder === "retry";
        let attempted = false;
        const request = { url: gifDecoder ? sourceUrl : exportUrl, custom: retry };
        worker.onmessage = ({ data: result }) => {
          if (result === "ready") worker.postMessage(request);
          else if (retry && !attempted) {
            attempted = true;
            try {
              expect(result).toMatchObject({ frames: 3, exports: 1, sourceRequests: 1, gifCached: false, ghost: false });
              worker.postMessage(request);
            } catch (error) { reject(error); }
          } else resolve(result);
        };
        worker.onerror = event => reject(new Error(event.message));
      });
    } finally { worker.terminate(); }
  }
  const skin = { skin: png(2048), skinAnim: png(16384, 2048), skinAnimMeta: { frames: 22, delay: 30 } };
  const prepared = await execute(skin);
  expect(prepared).toMatchObject({ frames: 22, delay: 30, closed: 1, crops: 22 * 192, released: true, ghost: false });
  expect(await execute({ ...skin, ghostAnim: png(8192, 1024), ghostAnimMeta: { frames: 22, delay: 30 } }))
    .toMatchObject({ closed: 2, crops: 22 * 216, released: true, ghost: true });
  expect(await prepared.blob!.text()).toBe("prepared preview");
  expect(await execute(skin, true)).toMatchObject({ error: "Preview encoding failed", closed: 1, released: true });
  const malformed = await execute({});
  expect(malformed.error).toContain("PNG skin");
  expect(malformed).toMatchObject({ crops: 0, closed: 0, released: true });
  const strip = { skin: png(2048), skinAnim: png(3072, 1024), skinAnimMeta: { frames: 3, delay: 30 } };
  expect(await execute(strip, false, "native"))
    .toMatchObject({ frames: 3, frameEnds: [30, 70, 100], tile: 10, exports: 0, closed: 3, decoderClosed: 1, released: true, ghost: true });
  for (const decoder of ["unsupported", "failed"] as const) {
    expect(await execute(strip, false, decoder)).toMatchObject({ frames: 3, frameEnds: [30, 70, 100],
      tile: 46, exports: 1, closed: 1, decoderClosed: decoder === "failed" ? 1 : 0, released: true });
  }
  expect(await execute(strip, false, "retry"))
    .toMatchObject({ frames: 3, tile: 10, exports: 1, sourceRequests: 2, gifCached: true, ghost: true });
});
