import { MINOS, pieceEdges, type PieceId } from "@42tris/core";
import type { LoadedSkin } from "./skin-loader";
import { TETRIO_CONNECTION_ROWS, TETRIO_SKIN_ROWS } from "./tetrio-skins";

export const COLORS = ["", "#ef4444", "#f97316", "#eab308", "#22c55e", "#22d3ee", "#3b82f6", "#a855f7", "#6b7280"];

export function drawTile(ctx: CanvasRenderingContext2D, id: number, x: number, y: number,
  size: number, skin?: LoadedSkin, connections = 0, ghost = false) {
  // Ghosts and garbage never read sprite columns, including with a custom sheet.
  if (skin && !ghost && id >= 1 && id <= 7) {
    const row = skin.connected ? TETRIO_CONNECTION_ROWS[connections]
      : skin.def.join ? (connections & 8 ? skin.def.join.joined : skin.def.join.open) : 0;
    const frame = skin.animation ? Math.floor(performance.now() * 60 / (1000 * skin.animation.delay)) % skin.animation.frames : 0;
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
