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
  const copyHalf = root.querySelector<HTMLButtonElement>("#emoji-copy-half")!;
  const cells = Array.from({ length: cols * rows }, () => makeButton(empty, "emoji-cell"));
  let selected: string = blocks[0][0];
  let stroke: { pointerId: number; value: string; lastCell: number } | null = null;

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
      event.preventDefault();
      board.setPointerCapture(event.pointerId);
      const value = cell.textContent === empty ? selected : empty;
      stroke = { pointerId: event.pointerId, value, lastCell: index };
      paint(index, value);
    });
    cell.addEventListener("click", event => {
      if (event.detail === 0) paint(index, cell.textContent === empty ? selected : empty);
    });
  });
  board.append(...cells);

  function extendStroke(event: PointerEvent) {
    if (!stroke || event.pointerId !== stroke.pointerId) return;
    const hit = document.elementFromPoint(event.clientX, event.clientY);
    const index = hit instanceof HTMLButtonElement ? cells.indexOf(hit) : -1;
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

  function endStroke(event: PointerEvent) {
    if (stroke?.pointerId === event.pointerId) stroke = null;
  }
  board.addEventListener("pointermove", extendStroke);
  board.addEventListener("pointerup", event => {
    extendStroke(event);
    endStroke(event);
  });
  board.addEventListener("pointercancel", endStroke);
  board.addEventListener("lostpointercapture", endStroke);
  window.addEventListener("blur", () => {
    if (!stroke) return;
    const { pointerId } = stroke;
    stroke = null;
    if (board.hasPointerCapture(pointerId)) board.releasePointerCapture(pointerId);
  });

  function setBoard(layout: string[]) {
    const painted = layout.flatMap(row => Array.from(row));
    const offset = cells.length - painted.length;
    cells.forEach((_, index) => paint(index, painted[index - offset] ?? empty));
  }

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
