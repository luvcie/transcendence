import { emojis } from "../board-emoji";
import { parseBoardText } from "../emoji-editor";
import { toEmoji } from "./emoji";
import { recognizeBoard, type Recognition, type Rect } from "./recognize";

export function mountMinolens(root: HTMLElement, openEditor: (text: string) => boolean) {
  const { ownerDocument: document } = root;
  const file = root.querySelector<HTMLInputElement>("#minolens-file")!;
  const work = root.querySelector<HTMLElement>("#minolens-work")!;
  const source = root.querySelector<HTMLCanvasElement>("#minolens-source")!;
  const ctx = source.getContext("2d");
  const board = root.querySelector<HTMLElement>("#minolens-board")!;
  const palette = root.querySelector<HTMLElement>("#minolens-palette")!;
  const output = root.querySelector<HTMLTextAreaElement>("#minolens-output")!;
  const message = root.querySelector<HTMLElement>("#minolens-status")!;
  const trim = root.querySelector<HTMLInputElement>("#minolens-trim")!;
  const copy = root.querySelector<HTMLButtonElement>("#minolens-copy")!;
  const open = root.querySelector<HTMLButtonElement>("#minolens-open")!;
  let image: ImageData | undefined;
  let recognition: Recognition | undefined;
  let cells: Uint8Array = new Uint8Array(0);
  let buttons: HTMLButtonElement[] = [];
  let paint: number | null = null;
  let loadVersion = 0;

  function update() {
    buttons.forEach((button, index) => {
      const emoji = emojis[cells[index]];
      if (button.textContent !== emoji) button.textContent = emoji;
    });
    output.value = recognition ? toEmoji(cells, recognition.cols, trim.checked).join("\n") : "";
    output.rows = Math.max(3, Math.min(8, output.value.split("\n").length));
    copy.disabled = open.disabled = !output.value;
  }

  function drawSource(drag?: Rect) {
    if (!ctx || !image || !recognition) return;
    ctx.putImageData(image, 0, 0);
    const { bounds: { x, y, width, height }, cell, rows, cols } = recognition;
    ctx.lineWidth = (2 * source.width) / (source.clientWidth || source.width);
    ctx.strokeStyle = "#ffffff59";
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
    ctx.strokeStyle = "#22d3ee";
    ctx.strokeRect(x, y, width, height);
    if (drag) {
      ctx.strokeStyle = "#fff";
      ctx.strokeRect(drag.x, drag.y, drag.width, drag.height);
    }
  }

  function recognize(bounds?: Rect) {
    if (!image) return;
    recognition = recognizeBoard(image, { bounds });
    cells = recognition.cells.slice();
    message.textContent = cells.some(id => id !== 0) ? "" : "No board found. Drag around it on the image.";
    const cols = recognition.cols;
    buttons = Array.from(cells, (_, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "emoji-cell";
      button.dataset.cell = String(index);
      button.addEventListener("click", () => {
        cells[index] = paint ?? (cells[index] + 1) % emojis.length;
        update();
      });
      return button;
    });
    board.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
    board.replaceChildren(...buttons);
    board.hidden = cells.length === 0;
    drawSource();
    update();
  }

  async function load(blob: Blob) {
    const version = ++loadVersion;
    if (!ctx) {
      message.textContent = "Could not read image pixels in this browser.";
      return;
    }
    try {
      const bitmap = await createImageBitmap(blob);
      try {
        if (version !== loadVersion || root.hidden) return;
        source.width = bitmap.width;
        source.height = bitmap.height;
        ctx.drawImage(bitmap, 0, 0);
        image = ctx.getImageData(0, 0, source.width, source.height);
      } finally {
        bitmap.close();
      }
      work.hidden = false;
      recognize();
    } catch {
      if (version !== loadVersion || root.hidden) return;
      if (image) {
        source.width = image.width;
        source.height = image.height;
        drawSource();
      }
      message.textContent = "Could not read that image.";
    }
  }

  const swatches = emojis.map((emoji, id) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "emoji-color";
    button.textContent = emoji;
    button.setAttribute("aria-pressed", "false");
    button.addEventListener("click", () => {
      paint = paint === id ? null : id;
      board.classList.toggle("painting", paint !== null);
      swatches.forEach((swatch, color) => swatch.setAttribute("aria-pressed", String(paint === color)));
    });
    return button;
  });
  palette.replaceChildren(...swatches);

  function paintAt(event: PointerEvent) {
    const target = document.elementFromPoint(event.clientX, event.clientY);
    if (!(target instanceof HTMLButtonElement) || target.parentElement !== board || paint === null) return;
    const index = Number(target.dataset.cell);
    if (cells[index] === paint) return;
    cells[index] = paint;
    update();
  }
  board.addEventListener("pointerdown", event => {
    if (paint === null || !event.isPrimary || event.button !== 0) return;
    board.setPointerCapture(event.pointerId);
    paintAt(event);
  });
  board.addEventListener("pointermove", event => {
    if (board.hasPointerCapture(event.pointerId)) paintAt(event);
  });

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
  source.addEventListener("pointerdown", event => {
    if (!event.isPrimary || event.button !== 0) return;
    source.setPointerCapture(event.pointerId);
    start = imagePoint(event);
  });
  source.addEventListener("pointermove", event => {
    const rect = crop(event);
    if (rect) drawSource(rect);
  });
  source.addEventListener("pointerup", event => {
    const rect = crop(event);
    if (rect && rect.width >= 20 && rect.height >= 4) recognize(rect);
  });
  source.addEventListener("lostpointercapture", () => {
    start = undefined;
    drawSource();
  });

  root.querySelector("#minolens-reset")!.addEventListener("click", () => {
    if (!recognition) return;
    cells = recognition.cells.slice();
    message.textContent = "";
    update();
  });
  trim.addEventListener("change", update);
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(output.value);
      message.textContent = "Copied.";
    } catch {
      output.select();
      message.textContent = "Use the copy shortcut to copy the selected text.";
    }
  });
  open.addEventListener("click", () => {
    const parsed = parseBoardText(output.value);
    if (typeof parsed === "string") message.textContent = parsed;
    else if (!openEditor(output.value)) message.textContent = "Could not send the board. Copy it and paste it in the editor.";
  });

  root.querySelector("#minolens-pick")!.addEventListener("click", () => file.click());
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
    if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
  });
  root.addEventListener("drop", event => {
    const dropped = event.dataTransfer?.files[0];
    if (!dropped) return;
    event.preventDefault();
    void load(dropped);
  });
}
