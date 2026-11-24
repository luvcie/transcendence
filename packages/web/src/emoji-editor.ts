import type { SkinState } from "./skin-state";
import { blockNames, empty, ids } from "./board-emoji";
import { mountBoardFocus } from "./board-focus";
import { animatedLook, makeGif, tetrominoEdges, timeline } from "./emoji-gif";
import type { GifPlanJob, GifPlanMessage } from "./gif-planner-worker";
import { BUILTIN_SKINS, customSkin } from "./skin-catalog";
import { resolveSkin, type SkinPreferences } from "./skin-preferences";
import type { LoadedSkin } from "./skin-loader";
import { connectionMask, drawTile, skinFrame } from "./tile-renderer";
import type { Handling } from "@42tris/core";
import type { Keybinds } from "./keybinds";
import type { Singleplayer } from "./singleplayer";
import type { GameSounds } from "./game-sounds";
import { drawQueue, gameToLines, playBoard, playCells, boardQueue, boardToGame, type PlayRun } from "./editor-play";

const openers = {
  "TKI": [
    [
      "⬛⬛⬛🟦🟦🟦⬛⬛⬛⬛",
      "🟧⬛⬛🟥🟥🟦🟩⬛⬛⬛",
      "🟧⬛⬛⬛🟥🟥🟩🟩🟨🟨",
      "🟧🟧⬛⬜⬜⬜⬜🟩🟨🟨",
    ],
  ],
  "SDPC": [
    [
      "⬛⬛⬛⬛⬛⬛⬛⬛🟩⬛",
      "⬜⬛⬛⬛⬛⬛⬛⬛🟩🟩",
      "⬜🟦🟦⬛⬛⬛⬛⬛⬛🟩",
      "⬜🟦🟧🟧🟧🟥🟥⬛🟨🟨",
      "⬜🟦🟧⬛⬛⬛🟥🟥🟨🟨",
    ],
    [
      "⬛⬛⬛⬛⬛⬛⬛⬛🟩⬛",
      "⬜⬛⬛⬛⬛⬛⬛⬛🟩🟩",
      "⬜🟧🟦⬛⬛⬛⬛⬛⬛🟩",
      "⬜🟧🟦🟦🟦🟥🟥⬛🟨🟨",
      "⬜🟧🟧⬛⬛⬛🟥🟥🟨🟨",
    ],
  ],
  "C-Spin": [
    [
      "⬛⬛⬛⬛⬛⬛⬛⬛⬛⬛",
      "⬛⬛⬛⬛⬛⬛⬛⬛⬛⬛",
      "🟦🟦⬛⬛⬛⬛⬛⬛⬛⬛",
      "🟦⬛⬛⬛⬛⬛⬛⬛⬛⬛",
      "🟦⬛🟪🟪🟪⬛⬛⬛⬛⬛",
      "🟧⬛⬛🟪🟩⬛⬛⬛🟨🟨",
      "🟧⬛🟥🟥🟩🟩⬛⬛🟨🟨",
      "🟧🟧⬛🟥🟥🟩⬜⬜⬜⬜",
    ],
  ],
  "DT Cannon": [
    [
      "⬛⬛🟧🟧⬛⬛⬛⬛⬛⬛",
      "⬛⬛⬛🟧⬛⬛⬛⬛⬛⬛",
      "🟦🟦⬛🟧🟪⬛⬛⬛⬛⬛",
      "🟦⬛⬛🟪🟪🟪⬜⬛⬛⬛",
      "🟦⬛⬛⬛🟩🟩⬜🟥🟥⬛",
      "🟨🟨⬛🟩🟩🟧⬜🟦🟥🟥",
      "🟨🟨⬛🟧🟧🟧⬜🟦🟦🟦",
    ],
    [
      "⬛⬛🟧🟧⬛⬛⬛⬛⬛⬛",
      "⬛⬛⬛🟧⬛⬛⬛⬛⬛⬛",
      "🟦🟦⬛🟧🟪⬛⬛⬛⬛⬛",
      "🟦⬛⬛🟪🟪🟪⬜⬛⬛⬛",
      "🟦⬛⬛⬛🟥🟦⬜🟧🟩⬛",
      "🟨🟨⬛🟥🟥🟦⬜🟧🟩🟩",
      "🟨🟨⬛🟥🟦🟦⬜🟧🟧🟩",
    ],
  ],
  "PCO": [
    [
      "🟧🟧🟧⬛⬛⬛⬛⬛🟩🟩",
      "🟧🟨🟨⬛⬛⬛⬛🟩🟩🟪",
      "🟪🟨🟨⬛⬛⬛🟥🟥🟪🟪",
      "🟪🟪🟪⬛⬛⬛⬛🟥🟥🟪",
    ],
  ],
  "Sarcelle": [
    [
      "🟦🟦⬛⬛⬛⬛⬛⬛⬛⬛",
      "🟦🟪🟪🟪⬛⬛⬛⬛⬛⬜",
      "🟦🟥🟪⬛⬛⬛⬛🟧🟧⬜",
      "🟥🟥🟩🟩⬛⬛🟨🟨🟧⬜",
      "🟥🟩🟩⬛⬛⬛🟨🟨🟧⬜",
    ],
    [
      "🟨🟨⬛⬛⬛⬛⬛⬛⬛⬛",
      "🟨🟨🟩🟩⬛⬛⬛⬛⬛⬜",
      "🟧🟩🟩⬛⬛⬛⬛🟥🟦⬜",
      "🟧🟪🟪🟪⬛⬛🟥🟥🟦⬜",
      "🟧🟧🟪⬛⬛⬛🟥🟦🟦⬜",
    ],
  ],
};

