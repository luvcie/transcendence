import { blockNames, emojis } from "../board-emoji";
import { mountBoardFocus } from "../board-focus";
import { parseBoardText } from "../emoji-editor";
import { toEmoji } from "./emoji";
import { recognizeBoard, type Recognition, type Rect } from "./recognize";

export function mountMinolens(root: HTMLElement, openEditor: (text: string) => boolean) {
  const { ownerDocument: document } = root;
  const upload = root.querySelector<HTMLElement>("#minolens-upload")!;
  const uploadHint = root.querySelector<HTMLElement>("#minolens-upload-hint")!;
  const pick = root.querySelector<HTMLButtonElement>("#minolens-pick")!;
  const file = root.querySelector<HTMLInputElement>("#minolens-file")!;
  const work = root.querySelector<HTMLElement>("#minolens-work")!;
  const toolbar = root.querySelector<HTMLElement>(".minolens-toolbar")!;
  const actions = root.querySelector<HTMLElement>(".minolens-actions")!;
  const cropButton = root.querySelector<HTMLButtonElement>("#minolens-crop")!;
  const screenshot = root.querySelector<HTMLElement>("#minolens-screenshot-panel")!;
  const source = root.querySelector<HTMLCanvasElement>("#minolens-source")!;
  const ctx = source.getContext("2d");
  const board = root.querySelector<HTMLElement>("#minolens-board")!;
  const palette = root.querySelector<HTMLElement>("#minolens-palette")!;
  const paintHelp = root.querySelector<HTMLElement>("#minolens-paint-help")!;
  const output = root.querySelector<HTMLTextAreaElement>("#minolens-output")!;
  const text = root.querySelector<HTMLDetailsElement>("#minolens-text")!;
  const message = root.querySelector<HTMLElement>("#minolens-status")!;
  const review = root.querySelector<HTMLElement>("#minolens-review")!;
  const exportStatus = root.querySelector<HTMLElement>("#minolens-export-status")!;
  const reset = root.querySelector<HTMLButtonElement>("#minolens-reset")!;
  const trim = root.querySelector<HTMLInputElement>("#minolens-trim")!;
  const copy = root.querySelector<HTMLButtonElement>("#minolens-copy")!;
  const open = root.querySelector<HTMLButtonElement>("#minolens-open")!;
  let image: ImageData | undefined;
  let recognition: Recognition | undefined;
  let cells: Uint8Array = new Uint8Array(0);
  let buttons: HTMLButtonElement[] = [];
  const edited = new Set<number>();
  let keyboardCrop: Rect | undefined;
  let paint: number | null = null;
  let loadVersion = 0;

  function update() {
    if (!recognition) return;
    const { cols, confidence } = recognition;
    const hasBlocks = cells.some(id => id !== 0);
    let marked = 0;
    buttons.forEach((button, index) => {
      const id = cells[index];
      const emoji = emojis[id];
      const uncertain = hasBlocks && confidence[index] <= 0.5 && !edited.has(index);
      if (uncertain) marked++;
      if (button.textContent !== emoji) {
        button.textContent = emoji;
        button.dataset.piece = String(id);
      }
      button.toggleAttribute("data-review", uncertain);
      const label = `Row ${Math.floor(index / cols) + 1}, column ${index % cols + 1}: ${id === 0 ? "Empty" : blockNames[emoji]}${uncertain ? ", check this cell" : ""}`;
      if (button.getAttribute("aria-label") !== label) button.setAttribute("aria-label", label);
    });
    output.value = toEmoji(cells, cols, trim.checked).join("\n");
    copy.disabled = open.disabled = !output.value;
    reset.disabled = edited.size === 0;
    const guidance = !hasBlocks
      ? "No blocks detected. Try cropping around the board in the screenshot."
      : marked === 1 ? "1 cell to check" : marked > 1 ? `${marked} cells to check` : "";
    review.toggleAttribute("data-marked", hasBlocks && marked > 0);
    if (review.textContent !== guidance) review.textContent = guidance;
    exportStatus.textContent = "";
  }

  function paintCell(index: number, id: number) {
    if (cells[index] === id && edited.has(index)) return;
    cells[index] = id;
    edited.add(index);
    update();
  }

  function nextValue(index: number) {
    return paint === null ? (cells[index] + 1) % emojis.length : cells[index] === 0 ? paint : 0;
  }

  function drawSource(drag?: Rect) {
    if (!ctx || !image || !recognition) return;
    ctx.putImageData(image, 0, 0);
    const { bounds: { x, y, width, height }, cell, rows, cols } = recognition;
    const pixel = source.width / (source.clientWidth || source.width);
    if (width && height) {
      ctx.beginPath();
      ctx.rect(0, 0, source.width, source.height);
      ctx.rect(x, y, width, height);
      ctx.fillStyle = "#0007";
      ctx.fill("evenodd");
    }
    ctx.lineWidth = pixel;
    ctx.strokeStyle = "#ffffff47";
    ctx.beginPath();
    for (let i = 1; i < cols && width; i++) {
      ctx.moveTo(x + i * cell, y);
      ctx.lineTo(x + i * cell, y + height);
    }
    for (let j = 1; j < rows; j++) {
      ctx.moveTo(x, y + j * cell);
      ctx.lineTo(x + width, y + j * cell);
    }
    ctx.stroke();
    ctx.lineWidth = 2 * pixel;
    ctx.strokeStyle = "#22d3ee";
    if (width && height) ctx.strokeRect(x, y, width, height);
    if (drag) {
      ctx.strokeStyle = "#fff";
      ctx.setLineDash([4 * pixel, 3 * pixel]);
      ctx.strokeRect(drag.x, drag.y, drag.width, drag.height);
      ctx.setLineDash([]);
    }
  }

  function showRecognition(next: Recognition) {
    recognition = next;
    cells = recognition.cells.slice();
    edited.clear();
    keyboardCrop = undefined;
    buttons = Array.from(cells, (_, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "emoji-cell";
      button.tabIndex = index === 0 ? 0 : -1;
      button.dataset.cell = String(index);
      button.addEventListener("click", event => {
        // a mouse stroke already handled this press
        if (event instanceof PointerEvent && event.pointerType === "mouse") return;
        paintCell(index, nextValue(index));
      });
      return button;
    });
    board.style.setProperty("--rows", String(Math.max(1, recognition.rows)));
    board.replaceChildren(...buttons);
    board.hidden = cells.length === 0;
    palette.hidden = paintHelp.hidden = reset.hidden = text.hidden = board.hidden;
    drawSource();
    update();
  }

  function revealScreenshot() {
    const viewport = document.defaultView;
    if (!viewport) return;
    const panel = screenshot.getBoundingClientRect();
    const bar = toolbar.getBoundingClientRect();
    const gap = 8;
    const topOffset = panel.top - bar.bottom - gap;
    const bottomOffset = panel.bottom - viewport.innerHeight + gap;
    if (topOffset < 0) viewport.scrollBy(0, topOffset);
    else if (bottomOffset > 0) viewport.scrollBy(0, Math.min(bottomOffset, panel.top - bar.height - gap));
  }

  function recognize(bounds: Rect, touch = false) {
    if (!image) return;
    keyboardCrop = undefined;
    const next = recognizeBoard(image, { bounds });
    if (!next.cells.some(id => id !== 0)) {
      message.setAttribute("data-error", "");
      message.textContent = touch
        ? "Could not read a board in that crop. Tap Crop, then drag around the full board."
        : "Could not read a board in that crop. Drag around the full board and try again.";
      if (touch) revealScreenshot();
      drawSource();
      return;
    }
    message.removeAttribute("data-error");
    message.textContent = "";
    showRecognition(next);
  }

  async function load(blob: Blob) {
    const version = ++loadVersion;
    if (!ctx) {
      message.setAttribute("data-error", "");
      message.textContent = "Could not read image pixels in this browser.";
      return;
    }
    message.removeAttribute("data-error");
    message.textContent = "Reading screenshot…";
    exportStatus.textContent = "";
    try {
      const bitmap = await createImageBitmap(blob);
      let nextImage: ImageData;
      try {
        await new Promise<void>(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
        if (version !== loadVersion || root.hidden) return;
        source.width = bitmap.width;
        source.height = bitmap.height;
        ctx.drawImage(bitmap, 0, 0);
        nextImage = ctx.getImageData(0, 0, source.width, source.height);
      } finally {
        bitmap.close();
      }
      const next = recognizeBoard(nextImage);
      image = nextImage;
      source.style.setProperty("--source-ratio", String(image.width / image.height));
      actions.hidden = false;
      work.hidden = false;
      cropButton.setAttribute("aria-pressed", "false");
      showRecognition(next);
      pick.classList.remove("primary");
      pick.textContent = "Replace image";
      uploadHint.textContent = "Paste or drop another";
      message.removeAttribute("data-error");
      message.textContent = "";
    } catch {
      if (version !== loadVersion || root.hidden) return;
      if (image) {
        source.width = image.width;
        source.height = image.height;
        drawSource();
      }
      message.setAttribute("data-error", "");
      message.textContent = "Could not read that image. Try another screenshot.";
    }
  }

  const swatches = emojis.map((emoji, id) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "emoji-color";
    button.dataset.piece = String(id);
    button.textContent = emoji;
    button.setAttribute("aria-label", blockNames[emoji]);
    button.title = blockNames[emoji];
    button.setAttribute("aria-pressed", "false");
    button.addEventListener("click", () => {
      paint = paint === id ? null : id;
      swatches.forEach((swatch, color) => swatch.setAttribute("aria-pressed", String(paint === color)));
    });
    return button;
  });
  palette.replaceChildren(...swatches);
  mountBoardFocus(board, () => ({ cells: buttons, cols: recognition?.cols ?? 10 }));
  work.addEventListener("focusin", event => {
    const target = event.target;
    if (!(target instanceof HTMLElement) || !target.matches(":focus-visible")) return;
    const offset = target.getBoundingClientRect().top - toolbar.getBoundingClientRect().bottom;
    if (offset < 0) document.defaultView?.scrollBy(0, offset - 8);
  });

  // like the editor: with a colour, a stroke on an empty cell paints and on a filled one erases
  let stroke: { value: number; last: number } | undefined;
  function cellAt(event: PointerEvent) {
    const target = document.elementFromPoint(event.clientX, event.clientY);
    return target instanceof HTMLButtonElement && target.parentElement === board ? Number(target.dataset.cell) : -1;
  }
  function extend(event: PointerEvent) {
    if (!stroke) return;
    const index = cellAt(event), previous = stroke.last;
    if (index < 0 || index === previous) return;
    stroke.last = index;
    const cols = recognition?.cols ?? 10;
    const fromRow = Math.floor(previous / cols), fromCol = previous % cols;
    const rows = Math.floor(index / cols) - fromRow, columns = index % cols - fromCol;
    const steps = Math.max(Math.abs(rows), Math.abs(columns));
    // fast drags skip cells, fill the line between
    for (let step = 1; step <= steps; step++) {
      paintCell(Math.round(fromRow + rows * step / steps) * cols + Math.round(fromCol + columns * step / steps), stroke.value);
    }
  }
  board.addEventListener("pointerdown", event => {
    if (event.pointerType !== "mouse" || !event.isPrimary || event.button !== 0) return;
    const index = cellAt(event);
    if (index < 0) return;
    board.setPointerCapture(event.pointerId);
    // cycling mode: the first cell steps to the next colour and the drag keeps painting it
    stroke = { value: nextValue(index), last: index };
    paintCell(index, stroke.value);
  });
  board.addEventListener("pointermove", extend);
  const endStroke = () => { stroke = undefined; };
  board.addEventListener("pointerup", event => { extend(event); endStroke(); });
  board.addEventListener("pointercancel", endStroke);
  board.addEventListener("lostpointercapture", endStroke);

  function imagePoint(event: PointerEvent) {
    const rect = source.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(source.width, (event.clientX - rect.left) * source.width / rect.width)),
      y: Math.max(0, Math.min(source.height, (event.clientY - rect.top) * source.height / rect.height)),
    };
  }
  let start: ReturnType<typeof imagePoint> | undefined;
  function crop(event: PointerEvent): Rect | undefined {
    if (!start || !source.hasPointerCapture(event.pointerId)) return;
    const point = imagePoint(event);
    return {
      x: Math.min(start.x, point.x), y: Math.min(start.y, point.y),
      width: Math.abs(start.x - point.x), height: Math.abs(start.y - point.y),
    };
  }
  cropButton.addEventListener("click", () => {
    const armed = cropButton.getAttribute("aria-pressed") === "false";
    cropButton.setAttribute("aria-pressed", String(armed));
    if (armed) revealScreenshot();
  });
  source.addEventListener("pointerdown", event => {
    if (!event.isPrimary || event.button !== 0) return;
    if (event.pointerType === "touch" && cropButton.getAttribute("aria-pressed") !== "true") return;
    keyboardCrop = undefined;
    source.setPointerCapture(event.pointerId);
    start = imagePoint(event);
  });
  source.addEventListener("pointermove", event => {
    const rect = crop(event);
    if (rect) drawSource(rect);
  });
  source.addEventListener("pointerup", event => {
    const rect = crop(event);
    if (rect && rect.width >= 20 && rect.height >= 4) {
      cropButton.setAttribute("aria-pressed", "false");
      recognize(rect, event.pointerType === "touch");
    }
  });
  source.addEventListener("lostpointercapture", () => {
    start = undefined;
    drawSource();
  });

  source.addEventListener("keydown", event => {
    if (!recognition || event.ctrlKey || event.altKey || event.metaKey) return;
    if (event.key === "Escape" && keyboardCrop) {
      event.preventDefault();
      keyboardCrop = undefined;
      drawSource();
      return;
    }
    if (event.key === "Enter" && keyboardCrop) {
      event.preventDefault();
      recognize(keyboardCrop);
      return;
    }

    let dx = 0, dy = 0;
    switch (event.key) {
      case "ArrowLeft": dx = -1; break;
      case "ArrowRight": dx = 1; break;
      case "ArrowUp": dy = -1; break;
      case "ArrowDown": dy = 1; break;
      default: return;
    }
    if (source.width < 20 || source.height < 4) return;
    event.preventDefault();
    const previous = keyboardCrop ?? recognition.bounds;
    const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
    let width = clamp(previous.width || source.width, 20, source.width);
    let height = clamp(previous.height || source.height, 4, source.height);
    const x = clamp(previous.x + (event.shiftKey ? 0 : dx), 0, source.width - width);
    const y = clamp(previous.y + (event.shiftKey ? 0 : dy), 0, source.height - height);
    if (event.shiftKey) {
      width = clamp(width + dx, 20, source.width - x);
      height = clamp(height + dy, 4, source.height - y);
    }
    keyboardCrop = { x, y, width, height };
    drawSource(keyboardCrop);
  });
  source.addEventListener("blur", () => {
    if (!keyboardCrop) return;
    keyboardCrop = undefined;
    drawSource();
  });
  new ResizeObserver(() => drawSource(keyboardCrop)).observe(source);

  reset.addEventListener("click", () => {
    if (!recognition) return;
    cells = recognition.cells.slice();
    edited.clear();
    update();
  });
  trim.addEventListener("change", update);
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(output.value);
      exportStatus.textContent = "Emoji board copied.";
    } catch {
      text.open = true;
      output.focus();
      output.select();
      exportStatus.textContent = "Use the copy shortcut to copy the selected text.";
    }
  });
  open.addEventListener("click", () => {
    const parsed = parseBoardText(output.value);
    if (typeof parsed === "string") exportStatus.textContent = parsed;
    else if (!openEditor(output.value)) exportStatus.textContent = "Could not send the board. Copy it and paste it in the editor.";
  });

  pick.addEventListener("click", () => file.click());
  file.addEventListener("change", () => {
    const picked = file.files?.[0];
    if (picked) void load(picked);
    file.value = "";
  });
  document.addEventListener("paste", event => {
    if (root.hidden || document.querySelector("dialog[open]")) return;
    const pasted = Array.from(event.clipboardData?.files ?? []).find(item => item.type.startsWith("image/"));
    if (!pasted) return;
    event.preventDefault();
    void load(pasted);
  });
  root.addEventListener("dragover", event => {
    if (!event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    upload.classList.add("is-dragging");
  });
  root.addEventListener("dragleave", event => {
    if (!(event.relatedTarget instanceof Node) || !root.contains(event.relatedTarget)) upload.classList.remove("is-dragging");
  });
  root.addEventListener("drop", event => {
    upload.classList.remove("is-dragging");
    const dropped = event.dataTransfer?.files[0];
    if (!dropped) return;
    event.preventDefault();
    void load(dropped);
  });
}
