import type { LoadedSkin } from "./skin-loader";

export interface PreparedSkin { blob: Blob; frames: number; delay: number; tile: number; tiles: Uint16Array; frameEnds?: number[] }
let preparation = Promise.resolve();

export function canPrepareSkin() {
  return typeof Worker !== "undefined" && typeof OffscreenCanvas !== "undefined" && typeof createImageBitmap !== "undefined";
}

export function prepareSkin(url: string): Promise<PreparedSkin> {
  const run = () => {
    const worker = new Worker(new URL("./skin-worker.ts", import.meta.url), { type: "module" });
    let timer: ReturnType<typeof setTimeout>;
    return new Promise<PreparedSkin>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Skin timed out. Try again.")), 30_000);
      worker.onmessage = ({ data }: MessageEvent<PreparedSkin | { error: string }>) => {
        if ("error" in data) reject(new Error(data.error));
        else resolve(data);
      };
      worker.onerror = () => reject(new Error("Skin could not load. Try again."));
      worker.onmessageerror = () => reject(new Error("Skin could not be read. Try again."));
      worker.postMessage(url);
    }).finally(() => { clearTimeout(timer); worker.terminate(); });
  };
  const request = preparation.then(run);
  preparation = request.then(() => undefined, () => undefined);
  return request;
}

export async function decodePreparedSkin(prepared: PreparedSkin): Promise<Omit<LoadedSkin, "def">> {
  const url = URL.createObjectURL(prepared.blob), image = new Image();
  try {
    image.decoding = "async"; image.src = url;
    await image.decode();
    return { image, tile: prepared.tile, connected: true, tiles: prepared.tiles,
      ...(prepared.frames > 1 ? { animation: { frames: prepared.frames, delay: prepared.delay, frameEnds: prepared.frameEnds } } : {}) };
  } finally { URL.revokeObjectURL(url); }
}