// steps after the opener itself, shown with the arrow buttons
const continuations: Record<string, string[][]> = {
  "C-Spin": [
    [
      "⬛⬛⬛⬛⬛⬛⬛⬛⬛🟦",
      "⬛⬛⬛⬛⬛⬛⬛⬛⬛🟦",
      "🟦🟦⬛⬛🟩🟧🟧⬜🟦🟦",
      "🟦⬛⬛⬛🟩🟩🟧⬜🟨🟨",
      "🟦⬛🟪🟪🟪🟩🟧⬜🟨🟨",
      "🟧⬛⬛🟪🟩🟥🟥⬜🟨🟨",
      "🟧⬛🟥🟥🟩🟩🟥🟥🟨🟨",
      "🟧🟧⬛🟥🟥🟩⬜⬜⬜⬜",
    ],
  ],
  "TKI": [
    [
      "⬛⬛⬛🟦🟦🟦⬛⬛⬛⬛",
      "🟧⬛⬛🟥🟥🟦🟩⬛⬛⬛",
      "🟧🟪🟪🟪🟥🟥🟩🟩🟨🟨",
      "🟧🟧🟪⬜⬜⬜⬜🟩🟨🟨",
    ],
    [
      "⬛⬛⬛🟦🟦🟦⬛⬛⬛⬛",
      "🟧⬛⬛🟥🟥🟦🟩⬛⬛⬛",
    ],
    [
      "⬛⬛⬛⬛⬛⬛⬜⬛⬛⬛",
      "⬛⬛⬛🟥🟥⬛⬜🟧🟧🟧",
      "🟩⬛⬛⬛🟥🟥⬜🟧🟨🟨",
      "🟩🟩⬛🟦🟦🟦⬜🟦🟨🟨",
      "🟧🟩⬛🟥🟥🟦🟩🟦🟦🟦",
    ],
    [
      "⬛⬛⬛⬛⬛⬛⬜⬛⬛⬛",
      "⬛⬛⬛🟥🟥⬛⬜🟧🟧🟧",
      "🟩🟪🟪🟪🟥🟥⬜🟧🟨🟨",
      "🟩🟩🟪🟦🟦🟦⬜🟦🟨🟨",
      "🟧🟩⬛🟥🟥🟦🟩🟦🟦🟦",
    ],
    [
      "⬛⬛⬛⬛⬛⬛⬜⬛⬛⬛",
      "⬛⬛⬛🟥🟥⬛⬜🟧🟧🟧",
      "🟧🟩⬛🟥🟥🟦🟩🟦🟦🟦",
    ],
    [
      "⬛⬛⬛⬛⬛⬜⬛⬛⬛⬛",
      "⬛⬛⬛⬛⬛⬜⬛🟥⬛⬛",
      "⬛⬛⬛⬛⬛⬜🟥🟥🟨🟨",
      "🟧⬛⬛⬛🟩⬜🟥🟦🟨🟨",
      "🟧⬛⬛⬛🟩🟩⬜🟦🟦🟦",
      "🟧🟧⬛🟥🟥🟩⬜🟧🟧🟧",
      "🟧🟩⬛🟥🟥🟦🟩🟦🟦🟦",
    ],
  ],
};

const cols = 10;
const rows = 20;

function planGif(job: GifPlanJob, onProgress: (step: number, total: number) => void) {
  const worker = new Worker(new URL("./gif-planner-worker.ts", import.meta.url), { type: "module" });
  return new Promise<Extract<GifPlanMessage, { kind: "done" }>["plan"]>((resolve, reject) => {
    worker.onmessage = ({ data }: MessageEvent<GifPlanMessage>) => {
      if (data.kind === "progress") onProgress(data.step, data.total);
      else resolve(data.plan);
    };
    worker.onerror = () => reject(new Error("Could not plan the GIF animation."));
    worker.postMessage(job);
  }).finally(() => worker.terminate());
}

// boards sit side by side, so a row of boards wraps on narrow chat clients
export function arrangeBoards(boards: string[][], perRow: number) {
  const groups: string[] = [];
  for (let i = 0; i < boards.length; i += perRow) {
    const group = boards.slice(i, i + perRow);
    const height = Math.max(...group.map(board => board.length));
    groups.push(Array.from({ length: height }, (_, row) =>
      group.map(board => board[row - (height - board.length)] ?? empty.repeat(cols)).join(" ")).join("\n"));
  }
  return groups;
}
const mirrorPair: Record<string, string> = { "🟥": "🟩", "🟩": "🟥", "🟦": "🟧", "🟧": "🟦" };
const blocks = Object.entries(blockNames);

export function mirrorRows(board: string[]) {
  return board.map(row => Array.from(row).reverse().map(value => mirrorPair[value] ?? value).join(""));
}

const modeKey = "tetorisueditor.emojiMode";
export const parseEmojiMode = (raw: string | null) => raw === "true";

const skinKey = "tetorisueditor.skin";
// the editor keeps its own skin and starts from the game's
export const editorSkin = (saved: string | null, preferences: SkinPreferences) =>
  resolveSkin({ ...preferences, active: saved ?? preferences.active });

export type SavedOpener = { name: string; steps: string[][] };
const storeKey = "tetorisueditor.openers";
const maxSaved = 12;
const maxName = 20;
const maxSteps = 20;
const known = new Set<string>(blocks.map(([emoji]) => emoji));
const validBoard = (board: unknown) => Array.isArray(board) && board.length <= rows && board.every(row =>
  typeof row === "string" && Array.from(row).length === cols && Array.from(row).every(value => known.has(value)));

