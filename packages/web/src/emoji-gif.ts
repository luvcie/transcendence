import { Piece } from "@42tris/core";
import type { LoadedSkin } from "./skin-loader";
import { drawTile, skinFrame } from "./tile-renderer";

export const ids: Record<string, number> = {
  "🟥": Piece.Z, "🟧": Piece.L, "🟨": Piece.O, "🟩": Piece.S, "⬜": Piece.I, "🟦": Piece.J, "🟪": Piece.T,
};
const cols = 10;
const maxBytes = 512 * 1024 * 1024;

// animated skins get a frame every tick so their animation keeps running during each hold
export function timeline(steps: number, animated: boolean, hold = 1000, tick = 100) {
  const out: { step: number; at: number; duration: number }[] = [];
  let at = 0;
  for (let step = 0; step < steps; step++) {
    const total = step === steps - 1 ? hold * 2 : hold;
    const parts = animated ? Math.max(1, Math.round(total / tick)) : 1;
    for (let i = 0; i < parts; i++) {
      out.push({ step, at, duration: Math.round(total / parts) });
      at += total / parts;
    }
  }
  return out;
}

export type GifLook = LoadedSkin | "emoji" | undefined;

export function gifSize(boards: string[][], cell: number) {
  const rows = Math.max(...boards.map(board => board.length));
  return { rows, width: cell * cols, height: cell * rows };
}

// an emoji grid cannot tell touching pieces apart, so connected skins draw single blocks
function drawBoard(ctx: CanvasRenderingContext2D, board: string[], rows: number, cell: number, look: GifLook, frame: number) {
  ctx.fillStyle = "#111";
  ctx.fillRect(0, 0, cols * cell, rows * cell);
  ctx.font = `${cell * .85}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const offset = rows - board.length;
  board.forEach((line, y) => [...line].forEach((emoji, x) => {
    const id = ids[emoji];
    if (look === "emoji") {
      if (emoji !== "⬛") ctx.fillText(emoji, (x + .5) * cell, (y + offset + .55) * cell);
    } else if (id) drawTile(ctx, id, x * cell, (y + offset) * cell, cell, look, 0, false, frame);
  }));
}

export async function makeGif(canvas: HTMLCanvasElement, boards: string[][], cell: number, look: GifLook, hold: number) {
  const { rows, width, height } = gifSize(boards, cell);
  const skin = look === "emoji" ? undefined : look;
  const frames = timeline(boards.length, !!skin?.animation, hold);
  if (frames.length < 2) throw new Error("Pick at least 2 steps for a GIF.");
  if (frames.length * width * height * 4 > maxBytes) throw new Error("That GIF is too big. Lower the block size.");
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const data = frames.map(({ step, at }) => {
    drawBoard(ctx, boards[step], rows, cell, look, skin ? skinFrame(skin, at) : 0);
    return ctx.getImageData(0, 0, width, height).data.buffer;
  });
  return encodeInWorker({ frames: data, width, height, durations: frames.map(frame => frame.duration) });
}

function encodeInWorker(job: { frames: ArrayBuffer[]; width: number; height: number; durations: number[] }) {
  const worker = new Worker(new URL("./gif-worker.ts", import.meta.url), { type: "module" });
  return new Promise<Uint8Array>((resolve, reject) => {
    worker.onmessage = ({ data }: MessageEvent<Uint8Array | { error: string }>) =>
      "error" in data ? reject(new Error(data.error)) : resolve(data);
    worker.onerror = () => reject(new Error("GIF encoder failed to load."));
    worker.postMessage(job, job.frames);
  }).finally(() => worker.terminate());
}
