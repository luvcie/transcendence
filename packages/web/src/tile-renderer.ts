import { MINOS, type PieceId } from "@42tris/core";
import type { LoadedSkin } from "./skin-loader";

export const COLORS = ["", "#ef4444", "#f97316", "#eab308", "#22c55e", "#22d3ee", "#3b82f6", "#a855f7", "#6b7280"];

export function drawTile(ctx: CanvasRenderingContext2D, id: number, x: number, y: number,
  size: number, skin?: LoadedSkin, joinedAbove = false, ghost = false) {
  // Ghosts and garbage never read sprite columns, including with a custom sheet.
  if (skin && !ghost && id >= 1 && id <= 7) {
    const row = skin.def.join ? (joinedAbove ? skin.def.join.joined : skin.def.join.open) : 0;
    ctx.drawImage(skin.image, (id + 1) * skin.tile, row * skin.tile, skin.tile, skin.tile, x, y, size, size);
  } else {
    ctx.fillStyle = COLORS[id];
    ctx.fillRect(x, y, size, size);
  }
}

export function joinedAbove(minos: ArrayLike<number>, index: number): boolean {
  for (let j = 0; j < minos.length; j += 2) {
    if (minos[j] === minos[index] && minos[j + 1] === minos[index + 1] - 1) return true;
  }
  return false;
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
  const minos = MINOS[piece][0];
  const offset = previewLayout(piece, width, height, cell);
  for (let i = 0; i < 8; i += 2) {
    const x = offset.x + minos[i] * cell, y = offsetY + offset.y + minos[i + 1] * cell;
    drawTile(ctx, piece, x, y, cell, skin, joinedAbove(minos, i));
    if (!skin) {
      ctx.strokeStyle = "#333";
      ctx.strokeRect(x + 0.5, y + 0.5, cell - 1, cell - 1);
    }
  }
}