export function parseBoardText(text: string): string[] | string {
  const lines = text.split(/\r\n?|\n/).map(line => line.trim()).filter(Boolean)
    .map(line => line.replace(/(.)[\uFE0E\uFE0F]/gu, "$1").replace(/[🔲◼]/gu, empty).replaceAll("◻", "⬜"));
  if (lines.length > rows) return `A board can have at most ${rows} rows.`;
  if (!lines.length || !validBoard(lines)) return `Each row needs ${cols} board emojis.`;
  return lines;
}

export function boardCells(layout: string[]) {
  const padding = Array<string>((rows - layout.length) * cols).fill(empty);
  return padding.concat(layout.flatMap(row => [...row]));
}

// storage can hold anything, so keep only entries that look like what we wrote
export function parseSavedOpeners(raw: string | null): SavedOpener[] {
  try {
    const data = JSON.parse(raw ?? "[]");
    if (!Array.isArray(data)) return [];
    return data.filter(item => typeof item?.name === "string" && item.name.length > 0 && item.name.length <= maxName &&
      Array.isArray(item.steps) && item.steps.length > 0 && item.steps.length <= maxSteps && item.steps.every(validBoard))
      .slice(0, maxSaved);
  } catch {
    return [];
  }
}

function readSaved() {
  try {
    return parseSavedOpeners(localStorage.getItem(storeKey));
  } catch {
    return [];
  }
}

