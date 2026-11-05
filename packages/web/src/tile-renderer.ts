import { MINOS, pieceEdges, type PieceId } from "@42tris/core";
import type { LoadedSkin } from "./skin-loader";
import { TETRIO_CONNECTION_ROWS, TETRIO_PIECE_OFFSETS, TETRIO_SKIN_ROWS } from "./tetrio-skins";

export const COLORS = ["", "#ef4444", "#f97316", "#eab308", "#22c55e", "#22d3ee", "#3b82f6", "#a855f7", "#6b7280"];

export function skinFrame(skin: LoadedSkin): number {
  return skin.animation ? Math.floor(performance.now() * 60 / (1000 * skin.animation.delay)) % skin.animation.frames : 0;
}

export function drawTile(ctx: CanvasRenderingContext2D, id: number, x: number, y: number,
  size: number, skin?: LoadedSkin, connections = 0, ghost = false) {
  // Ghosts and garbage never read sprite columns, including with a custom sheet.
  if (skin && !ghost && id >= 1 && id <= 7) {
    const row = skin.connected ? TETRIO_CONNECTION_ROWS[connections]
      : skin.def.join ? (connections & 8 ? skin.def.join.joined : skin.def.join.open) : 0;
    const frame = skinFrame(skin);
    const columns = Math.min(skin.animation?.frames ?? 1, 16);
    ctx.drawImage(skin.image, (frame % columns * 9 + id + 1) * skin.tile,
      (Math.floor(frame / columns) * TETRIO_SKIN_ROWS + row) * skin.tile, skin.tile, skin.tile, x, y, size, size);
  } else {
    ctx.fillStyle = COLORS[id];
    ctx.fillRect(x, y, size, size);
  }
}

export function connectionMask(edges: number): number {
  const top = edges & 8, right = edges & 4, bottom = edges & 2, left = edges & 1;
  let mask = edges & 15;
  if (top && right && !(edges & 16) || right && bottom && !(edges & 32)
    || bottom && left && !(edges & 64) || left && top && !(edges & 128)) mask |= 16;
  return mask;
}

export function pieceConnections(minos: ArrayLike<number>, index: number): number {
  return connectionMask(pieceEdges(minos, index));
}

export function previewLayout(piece: PieceId, width: number, height: number, cell: number) {
  const minos = MINOS[piece][0];
  let minX = 4, maxX = 0, minY = 4, maxY = 0;
  for (let i = 0; i < 8; i += 2) {
    minX = Math.min(minX, minos[i]); maxX = Math.max(maxX, minos[i]);
    minY = Math.min(minY, minos[i + 1]); maxY = Math.max(maxY, minos[i + 1]);
  }
  return { x: (width - (maxX - minX + 1) * cell) / 2 - minX * cell,
    y: (height - (maxY - minY + 1) * cell) / 2 - minY * cell };
}

export function drawPiecePreview(ctx: CanvasRenderingContext2D, piece: PieceId, cell: number,
  width: number, height: number, offsetY = 0, skin?: LoadedSkin) {
  if (skin?.preview) {
    const frame = skinFrame(skin), columns = Math.min(skin.animation?.frames ?? 1, 16);
    ctx.drawImage(skin.image, (frame % columns * 7 + piece - 1) * 128, Math.floor(frame / columns) * 64,
      128, 64, (width - cell * 4) / 2, offsetY + (height - cell * 2) / 2, cell * 4, cell * 2);
    return;
  }
  const minos = MINOS[piece][0];
  const offset = previewLayout(piece, width, height, cell);
  for (let i = 0; i < 8; i += 2) {
    const x = offset.x + minos[i] * cell, y = offsetY + offset.y + minos[i + 1] * cell;
    drawTile(ctx, piece, x, y, cell, skin, pieceConnections(minos, i));
    if (!skin) {
      ctx.strokeStyle = "#333";
      ctx.strokeRect(x + 0.5, y + 0.5, cell - 1, cell - 1);
    }
  }
}

export function renderSkinPreview(image: ImageBitmap, frames: number,
  makeCanvas = (width: number, height: number) => new OffscreenCanvas(width, height)): OffscreenCanvas {
  const columns = Math.min(frames, 16), rows = Math.ceil(frames / 16);
  const width = image.width / columns, cell = width * 3 / 64, padding = width >= 2048 ? 2 : 1;
  const canvas = makeCanvas(128 * 7 * columns, 64 * rows);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Skin preview needs a 2D canvas.");
  ctx.imageSmoothingEnabled = false;
  for (let frame = 0; frame < frames; frame++) {
    const fx = frame % columns, fy = Math.floor(frame / columns);
    TETRIO_PIECE_OFFSETS.forEach(([ox, oy], i) => {
      const minos = MINOS[i + 1][0], offset = previewLayout((i + 1) as PieceId, 128, 64, 32);
      for (let j = 0; j < 8; j += 2) {
        const row = TETRIO_CONNECTION_ROWS[pieceConnections(minos, j)];
        ctx.drawImage(image, fx * width + (ox + row % 4) * cell + padding,
          fy * width + (oy + Math.floor(row / 4)) * cell + padding, cell - padding * 2, cell - padding * 2,
          (fx * 7 + i) * 128 + offset.x + minos[j] * 32, fy * 64 + offset.y + minos[j + 1] * 32, 32, 32);
      }
    });
  }
  return canvas;
}
