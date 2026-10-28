import {
  COLS,
  Game,
  Input,
  MINOS,
  ROWS,
  VISIBLE_ROWS,
  cellAt,
  version,
  type PieceId,
} from "@42tris/core";
import { loadHandling, setupHandling } from "./settings";
import { ACTIONS, actionForKey, actionNames, keyLabel, type Action } from "./keybinds";
import { loadKeybinds, setupKeybinds } from "./keybind-settings";

const canvas = document.querySelector<HTMLCanvasElement>("#board")!;
const status = document.querySelector<HTMLParagraphElement>("#status")!;
const holdCanvas = document.querySelector<HTMLCanvasElement>("#hold-preview")!;
const holdCtx = holdCanvas.getContext("2d")!;
const nextCanvas = document.querySelector<HTMLCanvasElement>("#next-preview")!;
const nextCtx = nextCanvas.getContext("2d")!;
const holdButton = document.querySelector<HTMLButtonElement>("#hold-button")!;
const pressed = new Map<string, Action>();
const bindings = loadKeybinds();
const cancelKeyCapture = setupKeybinds(bindings, updateControls);

function updateControls() {
  document.querySelector("#controls")!.textContent = actionNames.map(action =>
    `${bindings[action].filter(Boolean).map(keyLabel).join(" / ") || "Unbound"}: ${ACTIONS[action].label}`
  ).join(" · ");
}
updateControls();

// desynchronized lets chrome skip the compositor queue, lower input latency
const ctx = canvas.getContext("2d", { desynchronized: true })!;

// indexed by cell id, order matches Piece
const COLORS = [
  "",
  "#ef4444", // z
  "#f97316", // l
  "#eab308", // o
  "#22c55e", // s
  "#22d3ee", // i
  "#3b82f6", // j
  "#a855f7", // t
  "#6b7280", // garbage
];

const PREVIEWS = 5;
const READY_MS = 250;
let handling = loadHandling();
let seed: number;
let game: Game;
restart();
setupHandling(handling, value => {
  handling = value;
  game.setHandling(value);
});

const pauseDialog = document.querySelector<HTMLDialogElement>("#pause-dialog")!;
const settingsDialog = document.querySelector<HTMLDialogElement>("#settings-dialog")!;

function pause() {
  if (game.paused) return;
  game.setPaused(true, performance.now());
  pressed.clear();
  pauseDialog.showModal();
}

function resume() {
  cancelKeyCapture();
  settingsDialog.close();
  pauseDialog.close();
  game.setPaused(false, performance.now());
  document.querySelector<HTMLButtonElement>("#pause-button")!.blur();
}

function backToPause() {
  cancelKeyCapture();
  settingsDialog.close();
  pauseDialog.showModal();
}

function restart() {
  const random = new Uint32Array(1);
  do {
    crypto.getRandomValues(random);
  } while (random[0] === seed);
  seed = random[0];
  game = new Game(seed, 500, PREVIEWS, handling, READY_MS);
  game.tick(performance.now());
  status.textContent = `42tris core v${version()} | seed ${seed}`;
  pressed.clear();
}

document.querySelector("#pause-button")!.addEventListener("click", pause);
document.querySelector("#resume-button")!.addEventListener("click", resume);
document.querySelector("#settings-button")!.addEventListener("click", () => {
  pauseDialog.close();
  settingsDialog.showModal();
});
document.querySelector("#settings-back")!.addEventListener("click", backToPause);
holdButton.addEventListener("click", () => {
  game.apply(Input.Hold, performance.now());
  holdButton.blur();
});
for (const dialog of [pauseDialog, settingsDialog]) {
  dialog.addEventListener("cancel", e => e.preventDefault());
}
window.addEventListener("blur", pause);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) pause();
});

const LETTERS = "_ZLOSIJT";

const cell = canvas.width / COLS;
const hidden = ROWS - VISIBLE_ROWS;

