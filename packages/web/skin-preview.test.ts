import { expect, spyOn, test } from "bun:test";
import { customSkin } from "./src/skin-catalog";
import { createSkinPreviewLoader } from "./src/skin-preview-loader";

test("preview workers deduplicate preparation, cache compressed results, and release resources", async () => {
  const jobs: PreviewWorker[] = [], revoked: string[] = [];
  class PreviewWorker {
    onmessage?: (event: { data: unknown }) => void;
    onerror?: () => void;
    onmessageerror?: () => void;
    url = "";
    terminated = 0;
    constructor() { jobs.push(this); }
    postMessage(url: string) { this.url = url; }
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
  const blob = new Blob([new Uint8Array(12 * 1024 * 1024)]), def = customSkin("https://example.com/skin.tpse", 0);
  const finish = (index: number) => jobs[index].onmessage!({ data: { blob, frames: 22, delay: 30 } });
  let fallback = 0;
  const load = createSkinPreviewLoader(async () => { fallback++; return undefined; });
  try {
    const first = load(def), second = load(def);
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
      const pending = load(customSkin(`https://example.com/${i}.tpse`, i));
      finish(i); await pending;
    }
    const evicted = load(def);
    expect(jobs).toHaveLength(4);
    finish(3); await evicted;
    const failedDef = customSkin("https://example.com/broken.tpse", 0), failed = load(failedDef);
    jobs[4].onmessage!({ data: { error: "Invalid skin export" } });
    await expect(failed).rejects.toThrow("Invalid skin export");
    expect(jobs[4].terminated).toBe(1);
    const retry = load(failedDef);
    expect(jobs).toHaveLength(6);
    finish(5); await retry;
    const crashed = load(customSkin("https://example.com/crash.tpse", 0));
    jobs[6].onerror!();
    await expect(crashed).rejects.toThrow("could not load");
    expect(jobs[6].terminated).toBe(1);
    const unreadable = load(customSkin("https://example.com/unreadable.tpse", 0));
    jobs[7].onmessageerror!();
    await expect(unreadable).rejects.toThrow("could not be read");
    expect(jobs[7].terminated).toBe(1);
    const timer = spyOn(globalThis, "setTimeout").mockImplementationOnce((callback: TimerHandler) => {
      queueMicrotask(callback as () => void); return 0 as unknown as ReturnType<typeof setTimeout>;
    });
    try {
      await expect(load(customSkin("https://example.com/timeout.tpse", 0))).rejects.toThrow("timed out");
      expect(jobs[8].terminated).toBe(1);
    } finally { timer.mockRestore(); }
    await load(customSkin("https://example.com/skin.png", 0));
    expect(fallback).toBe(1);
    Object.assign(globalThis, { OffscreenCanvas: undefined });
    await load(def);
    expect(fallback).toBe(2);
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
  async function execute(data: unknown, failEncoding = false) {
    const script = `
      let closed = 0, crops = 0, canvas;
      const send = postMessage.bind(globalThis);
      globalThis.postMessage = data => queueMicrotask(() => send({ ...data, closed, crops, released: !canvas || canvas.width === 0 }));
      globalThis.createImageBitmap = async blob => {
        const header = new DataView(await blob.arrayBuffer());
        return { width: header.getUint32(16), height: header.getUint32(20), close() { closed++; } };
      };
      globalThis.OffscreenCanvas = class {
        constructor(width, height) { this.width = width; this.height = height; canvas = this; }
        getContext() { return { drawImage() { crops++; } }; }
        async convertToBlob() {
          if (${failEncoding}) throw new Error("Preview encoding failed");
          return new Blob(["prepared preview"]);
        }
      };
      await import(${JSON.stringify(new URL("./src/skin-preview-worker.ts", import.meta.url).href)});
      send("ready");
    `;
    const worker = new Worker("data:application/javascript;base64," + btoa(script));
    try {
      return await new Promise<{ blob?: Blob; frames?: number; delay?: number; error?: string; closed: number; crops: number; released: boolean }>((resolve, reject) => {
        worker.onmessage = ({ data: result }) => {
          if (result === "ready") worker.postMessage("data:application/json," + encodeURIComponent(JSON.stringify(data)));
          else resolve(result);
        };
        worker.onerror = event => reject(new Error(event.message));
      });
    } finally { worker.terminate(); }
  }
  const skin = { skin: png(2048), skinAnim: png(16384, 2048), skinAnimMeta: { frames: 22, delay: 30 } };
  const prepared = await execute(skin);
  expect(prepared).toMatchObject({ frames: 22, delay: 30, closed: 1, crops: 22 * 28, released: true });
  expect(await prepared.blob!.text()).toBe("prepared preview");
  expect(await execute(skin, true)).toMatchObject({ error: "Preview encoding failed", closed: 1, released: true });
  const malformed = await execute({});
  expect(malformed.error).toContain("PNG skin");
  expect(malformed).toMatchObject({ crops: 0, closed: 0, released: true });
});
