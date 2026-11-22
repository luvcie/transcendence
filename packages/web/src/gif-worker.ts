/// <reference lib="webworker" />
import encode from "gifski-wasm";

const scope = self as unknown as DedicatedWorkerGlobalScope;
scope.onmessage = async ({ data }: MessageEvent<{ frames: ArrayBuffer[]; width: number; height: number; durations: number[] }>) => {
  try {
    const gif = await encode({
      frames: data.frames.map(frame => new Uint8Array(frame)),
      width: data.width, height: data.height, frameDurations: data.durations,
    });
    scope.postMessage(gif);
  } catch (error) {
    scope.postMessage({ error: (error as Error).message });
  }
};
