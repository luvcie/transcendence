import type { SkinState } from "./skin-state";
import { ids, makeGif } from "./emoji-gif";
import { BUILTIN_SKINS, customSkin } from "./skin-catalog";
import { resolveSkin } from "./skin-preferences";
import type { LoadedSkin } from "./skin-loader";
import { drawTile, skinFrame } from "./tile-renderer";

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

const empty = "⬛";
const cols = 10;
const rows = 20;

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
const blocks = [
  ["⬜", "I piece"], ["🟪", "T piece"], ["🟥", "Z piece"], ["🟨", "O piece"],
  ["🟩", "S piece"], ["🟦", "J piece"], ["🟧", "L piece"], [empty, "Erase"],
] as const;

export function mirrorRows(board: string[]) {
  return board.map(row => Array.from(row).reverse().map(value => mirrorPair[value] ?? value).join(""));
}

const modeKey = "tetorisueditor.emojiMode";
// anything but an explicit "false" keeps the default, emoji mode
export const parseEmojiMode = (raw: string | null) => raw !== "false";

export type SavedOpener = { name: string; steps: string[][] };
const storeKey = "tetorisueditor.openers";
const maxSaved = 12;
const maxName = 20;
const maxSteps = 20;
const known = new Set<string>(blocks.map(([emoji]) => emoji));
const validBoard = (board: unknown) => Array.isArray(board) && board.length <= rows && board.every(row =>
  typeof row === "string" && Array.from(row).length === cols && Array.from(row).every(value => known.has(value)));

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

export function mountEmojiEditor(root: HTMLElement, skins: SkinState) {
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
  const cells = Array.from({ length: cols * rows }, () => makeButton(empty, "emoji-cell"));
  const canvas = document.createElement("canvas");
  const swatches: [HTMLButtonElement, number][] = [];
  let swatchSkin: LoadedSkin | undefined | null = null;
  let frameRequest = 0;
  let queued = false;
  let selected: string = blocks[0][0];
  let mirrored = false;
  type StrokeSource = "pointer" | "touch-pointer" | "touch";
  let stroke: { source: StrokeSource; id: number; value: string; lastCell: number } | null = null;

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
    cell.setAttribute("aria-label", `Row ${Math.floor(index / cols) + 1}, column ${index % cols + 1}: ${value}`);
    redraw();
  }

  function drawCell(ctx: CanvasRenderingContext2D, id: number | undefined, x: number, y: number, size: number,
    skin: LoadedSkin | undefined, frame: number) {
    ctx.fillStyle = "#111";
    ctx.fillRect(x, y, size, size);
    if (id) drawTile(ctx, id, x, y, size, skin, 0, false, frame);
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
    const skin = skins.loaded;
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
    for (const cell of cells) {
      const rect = cell.getBoundingClientRect();
      drawCell(ctx, ids[cell.textContent!], rect.left - origin.left, rect.top - origin.top, rect.width, skin, frame);
    }
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

  function startStroke(index: number, source: StrokeSource, id: number) {
    const value = cells[index].textContent === empty ? selected : empty;
    stroke = { source, id, value, lastCell: index };
    paint(index, value);
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
    paint(index, empty);
    cell.addEventListener("pointerdown", event => {
      if (event.button !== 0 || !event.isPrimary || stroke) return;
      if (event.pointerType === "touch") {
        startStroke(index, "touch-pointer", event.pointerId);
        return;
      }
      event.preventDefault();
      board.setPointerCapture(event.pointerId);
      startStroke(index, "pointer", event.pointerId);
    });
    cell.addEventListener("click", event => {
      if (event.detail === 0) paint(index, cell.textContent === empty ? selected : empty);
    });
  });
  board.append(canvas, ...cells);
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
      paint(index, stroke.value);
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
      paint(row * cols + col, stroke.value);
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

  function mirrorBoard() {
    const flipped = cells.map((_, index) => {
      const value = cells[Math.floor(index / cols) * cols + cols - 1 - index % cols].textContent!;
      return mirrorPair[value] ?? value;
    });
    flipped.forEach((value, index) => paint(index, value));
  }

  function setBoard(layout: string[]) {
    const painted = layout.flatMap(row => Array.from(row));
    const offset = cells.length - painted.length;
    cells.forEach((_, index) => paint(index, painted[index - offset] ?? empty));
    if (mirrored) mirrorBoard();
  }

  mirror.addEventListener("click", () => {
    mirrored = !mirrored;
    mirror.setAttribute("aria-pressed", String(mirrored));
    mirrorBoard();
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
  function captureBoard() {
    const lines = boardLines();
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
    if (root.hidden || event.ctrlKey || event.altKey || event.metaKey || target.closest("input, select, textarea, [contenteditable]")) return;
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
    setBoard([]);
    if (!draft) {
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
  const activeSkinKey = () => fillSkins().get(skins.preferences.active) ?? "";
  skinInput.value = activeSkinKey();
  skinInput.addEventListener("focus", () => { skinInput.value = activeSkinKey(); skinInput.select(); });
  skinInput.addEventListener("change", async () => {
    const id = skinKeys.get(skinInput.value.trim());
    if (id) await skins.select(id);
    skinInput.value = activeSkinKey();
    redraw();
  });

  try { emojiMode.checked = parseEmojiMode(localStorage.getItem(modeKey)); } catch { /* keep the default */ }
  function applyMode() {
    root.classList.toggle("skin-look", !emojiMode.checked);
    skinInput.disabled = emojiMode.checked;
    redraw();
  }
  emojiMode.addEventListener("change", () => {
    applyMode();
    try { localStorage.setItem(modeKey, String(emojiMode.checked)); } catch { /* the choice lasts for the session */ }
  });
  applyMode();
  // the first skin may still be loading, draw again once it has settled
  if (!skins.loaded) skins.load(resolveSkin(skins.preferences)).catch(() => {}).then(() => setTimeout(redraw));

  let gifBlob: Blob | undefined;
  exportGif.addEventListener("click", async () => {
    exportGif.disabled = true;
    status.textContent = "Making the GIF...";
    try {
      const cell = Math.max(4, Math.min(Math.round(Number(gifBlock.value)) || 16, 64));
      const hold = Math.max(20, Math.min(Math.round((Number(gifSeconds.value) || 1) * 1000), 10000));
      const gif = await makeGif(document.createElement("canvas"), selectedBoards(), cell,
        emojiMode.checked ? "emoji" : skins.loaded, hold);
      gifBlob = new Blob([gif as Uint8Array<ArrayBuffer>], { type: "image/gif" });
      URL.revokeObjectURL(gifPreview.src);
      gifPreview.src = URL.createObjectURL(gifBlob);
      gifResult.hidden = false;
      status.textContent = `GIF ready (${Math.round(gif.length / 1024)} KB).`;
    } catch (error) {
      status.textContent = (error as Error).message;
    } finally { exportGif.disabled = false; }
  });

  gifDownload.addEventListener("click", () => {
    const link = document.createElement("a");
    link.href = gifPreview.src;
    link.download = "tetorisu-editor.gif";
    link.click();
  });
  for (const input of [seqFrom, seqTo]) input.addEventListener("input", renderSplits);
  for (const input of [perRow, autoSplit]) input.addEventListener("change", renderSplits);
}
