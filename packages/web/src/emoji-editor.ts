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

const empty = "⬛";
const cols = 10;
const rows = 20;
const mirrorPair: Record<string, string> = { "🟥": "🟩", "🟩": "🟥", "🟦": "🟧", "🟧": "🟦" };
const blocks = [
  ["⬜", "I piece"], ["🟪", "T piece"], ["🟥", "Z piece"], ["🟨", "O piece"],
  ["🟩", "S piece"], ["🟦", "J piece"], ["🟧", "L piece"], [empty, "Erase"],
] as const;

export function mountEmojiEditor(root: HTMLElement) {
  const { ownerDocument: document } = root;
  const board = root.querySelector<HTMLElement>("#emoji-board")!;
  const palette = root.querySelector<HTMLElement>("#emoji-palette")!;
  const colorsLeft = palette.querySelector<HTMLElement>("#emoji-colors-left")!;
  const colorsRight = palette.querySelector<HTMLElement>("#emoji-colors-right")!;
  const presets = root.querySelector<HTMLElement>("#emoji-openers")!;
  const status = root.querySelector<HTMLElement>("#emoji-status")!;
  const copy = root.querySelector<HTMLButtonElement>("#emoji-copy")!;
  const mirror = root.querySelector<HTMLButtonElement>("#emoji-mirror")!;
  const copyHalf = root.querySelector<HTMLButtonElement>("#emoji-copy-half")!;
  const cells = Array.from({ length: cols * rows }, () => makeButton(empty, "emoji-cell"));
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
  }

  function startStroke(index: number, source: StrokeSource, id: number) {
    const value = cells[index].textContent === empty ? selected : empty;
    stroke = { source, id, value, lastCell: index };
    paint(index, value);
  }

  for (const [index, [emoji, name]] of blocks.entries()) {
    const button = makeButton(emoji, "emoji-color");
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
  board.append(...cells);

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

  for (const [name, layouts] of Object.entries(openers)) {
    const button = makeButton(name);
    let variant = 0;
    button.addEventListener("click", () => {
      setBoard(layouts[variant]);
      status.textContent = layouts.length > 1 ? `${name} variant ${variant + 1} loaded.` : `${name} loaded.`;
      variant = (variant + 1) % layouts.length;
    });
    presets.append(button);
  }
  root.querySelector("#emoji-clear")!.addEventListener("click", () => {
    setBoard([]);
    status.textContent = "Board cleared.";
  });
  async function copyRows(startRow: number, button: HTMLButtonElement) {
    const text = Array.from({ length: rows - startRow }, (_, index) => {
      const row = startRow + index;
      return cells.slice(row * cols, (row + 1) * cols).map(cell => cell.textContent).join("");
    }).join("\n");
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
    status.textContent = copied ? "Copied to clipboard!" : "Could not copy the board.";
  }

  copy.addEventListener("click", () => copyRows(0, copy));
  copyHalf.addEventListener("click", () => copyRows(rows / 2, copyHalf));
}
