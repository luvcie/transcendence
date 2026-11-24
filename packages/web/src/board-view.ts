import { ROWS, VISIBLE_ROWS, MINOS, boardEdges, canPlace, cellAt, type GameState } from "@42tris/core";
import { fitCanvas } from "./canvas-resolution";
import type { LoadedSkin } from "./skin-loader";
import { connectionMask, drawTile, pieceConnections, skinFrame } from "./tile-renderer";
import { snapshotDisplay, type GameDisplay } from "./game-display";

type BoardView = Pick<GameDisplay, "board" | "piece" | "rot" | "x" | "y" | "starting" | "topOut">;
type BoardPaint = { -readonly [K in Exclude<keyof BoardView, "board">]: BoardView[K] } & {
  board: Uint8Array; edges: Uint8Array; cell: number;
  skin?: LoadedSkin; frame: number; ghost: boolean;
};

const painted = new WeakMap<HTMLCanvasElement, BoardPaint>();
const hidden = ROWS - VISIBLE_ROWS;

function forgetBoard(event: Event) {
  painted.delete(event.currentTarget as HTMLCanvasElement);
}

function sameCells(previous: Uint8Array, current: ArrayLike<number>) {
  for (let i = 0; i < current.length; i++) if (previous[i] !== current[i]) return false;
  return true;
}

function drawFallingPiece(ctx: CanvasRenderingContext2D, game: BoardView, y: number, cell: number,
  skin: LoadedSkin | undefined, frame: number, ghost: boolean) {
  const minos = MINOS[game.piece][game.rot];
  for (let i = 0; i < 8; i += 2) {
    const py = y + minos[i + 1] - hidden;
    if (py >= 0) drawTile(ctx, game.piece, (game.x + minos[i]) * cell, py * cell,
      cell, skin, pieceConnections(minos, i), ghost, frame);
  }
}

export function drawSnapshot(ctx: CanvasRenderingContext2D, state: GameState, skin?: LoadedSkin, ghost = false) {
  drawBoard(ctx, snapshotDisplay(state), skin, ghost);
}

export function drawBoard(ctx: CanvasRenderingContext2D, game: BoardView, skin?: LoadedSkin, ghost = true) {
  const canvas = ctx.canvas;
  const width = game.board.length / ROWS;
  const oldWidth = canvas.width, oldHeight = canvas.height;
  const cell = fitCanvas(canvas, width, VISIBLE_ROWS);
  const edges = skin?.connected ? boardEdges(game.board) : undefined;
  const frame = skin ? skinFrame(skin) : 0;
  let last = painted.get(canvas);
  if (last && oldWidth === width * cell && oldHeight === VISIBLE_ROWS * cell
    && last.cell === cell && last.skin === skin && last.frame === frame && last.ghost === ghost
    && last.piece === game.piece && last.rot === game.rot && last.x === game.x && last.y === game.y
    && last.starting === game.starting && last.topOut === game.topOut
    && last.board.length === game.board.length && sameCells(last.board, game.board)
    && (!edges || sameCells(last.edges, edges))) return;
  if (!last || last.board.length !== game.board.length) {
    if (!last) canvas.addEventListener?.("contextrestored", forgetBoard);
    last = { board: new Uint8Array(game.board.length), edges: new Uint8Array(game.board.length),
      cell, skin, frame, ghost, piece: game.piece, rot: game.rot, x: game.x, y: game.y,
      starting: game.starting, topOut: game.topOut };
    painted.set(canvas, last);
  }
  last.cell = cell; last.skin = skin; last.frame = frame; last.ghost = ghost;
  last.piece = game.piece; last.rot = game.rot; last.x = game.x; last.y = game.y;
  last.starting = game.starting; last.topOut = game.topOut;
  last.board.set(game.board);
  if (edges) last.edges.set(edges);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  for (let y = 0; y < VISIBLE_ROWS; y++) {
    for (let x = 0; x < width; x++) {
      const id = cellAt(game.board, x, y + hidden);
      if (id) {
        const connections = edges ? connectionMask(edges[(y + hidden) * width + x])
          : cellAt(game.board, x, y + hidden - 1) === id ? 8 : 0;
        drawTile(ctx, id, x * cell, y * cell, cell, skin, connections, false, frame);
      }
    }
  }
  if (!game.starting) {
    if (ghost && !game.topOut) {
      let y = game.y;
      while (canPlace(game.board, game.piece, game.rot, game.x, y + 1)) y++;
      if (y !== game.y) {
        ctx.globalAlpha = .25;
        drawFallingPiece(ctx, game, y, cell, skin, frame, true);
        ctx.globalAlpha = 1;
      }
    }
    drawFallingPiece(ctx, game, game.y, cell, skin, frame, false);
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
