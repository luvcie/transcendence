import { MINOS, Piece, pieceEdges } from "@42tris/core";
import type { LoadedSkin } from "./skin-loader";
import { connectionMask, drawTile, skinFrame } from "./tile-renderer";

export const ids: Record<string, number> = {
  "🟥": Piece.Z, "🟧": Piece.L, "🟨": Piece.O, "🟩": Piece.S, "⬜": Piece.I, "🟦": Piece.J, "🟪": Piece.T,
};
const cols = 10;
const maxBytes = 512 * 1024 * 1024;

// animated skins get a frame every tick so their animation keeps running during each hold
export function timeline(holds: number[], animated: boolean, tick = 100) {
  const out: { step: number; at: number; duration: number }[] = [];
  let at = 0;
  for (let step = 0; step < holds.length; step++) {
    const total = step === holds.length - 1 ? holds[step] * 2 : holds[step];
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

function drawBoard(ctx: CanvasRenderingContext2D, board: string[], rows: number, cell: number, look: GifLook, frame: number) {
  ctx.fillStyle = "#111";
  ctx.fillRect(0, 0, cols * cell, rows * cell);
  ctx.font = `${cell * .85}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const offset = rows - board.length;
  const edges = look !== "emoji" && look?.connected
    ? tetrominoEdges(board.flatMap(line => [...line].map(emoji => ids[emoji] ?? 0))) : undefined;
  board.forEach((line, y) => [...line].forEach((emoji, x) => {
    const id = ids[emoji];
    if (look === "emoji") {
      if (emoji !== "⬛") ctx.fillText(emoji, (x + .5) * cell, (y + offset + .55) * cell);
    } else if (id) drawTile(ctx, id, x * cell, (y + offset) * cell, cell, look,
      edges ? connectionMask(edges[y * cols + x]) : 0, false, frame);
  }));
}

// each rotation as offsets from its first cell in reading order, that cell is where a tiling places it
const shapes = MINOS.map(rots => rots.map(minos => {
  const pairs = Array.from({ length: 4 }, (_, i) => [minos[i * 2], minos[i * 2 + 1]])
    .sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  return pairs.flatMap(([x, y]) => [x - pairs[0][0], y - pairs[0][1]]);
}));

/**
 * Edges like core boardEdges for a board that only knows colours: a same colour area that splits
 * exactly into its own tetromino gets joined along that split, anything else stays single blocks.
 */
export function tetrominoEdges(cells: ArrayLike<number>) {
  const edges = new Uint8Array(cells.length), seen = new Uint8Array(cells.length);
  for (let start = 0; start < cells.length; start++) {
    const id = cells[start];
    if (seen[start] || id < 1 || id > 7) continue;
    const area: number[] = [start];
    seen[start] = 1;
    for (let k = 0; k < area.length; k++) {
      const at = area[k], x = at % cols;
      for (const next of [x > 0 ? at - 1 : -1, x < cols - 1 ? at + 1 : -1, at - cols, at + cols]) {
        if (next >= 0 && next < cells.length && !seen[next] && cells[next] === id) {
          seen[next] = 1;
          area.push(next);
        }
      }
    }
    if (area.length % 4) continue;
    area.sort((a, b) => a - b);
    const left = new Set(area), placed: [number, number[]][] = [];
    // backtracking a big blob can blow up, past this many tries it stays single blocks
    let budget = 5000;
    const tile = (): boolean => {
      const anchor = area.find(cell => left.has(cell));
      if (anchor === undefined) return true;
      for (const shape of shapes[id]) {
        if (budget-- <= 0) return false;
        const at: number[] = [];
        for (let i = 0; i < 8; i += 2) {
          const x = anchor % cols + shape[i], cell = anchor + shape[i + 1] * cols + shape[i];
          if (x >= 0 && x < cols && left.has(cell)) at.push(cell);
        }
        if (at.length < 4) continue;
        at.forEach(cell => left.delete(cell));
        placed.push([anchor, shape]);
        if (tile()) return true;
        placed.pop();
        at.forEach(cell => left.add(cell));
      }
      return false;
    };
    if (!tile()) continue;
    for (const [anchor, shape] of placed) {
      for (let i = 0; i < 8; i += 2) edges[anchor + shape[i + 1] * cols + shape[i]] = pieceEdges(shape, i);
    }
  }
  return edges;
}

export const animatedLook = (look: GifLook) => look !== "emoji" && !!look?.animation;

/** `holds` is how long each board shows, the last one is held twice as long. */
export async function makeGif(canvas: HTMLCanvasElement, boards: string[][], cell: number, look: GifLook, holds: number[]) {
  const { rows, width, height } = gifSize(boards, cell);
  const skin = look === "emoji" ? undefined : look;
  const frames = timeline(holds, animatedLook(look));
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
