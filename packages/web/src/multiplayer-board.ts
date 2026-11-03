import type { GameState, PieceId } from "@42tris/core";
import { drawSnapshot } from "./board-view";
import { drawPiecePreview } from "./tile-renderer";
import type { LoadedSkin } from "./skin-loader";

export function setGarbage(meter: HTMLElement, lines: number) {
  meter.setAttribute("aria-valuemax", String(Math.max(40, lines)));
  meter.setAttribute("aria-valuenow", String(lines));
  meter.setAttribute("aria-valuetext", `${lines} incoming garbage lines`);
  meter.setAttribute("style", `--garbage: ${Math.min(lines / 40, 1) * 100}%`);
}

export function createMultiplayerBoard(document: Document) {
  const container = document.createElement("section");
  container.className = "opponent";
  const label = document.createElement("p");
  label.className = "opponent-label";
  const field = document.createElement("div");
  field.className = "opponent-field";
  const preview = (title: string, height: number) => {
    const panel = document.createElement("aside");
    panel.className = "preview-panel";
    const heading = document.createElement("p"); heading.textContent = title;
    const canvas = document.createElement("canvas"); canvas.width = 150; canvas.height = height;
    panel.append(heading, canvas);
    return { panel, canvas };
  };
  const hold = preview("Hold", 90);
  const next = preview("Next", 450);
  const frame = document.createElement("div"); frame.className = "board-frame";
  const meter = document.createElement("div"); meter.className = "garbage-meter";
  meter.setAttribute("role", "meter"); meter.setAttribute("aria-valuemin", "0"); meter.setAttribute("aria-valuemax", "40");
  const fill = document.createElement("div"); fill.className = "garbage-fill"; meter.append(fill);
  const canvas = document.createElement("canvas");
  canvas.width = 300; canvas.height = 600;
  frame.append(meter, canvas);
  field.append(hold.panel, frame, next.panel);
  container.append(field, label);
  return { container, canvas, label, meter, hold: hold.canvas, next: next.canvas };
}

export type MultiplayerBoard = ReturnType<typeof createMultiplayerBoard>;

export function drawMultiplayerBoard(board: MultiplayerBoard, game: GameState, skin?: LoadedSkin, ghost = false) {
  drawSnapshot(board.canvas.getContext("2d")!, game, skin, ghost);
  const hold = board.hold.getContext("2d")!;
  const next = board.next.getContext("2d")!;
  hold.clearRect(0, 0, board.hold.width, board.hold.height);
  next.clearRect(0, 0, board.next.width, board.next.height);
  if (game.state.held !== null) drawPiecePreview(hold, game.state.held, 30, 150, 90, 0, skin);
  game.previews.forEach((piece, i) => drawPiecePreview(next, piece as PieceId, 30, 150, 90, i * 90, skin));
}
