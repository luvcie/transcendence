import { ROWS, VISIBLE_ROWS, MINOS, canPlace, cellAt, type GameState } from "@42tris/core";
import type { LoadedSkin } from "./skin-loader";
import { drawTile, joinedAbove } from "./tile-renderer";
import { snapshotDisplay, type GameDisplay } from "./game-display";

type BoardView = Pick<GameDisplay, "board" | "piece" | "rot" | "x" | "y" | "starting" | "topOut">;

export function drawSnapshot(ctx: CanvasRenderingContext2D, state: GameState, skin?: LoadedSkin) {
  drawBoard(ctx, snapshotDisplay(state), skin, false);
}

export function drawBoard(ctx: CanvasRenderingContext2D, game: BoardView, skin?: LoadedSkin, ghost = true) {
  const width = game.board.length / ROWS;
  if (ctx.canvas.width !== width * 30) ctx.canvas.width = width * 30;
  const cell = ctx.canvas.width / width;
  const hidden = ROWS - VISIBLE_ROWS;
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  for (let y = 0; y < VISIBLE_ROWS; y++) {
    for (let x = 0; x < width; x++) {
      const id = cellAt(game.board, x, y + hidden);
      if (id) drawTile(ctx, id, x * cell, y * cell, cell, skin, cellAt(game.board, x, y + hidden - 1) === id);
    }
  }
  const piece = (y: number, isGhost: boolean) => {
    const minos = MINOS[game.piece][game.rot];
    for (let i = 0; i < 8; i += 2) {
      const py = y + minos[i + 1] - hidden;
      if (py >= 0) drawTile(ctx, game.piece, (game.x + minos[i]) * cell, py * cell,
        cell, skin, joinedAbove(minos, i), isGhost);
    }
  };
  if (!game.starting) {
    if (ghost && !game.topOut) {
      let y = game.y;
      while (canPlace(game.board, game.piece, game.rot, game.x, y + 1)) y++;
      if (y !== game.y) {
        ctx.globalAlpha = .25;
        piece(y, true);
        ctx.globalAlpha = 1;
      }
    }
    piece(game.y, false);
  }
  ctx.strokeStyle = "#333";
  ctx.beginPath();
  for (let x = 0; x <= width; x++) {
    ctx.moveTo(x * cell + .5, 0); ctx.lineTo(x * cell + .5, VISIBLE_ROWS * cell);
  }
  for (let y = 0; y <= VISIBLE_ROWS; y++) {
    ctx.moveTo(0, y * cell + .5); ctx.lineTo(width * cell, y * cell + .5);
  }
  ctx.stroke();
}