export function mountEmojiEditor(root: HTMLElement, skins: SkinState,
  gameplay: { bindings: Keybinds; handling(): Handling; ghost(): boolean; sounds: GameSounds }) {
  const { ownerDocument: document } = root;
  const board = root.querySelector<HTMLElement>("#emoji-board")!;
  const palette = root.querySelector<HTMLElement>("#emoji-palette")!;
  const colorsLeft = palette.querySelector<HTMLElement>("#emoji-colors-left")!;
  const colorsRight = palette.querySelector<HTMLElement>("#emoji-colors-right")!;
  const presets = root.querySelector<HTMLElement>("#emoji-openers")!;
  const status = root.querySelector<HTMLElement>("#emoji-status")!;
  const stepLabel = root.querySelector<HTMLElement>("#emoji-step-label")!;
  const stepBack = root.querySelector<HTMLButtonElement>("#emoji-step-back")!;
  const stepNext = root.querySelector<HTMLButtonElement>("#emoji-step-next")!;
  const seqFrom = root.querySelector<HTMLInputElement>("#emoji-seq-from")!;
  const seqTo = root.querySelector<HTMLInputElement>("#emoji-seq-to")!;
  const perRow = root.querySelector<HTMLSelectElement>("#emoji-per-row")!;
  const copySeq = root.querySelector<HTMLButtonElement>("#emoji-copy-seq")!;
  const emojiMode = root.querySelector<HTMLInputElement>("#emoji-mode")!;
  const skinInput = root.querySelector<HTMLInputElement>("#emoji-skin")!;
  const skinList = root.querySelector<HTMLElement>("#emoji-skins")!;
  const gifBlock = root.querySelector<HTMLInputElement>("#emoji-gif-block")!;
  const gifSeconds = root.querySelector<HTMLInputElement>("#emoji-gif-seconds")!;
  const gifAnimate = root.querySelector<HTMLInputElement>("#emoji-gif-animate")!;
  const gifHint = root.querySelector<HTMLElement>("#emoji-gif-hint")!;
  const gifBuild = root.querySelector<HTMLInputElement>("#emoji-gif-build")!;
  const gifBuildLabel = root.querySelector<HTMLElement>("#emoji-gif-build-label")!;
  const exportGif = root.querySelector<HTMLButtonElement>("#emoji-export-gif")!;
  const gifResult = root.querySelector<HTMLElement>("#emoji-gif-result")!;
  const gifPreview = root.querySelector<HTMLImageElement>("#emoji-gif-preview")!;
  const gifDownload = root.querySelector<HTMLButtonElement>("#emoji-gif-download")!;
  const autoSplit = root.querySelector<HTMLInputElement>("#emoji-auto-split")!;
  const codeBlock = root.querySelector<HTMLInputElement>("#emoji-code-block")!;
  const splits = root.querySelector<HTMLElement>("#emoji-splits")!;
  const seqTools = root.querySelector<HTMLElement>("#emoji-seq")!;
  const savedList = root.querySelector<HTMLElement>("#emoji-custom")!;
  const addStep = root.querySelector<HTMLButtonElement>("#emoji-add-step")!;
  const removeStep = root.querySelector<HTMLButtonElement>("#emoji-remove-step")!;
  const saveSequence = root.querySelector<HTMLButtonElement>("#emoji-save")!;
  const deleteSaved = root.querySelector<HTMLButtonElement>("#emoji-delete")!;
  const copy = root.querySelector<HTMLButtonElement>("#emoji-copy")!;
  const mirror = root.querySelector<HTMLButtonElement>("#emoji-mirror")!;
  const copyHalf = root.querySelector<HTMLButtonElement>("#emoji-copy-half")!;
  const playButton = root.querySelector<HTMLButtonElement>("#emoji-play")!;
  const keep = root.querySelector<HTMLButtonElement>("#emoji-keep")!;
  const stopButton = root.querySelector<HTMLButtonElement>("#emoji-stop")!;
  const matchBag = root.querySelector<HTMLInputElement>("#emoji-match-bag")!;
  const holdCtx = root.querySelector<HTMLCanvasElement>("#emoji-hold")!.getContext("2d")!;
  const nextCtx = root.querySelector<HTMLCanvasElement>("#emoji-next")!.getContext("2d")!;
  const cells = Array.from({ length: cols * rows }, () => makeButton(empty, "emoji-cell"));
  const canvas = document.createElement("canvas");
  const swatches: [HTMLButtonElement, number][] = [];
  let swatchSkin: LoadedSkin | undefined | null = null;
  let skin: LoadedSkin | undefined;
  let frameRequest = 0;
  let queued = false;
  let selected: string = blocks[0][0];
  let mirrored = false;
  type StrokeSource = "pointer" | "touch-pointer" | "touch";
  let stroke: { source: StrokeSource; id: number; value: string; lastCell: number } | null = null;
  let play: PlayRun | null = null;
  let drawn: string[] = [];

  for (const label of root.querySelectorAll<HTMLLabelElement>(".emoji-gesture label")) {
    const mode = label.querySelector<HTMLInputElement>("input")!;
    label.addEventListener("pointerup", event => {
      if (event.pointerType === "touch" && event.isPrimary &&
        label.contains(document.elementFromPoint(event.clientX, event.clientY))) mode.checked = true;
    });
  }

  function makeButton(text: string, className = "") {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.textContent = text;
    return button;
  }

  function paint(index: number, value: string) {
    const cell = cells[index];
    cell.textContent = value;
    cell.setAttribute("aria-label", `Row ${Math.floor(index / cols) + 1}, column ${index % cols + 1}: ${value === empty ? "Empty" : blockNames[value]}`);
    redraw();
  }

  function drawCell(ctx: CanvasRenderingContext2D, id: number | undefined, x: number, y: number, size: number,
    skin: LoadedSkin | undefined, frame: number, ghost = false, connections = 0) {
    ctx.fillStyle = "#111";
    ctx.fillRect(x, y, size, size);
    if (ghost) ctx.globalAlpha = .25;
    if (id) drawTile(ctx, id, x, y, size, skin, connections, ghost, frame);
    ctx.globalAlpha = 1;
    if (!id || !skin) {
      ctx.strokeStyle = "#333";
      ctx.strokeRect(x + .5, y + .5, size - 1, size - 1);
    }
  }

  function paintSwatches(skin: LoadedSkin | undefined) {
    swatchSkin = skin;
    const tile = document.createElement("canvas");
    tile.width = tile.height = 32;
    const ctx = tile.getContext("2d")!;
    for (const [button, id] of swatches) {
      drawCell(ctx, id, 0, 0, 32, skin, 0);
      button.style.setProperty("--tile", `url(${tile.toDataURL()})`);
    }
  }

  // the grid stays the source of truth, the canvas only repaints it from the real cell rects
  function draw() {
    if (emojiMode.checked || !board.clientWidth) return;
    if (skin !== swatchSkin) paintSwatches(skin);
    const dpr = window.devicePixelRatio || 1;
    const width = Math.round(board.clientWidth * dpr), height = Math.round(board.clientHeight * dpr);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, board.clientWidth, board.clientHeight);
    const frame = skin ? skinFrame(skin) : 0;
    const origin = board.getBoundingClientRect();
    // ghosts are not part of the board, they must not join a piece
    const edges = skin?.connected
      ? tetrominoEdges(cells.map(cell => cell.classList.contains("ghost") ? 0 : ids[cell.textContent!] ?? 0)) : undefined;
    cells.forEach((cell, index) => {
      const rect = cell.getBoundingClientRect();
      drawCell(ctx, ids[cell.textContent!], rect.left - origin.left, rect.top - origin.top, rect.width, skin, frame,
        cell.classList.contains("ghost"), edges ? connectionMask(edges[index]) : 0);
    });
    if (skin?.animation && !frameRequest) frameRequest = requestAnimationFrame(() => {
      frameRequest = 0;
      draw();
    });
  }

  // paints call this per cell, so batch them into one draw before the next frame
  function redraw() {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      draw();
    });
  }

  function brush(index: number, value: string) {
    if (play) play.paint(index, value);
    else paint(index, value);
  }

  function startStroke(index: number, source: StrokeSource, id: number) {
    const cell = cells[index];
    const value = cell.textContent === empty || cell.classList.contains("ghost") ? selected : empty;
    stroke = { source, id, value, lastCell: index };
    brush(index, value);
  }

  for (const [index, [emoji, name]] of blocks.entries()) {
    const button = makeButton(emoji, "emoji-color");
    swatches.push([button, ids[emoji]]);
    button.setAttribute("aria-label", name);
    button.setAttribute("aria-pressed", String(emoji === selected));
    function selectColor() {
      if (selected === emoji) return;
      selected = emoji;
      palette.querySelector('[aria-pressed="true"]')?.setAttribute("aria-pressed", "false");
      button.setAttribute("aria-pressed", "true");
    }
    button.addEventListener("click", selectColor);
    button.addEventListener("pointerup", event => {
      if (event.pointerType === "touch" && event.isPrimary &&
        document.elementFromPoint(event.clientX, event.clientY) === button) selectColor();
    });
    (index < blocks.length / 2 ? colorsLeft : colorsRight).append(button);
  }

  cells.forEach((cell, index) => {
    cell.tabIndex = index === 0 ? 0 : -1;
    paint(index, empty);
    cell.addEventListener("pointerdown", event => {
      if (event.button !== 0 || !event.isPrimary || stroke) return;
      if (event.pointerType === "touch") {
        startStroke(index, "touch-pointer", event.pointerId);
        return;
      }
      event.preventDefault();
      if (!play) cell.focus({ preventScroll: true });
      board.setPointerCapture(event.pointerId);
      startStroke(index, "pointer", event.pointerId);
    });
    cell.addEventListener("click", event => {
      if (event.detail === 0) brush(index, cell.textContent === empty ? selected : empty);
    });
  });
  board.append(canvas, ...cells);
  mountBoardFocus(board, () => ({ cells: play && !play.paused ? [] : cells, cols }));
  new ResizeObserver(redraw).observe(board);

  function cellAt(x: number, y: number) {
    const hit = document.elementFromPoint(x, y);
    return hit instanceof HTMLButtonElement ? cells.indexOf(hit) : -1;
  }

  function extendStroke(x: number, y: number) {
    if (!stroke) return;
    const index = cellAt(x, y);
    const previous = stroke.lastCell;
    stroke.lastCell = index;
    if (index < 0 || index === previous) return;
    if (previous < 0) {
      brush(index, stroke.value);
      return;
    }

    const fromRow = Math.floor(previous / cols);
    const fromCol = previous % cols;
    const rowDelta = Math.floor(index / cols) - fromRow;
    const colDelta = index % cols - fromCol;
    const steps = Math.max(Math.abs(rowDelta), Math.abs(colDelta));
    for (let step = 1; step <= steps; step++) {
      const row = Math.round(fromRow + rowDelta * step / steps);
      const col = Math.round(fromCol + colDelta * step / steps);
      brush(row * cols + col, stroke.value);
    }
  }

  function movePointer(event: PointerEvent) {
    if (stroke && stroke.source !== "touch" && stroke.id === event.pointerId) extendStroke(event.clientX, event.clientY);
  }

  function endPointer(event: PointerEvent) {
    if (stroke && stroke.source !== "touch" && stroke.id === event.pointerId) stroke = null;
  }
  board.addEventListener("pointermove", movePointer);
  board.addEventListener("pointerup", event => {
    movePointer(event);
    endPointer(event);
  });
  board.addEventListener("pointercancel", endPointer);
  board.addEventListener("lostpointercapture", endPointer);

  board.addEventListener("touchstart", event => {
    if (event.touches.length !== 1) return;
    const touch = event.changedTouches[0];
    if (stroke?.source === "touch-pointer") {
      stroke.source = "touch";
      stroke.id = touch.identifier;
      event.preventDefault();
      return;
    }
    if (stroke) return;
    const index = cellAt(touch.clientX, touch.clientY);
    if (index < 0) return;
    event.preventDefault();
    startStroke(index, "touch", touch.identifier);
  }, { passive: false });

  function movedTouch(event: TouchEvent) {
    if (stroke?.source !== "touch") return;
    const id = stroke.id;
    return Array.from(event.changedTouches).find(touch => touch.identifier === id);
  }

  board.addEventListener("touchmove", event => {
    const touch = movedTouch(event);
    if (!touch) return;
    event.preventDefault();
    extendStroke(touch.clientX, touch.clientY);
  }, { passive: false });

  board.addEventListener("touchend", event => {
    const touch = movedTouch(event);
    if (!touch) return;
    extendStroke(touch.clientX, touch.clientY);
    stroke = null;
  });
  board.addEventListener("touchcancel", event => {
    if (movedTouch(event)) stroke = null;
  });

  window.addEventListener("blur", () => {
    if (stroke?.source === "pointer" && board.hasPointerCapture(stroke.id)) board.releasePointerCapture(stroke.id);
    stroke = null;
  });

  function setBoard(layout: string[], flip = mirrored) {
    boardCells(flip ? mirrorRows(layout) : layout).forEach((value, index) => paint(index, value));
  }

  mirror.addEventListener("click", () => {
    mirrored = !mirrored;
    mirror.setAttribute("aria-pressed", String(mirrored));
    if (play) {
      drawn = mirrorRows(drawn);
      play.mirror(drawn);
    } else setBoard(boardLines(), true);
    status.textContent = mirrored ? "Mirror mode on." : "Mirror mode off.";
  });

  let sequence: string[][] = [];
  let step = 0;
  // a draft is the user's own sequence, it follows edits made to the board
  let draft = false;
  let draftName = "";
  let saved = readSaved();

  function boardLines() {
    return Array.from({ length: rows }, (_, row) =>
      cells.slice(row * cols, (row + 1) * cols).map(cell => cell.textContent).join(""));
  }

  // steps are stored unmirrored and without the empty rows on top
  function captureBoard(lines = boardLines()) {
    const first = lines.findIndex(line => line !== empty.repeat(cols));
    const board = first < 0 ? [] : lines.slice(first);
    return mirrored ? mirrorRows(board) : board;
  }

  function saveCurrent() {
    if (draft) sequence[step] = captureBoard();
  }

  function updateDraftButtons() {
    removeStep.disabled = !draft;
    deleteSaved.hidden = !(draft && saved.some(item => item.name === draftName));
  }

  function goTo(next: number) {
    step = next;
    setBoard(sequence[step]);
    stepBack.disabled = step === 0;
    stepNext.disabled = step === sequence.length - 1;
    stepLabel.textContent = sequence.length > 1 ? `${step + 1}/${sequence.length}` : "";
    updateDraftButtons();
  }

  function syncRange() {
    seqFrom.value = "1";
    seqTo.value = seqFrom.max = seqTo.max = String(sequence.length);
  }

  function openSequence(steps: string[][], isDraft: boolean, name: string) {
    sequence = steps;
    draft = isDraft;
    draftName = name;
    seqTools.hidden = sequence.length < (isDraft ? 1 : 2);
    syncRange();
    goTo(0);
    renderSplits();
  }

  stepBack.addEventListener("click", () => {
    saveCurrent();
    goTo(step - 1);
    status.textContent = `Step ${step + 1} of ${sequence.length}.`;
  });
  stepNext.addEventListener("click", () => {
    saveCurrent();
    goTo(step + 1);
    status.textContent = `Step ${step + 1} of ${sequence.length}.`;
  });

  document.addEventListener("keydown", event => {
    const target = event.target as HTMLElement;
    if (event.defaultPrevented || root.hidden || play || event.ctrlKey || event.altKey || event.metaKey || target.closest("input, select, textarea, [contenteditable]")) return;
    const button = { ArrowLeft: stepBack, h: stepBack, ArrowRight: stepNext, l: stepNext }[event.key];
    if (!button) return;
    event.preventDefault();
    button.click();
  });

  for (const [name, layouts] of Object.entries(openers)) {
    const button = makeButton(name);
    let variant = 0;
    button.addEventListener("click", () => {
      openSequence([layouts[variant], ...continuations[name] ?? []], false, "");
      status.textContent = layouts.length > 1 ? `${name} variant ${variant + 1} loaded.` : `${name} loaded.`;
      variant = (variant + 1) % layouts.length;
    });
    presets.append(button);
  }

  function renderSaved() {
    savedList.replaceChildren(...saved.map(item => {
      const button = makeButton(item.name);
      button.addEventListener("click", () => {
        openSequence(item.steps.map(board => [...board]), true, item.name);
        status.textContent = `${item.name} loaded.`;
      });
      return button;
    }));
  }
  renderSaved();

  function persist(done: string) {
    try {
      localStorage.setItem(storeKey, JSON.stringify(saved));
      status.textContent = done;
    } catch {
      status.textContent = "Could not save, browser storage is unavailable.";
    }
  }

  addStep.addEventListener("click", () => {
    saveCurrent();
    if (!draft) {
      sequence = [];
      draft = true;
      draftName = "";
    }
    if (sequence.length >= maxSteps) {
      status.textContent = `A sequence can have ${maxSteps} steps at most.`;
      return;
    }
    sequence.push(captureBoard());
    seqTools.hidden = false;
    syncRange();
    goTo(sequence.length - 1);
    renderSplits();
    status.textContent = `Step ${sequence.length} added.`;
  });

  removeStep.addEventListener("click", () => {
    sequence.splice(step, 1);
    if (!sequence.length) {
      draft = false;
      draftName = "";
      seqTools.hidden = stepBack.disabled = stepNext.disabled = true;
      stepLabel.textContent = "";
      updateDraftButtons();
    } else {
      syncRange();
      goTo(Math.min(step, sequence.length - 1));
      renderSplits();
    }
    status.textContent = "Step removed.";
  });

  saveSequence.addEventListener("click", () => {
    saveCurrent();
    if (!draft) {
      status.textContent = "Add a step first.";
      return;
    }
    const name = window.prompt("Name this sequence", draftName)?.trim().slice(0, maxName);
    if (!name) return;
    if (name in openers) {
      status.textContent = `${name} is a built-in opener.`;
      return;
    }
    const index = saved.findIndex(item => item.name === name);
    if (index >= 0 && name !== draftName && !window.confirm(`Replace ${name}?`)) return;
    if (index < 0 && saved.length >= maxSaved) {
      status.textContent = `You can save ${maxSaved} sequences at most.`;
      return;
    }
    const item = { name, steps: sequence.map(board => [...board]) };
    if (index >= 0) saved[index] = item;
    else saved.push(item);
    draftName = name;
    renderSaved();
    updateDraftButtons();
    persist(`Saved ${name}.`);
  });

  deleteSaved.addEventListener("click", () => {
    if (!window.confirm(`Delete ${draftName}?`)) return;
    saved = saved.filter(item => item.name !== draftName);
    draftName = "";
    renderSaved();
    updateDraftButtons();
    persist("Deleted.");
  });

  root.querySelector("#emoji-clear")!.addEventListener("click", () => {
    if (play) play.clear();
    else setBoard([]);
    if (!draft && !play) {
      seqTools.hidden = stepBack.disabled = stepNext.disabled = true;
      stepLabel.textContent = "";
    }
    status.textContent = "Board cleared.";
  });
  async function copyText(text: string, button: HTMLButtonElement) {
    let copied = true;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const field = document.createElement("textarea");
      field.value = text;
      field.style.position = "fixed";
      field.style.opacity = "0";
      document.body.append(field);
      field.select();
      try { copied = document.execCommand("copy"); }
      catch { copied = false; }
      finally {
        const selectedField = document.activeElement === field;
        field.remove();
        if (selectedField && !root.hidden) button.focus({ preventScroll: true });
      }
    }
    return copied;
  }

  const fence = (text: string) => codeBlock.checked ? "```\n" + text + "\n```" : text;

  async function copyRows(startRow: number, button: HTMLButtonElement) {
    const text = fence(boardLines().slice(startRow).join("\n"));
    status.textContent = await copyText(text, button) ? "Copied to clipboard!" : "Could not copy the board.";
  }

  const messageLimit = 2000;
  const maxGifFrames = 400;

  function selectedBoards() {
    saveCurrent();
    const from = Math.max(1, Math.min(Number(seqFrom.value) || 1, sequence.length));
    const to = Math.max(1, Math.min(Number(seqTo.value) || 1, sequence.length));
    return sequence.slice(from - 1, to).map(board => mirrored ? mirrorRows(board) : board);
  }

  function sequenceGroups() {
    const boards = selectedBoards();
    return { groups: arrangeBoards(boards, Number(perRow.value)), count: boards.length };
  }

  function sequenceMessages() {
    const { groups, count } = sequenceGroups();
    return { messages: autoSplit.checked || !groups.length ? groups : [groups.join("\n\n")], count };
  }

  async function copyMessage(index: number, button: HTMLButtonElement) {
    const { messages, count } = sequenceMessages();
    if (!messages[index]) {
      status.textContent = "Pick a valid step range.";
      return;
    }
    const text = fence(messages[index]);
    const done = autoSplit.checked ? `Copied message ${index + 1} of ${messages.length}.` : `Copied ${count} boards.`;
    if (!await copyText(text, button)) status.textContent = "Could not copy the sequence.";
    else status.textContent = text.length > messageLimit ?
      `${done} It has ${text.length} characters, over Discord's ${messageLimit} limit.` : done;
  }

  function renderSplits() {
    copySeq.hidden = autoSplit.checked;
    splits.replaceChildren(...(autoSplit.checked ? sequenceMessages().messages.map((_, index, all) => {
      const button = makeButton(`Copy ${index + 1}/${all.length}`);
      button.addEventListener("click", () => copyMessage(index, button));
      return button;
    }) : []));
  }

  copy.addEventListener("click", () => copyRows(0, copy));
  copyHalf.addEventListener("click", () => copyRows(rows / 2, copyHalf));
  function pasteBoard(text: string) {
    const parsed = parseBoardText(text);
    if (typeof parsed === "string") {
      status.textContent = parsed;
      return false;
    }
    stopPlay();
    if (sequence.length) {
      sequence[step] = captureBoard(parsed);
      draft = true;
      seqTools.hidden = false;
      goTo(step);
      renderSplits();
    } else setBoard(parsed, false);
    status.textContent = "Board pasted.";
    return true;
  }
  root.addEventListener("paste", event => {
    if (root.hidden || play || !(event.target instanceof HTMLElement) ||
      event.target.closest("input, select, textarea, [contenteditable]")) return;
    if (pasteBoard(event.clipboardData?.getData("text") ?? "")) event.preventDefault();
  });
  root.querySelector("#emoji-paste")!.addEventListener("click", async () => {
    const original = sequence, originalStep = step;
    let text: string;
    try { text = await navigator.clipboard.readText(); }
    catch {
      status.textContent = "Could not read the clipboard. Use the paste shortcut in the editor.";
      return;
    }
    if (!root.hidden && !play && sequence === original && step === originalStep) pasteBoard(text);
  });
  copySeq.addEventListener("click", () => copyMessage(0, copySeq));
  // names repeat across categories, so a repeat gets its category (or id) added to stay unique
  const skinKeys = new Map<string, string>();
  function fillSkins() {
    const keys = new Map<string, string>();
    skinKeys.clear();
    const add = (id: string, label: string, group = id) => {
      let key = label;
      if (skinKeys.has(key)) key = `${label} (${group})`;
      if (skinKeys.has(key)) key = `${label} (${id})`;
      skinKeys.set(key, id); keys.set(id, key);
    };
    BUILTIN_SKINS.forEach(def => add(def.id, def.label, def.category));
    skins.preferences.customs.forEach((url, index) => { const def = customSkin(url, index); add(def.id, def.label); });
    skinList.replaceChildren(...[...skinKeys.keys()].map(key => {
      const option = document.createElement("option");
      option.value = key;
      return option;
    }));
    return keys;
  }
  let skinId = "";
  let skinRequest = 0;
  async function loadSkin(id: string | null) {
    const def = editorSkin(id, skins.preferences);
    skinId = def.id;
    const request = ++skinRequest;
    let loaded: LoadedSkin | undefined;
    try { loaded = await skins.load(def); } catch { /* flat colors until another pick */ }
    if (request !== skinRequest) return;
    skin = loaded;
    redraw();
  }
  const activeSkinKey = () => fillSkins().get(skinId) ?? "";
  try { void loadSkin(localStorage.getItem(skinKey)); } catch { void loadSkin(null); }
  skinInput.value = activeSkinKey();
  // the list filters by what is typed, so focus empties the box (the current name moves to the placeholder) to show every skin
  skinInput.addEventListener("focus", () => { skinInput.placeholder = activeSkinKey(); skinInput.value = ""; });
  skinInput.addEventListener("input", () => {
    const id = skinKeys.get(skinInput.value.trim());
    if (!id) return;
    void loadSkin(id);
    try { localStorage.setItem(skinKey, id); } catch { /* the pick lasts for the session */ }
    skinInput.blur();
  });
  skinInput.addEventListener("blur", () => { skinInput.value = activeSkinKey(); skinInput.placeholder = "Search skins"; });

  try { emojiMode.checked = parseEmojiMode(localStorage.getItem(modeKey)); } catch { /* keep the default */ }
  function applyMode() {
    root.classList.toggle("skin-look", !emojiMode.checked);
    skinInput.disabled = emojiMode.checked;
    redraw();
  }
  emojiMode.addEventListener("change", () => {
    applyMode();
    // space would toggle it again instead of hard dropping
    if (play) emojiMode.blur();
    try { localStorage.setItem(modeKey, String(emojiMode.checked)); } catch { /* the choice lasts for the session */ }
  });
  applyMode();

  let gifBlob: Blob | undefined;
  exportGif.addEventListener("click", async () => {
    exportGif.disabled = true;
    status.textContent = "Making the GIF...";
    try {
      const cell = Math.max(4, Math.min(Math.round(Number(gifBlock.value)) || 16, 64));
      const hold = Math.max(20, Math.min(Math.round((Number(gifSeconds.value) || 1) * 1000), 10000));
      const look = emojiMode.checked ? "emoji" : skin;
      const build = gifBuild.checked;
      let boards = selectedBoards(), holds = boards.map(() => hold), frames = "", note = "";
      if (gifAnimate.checked && (boards.length > 1 || build)) {
        const animated = await planGif({ boards, hold, build }, (step, total) => {
          status.textContent = `Animating step ${step} of ${total}...`;
        });
        ({ boards, holds } = animated);
        const stepList = (steps: number[]) => `GIF step${steps.length === 1 ? "" : "s"} ${steps.join(", ")}`;
        if (animated.skipped.length) note += ` Could not animate ${stepList(animated.skipped)} in time.`;
        else if (build && !animated.built) note += " The first board shows as drawn.";
        if (animated.limited.length) note += ` Search limit reached for ${stepList(animated.limited)}.`;
        const count = timeline(holds, animatedLook(look)).length;
        if (count > maxGifFrames) throw new Error(`Animating needs ${count} frames, ${maxGifFrames} at most. Pick fewer steps or a non animated skin.`);
        if (count < 2) throw new Error(animated.skipped.length ? note.trim() : "The first board cannot be built piece by piece.");
        status.textContent = `Encoding ${count} frames...`;
        frames = `${count} frames, `;
      }
      const gif = await makeGif(document.createElement("canvas"), boards, cell, look, holds);
      gifBlob = new Blob([gif as Uint8Array<ArrayBuffer>], { type: "image/gif" });
      URL.revokeObjectURL(gifPreview.src);
      gifPreview.src = URL.createObjectURL(gifBlob);
      gifResult.hidden = false;
      status.textContent = `GIF ready (${frames}${Math.round(gif.length / 1024)} KB).${note}`;
    } catch (error) {
      status.textContent = (error as Error).message;
    } finally { exportGif.disabled = false; }
  });

  gifAnimate.addEventListener("change", () => {
    gifHint.hidden = gifBuildLabel.hidden = !gifAnimate.checked;
    // leave a value the user typed alone
    if (gifAnimate.checked && gifSeconds.value === "1") gifSeconds.value = "0.1";
    else if (!gifAnimate.checked && gifSeconds.value === "0.1") gifSeconds.value = "1";
  });

  gifDownload.addEventListener("click", () => {
    const link = document.createElement("a");
    link.href = gifPreview.src;
    link.download = "tetorisu-editor.gif";
    link.click();
  });
  for (const input of [seqFrom, seqTo]) input.addEventListener("input", renderSplits);
  for (const input of [perRow, autoSplit]) input.addEventListener("change", renderSplits);

  function showRun(run: Singleplayer) {
    if (root.hidden) {
      stopPlay();
      return;
    }
    const { cells: values, ghosts } = playCells(run.game, gameplay.ghost());
    values.forEach((value, index) => {
      if (cells[index].textContent !== value) cells[index].textContent = value;
      cells[index].classList.toggle("ghost", ghosts.has(index));
    });
    const look = emojiMode.checked ? "emoji" : skin;
    drawQueue(holdCtx, run.game.held === null ? [] : [run.game.held], look);
    drawQueue(nextCtx, run.game.previews, look);
    draw();
  }

  function syncPlay() {
    root.classList.toggle("playing", !!play);
    playButton.textContent = !play ? "Play" : play.paused ? "Resume" : "Pause";
    stopButton.hidden = keep.hidden = !play;
    matchBag.parentElement!.hidden = !!play;
  }

  function togglePause() {
    if (!play) return;
    play.setPaused(!play.paused);
    status.textContent = play.paused ? "Paused. You can still paint the board." : "Playing.";
    syncPlay();
  }

  function startPlay() {
    drawn = boardLines();
    // the board as shown, mirrored colours included, is what gets played
    const board = new Uint8Array(cols * 40);
    boardToGame(drawn, board);
    const bag = matchBag.checked ? boardQueue(board) : null;
    // space must hard drop, not press whatever was clicked
    (document.activeElement as HTMLElement | null)?.blur();
    play = playBoard(drawn, {
      bindings: gameplay.bindings, handling: gameplay.handling(), sounds: gameplay.sounds, queue: bag?.queue ?? [], render: showRun,
      stuck: () => stopPlay("No room to spawn a piece on this board."),
      pause: togglePause,
      restart() {
        stopPlay();
        startPlay();
      },
    });
    syncPlay();
    status.textContent = !bag ? "Zen on this board. Ctrl+Z undoes a piece, Escape pauses."
      : bag.left.length === 7 ? "Fresh bag."
      : `Bag continues from the board: ${bag.left.length} left (${bag.left.map(id => "_ZLOSIJT"[id]).join(" ")}).`;
  }

  function stopPlay(message?: string) {
    const run = play?.run;
    if (!play) return run;
    play.stop();
    play = null;
    syncPlay();
    drawn.flatMap(line => Array.from(line)).forEach((value, index) => {
      cells[index].classList.remove("ghost");
      paint(index, value);
    });
    if (message) status.textContent = message;
    return run;
  }

  playButton.addEventListener("click", () => {
    if (play) togglePause();
    else startPlay();
    playButton.blur();
  });
  stopButton.addEventListener("click", () => stopPlay("Stopped."));

  keep.addEventListener("click", () => {
    const run = stopPlay();
    if (!run) return;
    saveCurrent();
    if (!draft) {
      sequence = [captureBoard()];
      step = 0;
      draft = true;
      draftName = "";
    }
    if (sequence.length >= maxSteps) {
      status.textContent = `A sequence can have ${maxSteps} steps at most.`;
      return;
    }
    sequence.splice(step + 1, 0, captureBoard(gameToLines(run.game.board)));
    seqTools.hidden = false;
    syncRange();
    goTo(step + 1);
    renderSplits();
    status.textContent = `Position kept as step ${step + 1}.`;
  });

  return pasteBoard;
}