function drawPreview(context: CanvasRenderingContext2D, piece: PieceId, slot: number) {
  const minos = MINOS[piece][0];
  let minX = 4;
  let maxX = 0;
  let minY = 4;
  let maxY = 0;
  for (let i = 0; i < 8; i += 2) {
    minX = Math.min(minX, minos[i]);
    maxX = Math.max(maxX, minos[i]);
    minY = Math.min(minY, minos[i + 1]);
    maxY = Math.max(maxY, minos[i + 1]);
  }
  const slotHeight = cell * 3;
  const offsetX = (context.canvas.width - (maxX - minX + 1) * cell) / 2;
  const offsetY = slot * slotHeight + (slotHeight - (maxY - minY + 1) * cell) / 2;
  context.fillStyle = COLORS[piece];
  context.strokeStyle = "#333";
  for (let i = 0; i < 8; i += 2) {
    const x = offsetX + (minos[i] - minX) * cell;
    const y = offsetY + (minos[i + 1] - minY) * cell;
    context.fillRect(x, y, cell, cell);
    context.strokeRect(x + 0.5, y + 0.5, cell - 1, cell - 1);
  }
}

function render() {
  holdCtx.clearRect(0, 0, holdCanvas.width, holdCanvas.height);
  holdButton.disabled = game.holdUsed || game.paused || game.topOut || game.starting;
  holdCanvas.setAttribute("aria-label", game.held === null ? "Hold empty" : `Held piece ${LETTERS[game.held]}`);
  if (game.held !== null) drawPreview(holdCtx, game.held, 0);

  nextCtx.clearRect(0, 0, nextCanvas.width, nextCanvas.height);
  let nextLabel = "Next pieces:";
  for (let i = 0; i < game.previews.length; i++) {
    drawPreview(nextCtx, game.previews[i] as PieceId, i);
    nextLabel += ` ${LETTERS[game.previews[i]]}`;
  }
  nextCanvas.setAttribute("aria-label", nextLabel);
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  for (let y = 0; y < VISIBLE_ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const id = cellAt(game.board, x, y + hidden);
      if (id === 0) continue;
      ctx.fillStyle = COLORS[id];
      ctx.fillRect(x * cell, y * cell, cell, cell);
    }
  }

  if (!game.starting) {
    const m = MINOS[game.piece][game.rot];
    ctx.fillStyle = COLORS[game.piece];
    for (let i = 0; i < 8; i += 2) {
      const px = game.x + m[i];
      const py = game.y + m[i + 1] - hidden;
      if (py >= 0) ctx.fillRect(px * cell, py * cell, cell, cell);
    }
  }

  ctx.strokeStyle = "#333";
  for (let x = 0; x <= COLS; x++) {
    ctx.beginPath();
    ctx.moveTo(x * cell + 0.5, 0);
    ctx.lineTo(x * cell + 0.5, VISIBLE_ROWS * cell);
    ctx.stroke();
  }
  for (let y = 0; y <= VISIBLE_ROWS; y++) {
    ctx.beginPath();
    ctx.moveTo(0, y * cell + 0.5);
    ctx.lineTo(COLS * cell, y * cell + 0.5);
    ctx.stroke();
  }
}

// inputs go straight to the game on the event, never wait for a frame
window.addEventListener("keydown", (e) => {
  const action = actionForKey(bindings, e.key);
  if (e.key === "Escape" || (action === "pause" && !settingsDialog.open)) {
    e.preventDefault();
    if (e.repeat) return;
    if (settingsDialog.open) backToPause();
    else if (game.paused) resume();
    else pause();
    return;
  }
  if (game.paused) return;
  if (!action || action === "pause") return;
  e.preventDefault();
  // Held keys repeat inside the core, not through browser key repeat.
  if (e.repeat || e.isComposing || pressed.has(e.code)) return;
  if (action === "restart") {
    restart();
    return;
  }
  if (game.starting) return;
  const alreadyHeld = [...pressed.values()].includes(action);
  pressed.set(e.code, action);
  const binding = ACTIONS[action];
  if (!("up" in binding) || !alreadyHeld) game.apply(binding.down, performance.now());
});
window.addEventListener("keyup", (e) => {
  // Use the physical key recorded on keydown, even if Shift changed its symbol.
  const action = pressed.get(e.code);
  pressed.delete(e.code);
  if (!action || [...pressed.values()].includes(action)) return;
  const binding = ACTIONS[action];
  if ("up" in binding) game.apply(binding.up, performance.now());
});

function frame(now: number) {
  game.tick(now);
  if (game.topOut && !game.paused) restart();
  render();
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
