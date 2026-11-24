import { MINOS, pieceEdges, type PieceId } from "@42tris/core";
import type { LoadedSkin } from "./skin-loader";
import { scaledTile } from "./tile-cache";
import { TETRIO_CONNECTION_ROWS, TETRIO_SKIN_ROWS } from "./tetrio-skins";

export const COLORS = ["", "#ef4444", "#f97316", "#eab308", "#22c55e", "#22d3ee", "#3b82f6", "#a855f7", "#6b7280"];

export function skinFrame(skin: LoadedSkin, now = performance.now()): number {
  const ends = skin.animation?.frameEnds;
  if (ends) {
    const time = now % ends[ends.length - 1];
    for (let frame = 0; frame < ends.length; frame++) if (time < ends[frame]) return frame;
  }
  return skin.animation ? Math.floor(now * 60 / (1000 * skin.animation.delay)) % skin.animation.frames : 0;
}

export function drawTile(ctx: CanvasRenderingContext2D, id: number, x: number, y: number,
  size: number, skin?: LoadedSkin, connections = 0, ghost = false, frame = skin ? skinFrame(skin) : 0) {
  // without the skin's own ghost, ghosts stay flat colors
  if (skin && (!ghost || skin.ghost) && id >= 1 && id <= 8) {
    const row = skin.connected ? TETRIO_CONNECTION_ROWS[connections]
      : skin.def.join ? (connections & 8 ? skin.def.join.joined : skin.def.join.open) : 0;
    const columns = skin.tiles ? skin.image.width / skin.tile : 9;
    // sheets keep the jstris order: garbage, ghost, then Z to T
    const slot = skin.tiles ? skin.tiles[(frame * TETRIO_SKIN_ROWS + row) * 9 + (ghost ? 8 : id - 1)]
      : row * 9 + (ghost ? 1 : (id + 1) % 9);
    const sx = slot % columns * skin.tile, sy = Math.floor(slot / columns) * skin.tile;
    const cached = scaledTile(ctx, skin, size, slot, sx, sy);
    if (ctx.imageSmoothingEnabled) ctx.imageSmoothingEnabled = false;
    if (cached) ctx.drawImage(cached.page.bitmap ?? cached.page.ctx.canvas, cached.x, cached.y, size, size, x, y, size, size);
    else ctx.drawImage(skin.image, sx, sy, skin.tile, skin.tile, x, y, size, size);
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
  return { x: Math.round((width - (maxX - minX + 1) * cell) / 2) - minX * cell,
    y: Math.round((height - (maxY - minY + 1) * cell) / 2) - minY * cell };
}

export function drawPiecePreview(ctx: CanvasRenderingContext2D, piece: PieceId, cell: number,
  width: number, height: number, offsetY = 0, skin?: LoadedSkin) {
  const frame = skin ? skinFrame(skin) : 0;
  const minos = MINOS[piece][0];
  const offset = previewLayout(piece, width, height, cell);
  for (let i = 0; i < 8; i += 2) {
    const x = offset.x + minos[i] * cell, y = offsetY + offset.y + minos[i + 1] * cell;
    drawTile(ctx, piece, x, y, cell, skin, pieceConnections(minos, i), false, frame);
    if (!skin) {
      ctx.strokeStyle = "#333";
      ctx.strokeRect(x + 0.5, y + 0.5, cell - 1, cell - 1);
    }
  }
}
