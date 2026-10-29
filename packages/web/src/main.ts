import {
  COLS,
  Game,
  Input,
  Piece,
  MINOS,
  ROWS,
  VISIBLE_ROWS,
  cellAt,
  canPlace,
  version,
  type PieceId,
  type InputId,
} from "@42tris/core";
import { loadHandling, setupHandling, setupGhost, setupZen } from "./settings";
import { ACTIONS, actionForKey, actionNames, keyLabel, type Action } from "./keybinds";
import { loadKeybinds, setupKeybinds } from "./keybind-settings";
import { SkinState } from "./skin-state";
import { setupSettingsTabs, setupSkins } from "./skin-settings";
import { drawPiecePreview, drawTile, joinedAbove } from "./tile-renderer";

const canvas = document.querySelector<HTMLCanvasElement>("#board")!;
const status = document.querySelector<HTMLParagraphElement>("#status")!;
const holdCanvas = document.querySelector<HTMLCanvasElement>("#hold-preview")!;
const holdCtx = holdCanvas.getContext("2d")!;
const nextCanvas = document.querySelector<HTMLCanvasElement>("#next-preview")!;
const nextCtx = nextCanvas.getContext("2d")!;
const holdButton = document.querySelector<HTMLButtonElement>("#hold-button")!;
const lineCount = document.querySelector("#line-count")!;
const comboCount = document.querySelector("#combo-count")!;
const b2bCount = document.querySelector("#b2b-count")!;
const surgeCount = document.querySelector("#surge-count")!;
const clearResult = document.querySelector("#clear-result")!;
const zenStatus = document.querySelector<HTMLParagraphElement>("#zen-status")!;
const LETTERS = "_ZLOSIJT";
const pressed = new Map<string, Action>();
const bindings = loadKeybinds();
const cancelKeyCapture = setupKeybinds(bindings, updateControls);
const skins = new SkinState(() => localStorage);
void skins.select(skins.preferences.active, false);
setupSettingsTabs(cancelKeyCapture, setupSkins(skins));
let showGhost = setupGhost(enabled => { showGhost = enabled; });
let zen = setupZen(enabled => {
  zen = enabled;
  game.setZen(enabled);
  refreshHud();
});

function updateControls() {
  document.querySelector("#controls")!.textContent = actionNames.map(action =>
    `${bindings[action].filter(Boolean).map(keyLabel).join(" / ") || "Unbound"}: ${ACTIONS[action].label}`
  ).join(" · ");
}
updateControls();

// desynchronized lets chrome skip the compositor queue, lower input latency
const ctx = canvas.getContext("2d", { desynchronized: true })!;

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
  consumeEvents();
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
  game.setZen(zen);
  game.tick(performance.now());
  refreshHud();
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
  applyInput(Input.Hold);
  holdButton.blur();
});
for (const dialog of [pauseDialog, settingsDialog]) {
  dialog.addEventListener("cancel", e => e.preventDefault());
}
window.addEventListener("blur", pause);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) pause();
});

function refreshHud() {
  const { lines, combo, chainLength, b2b, surge } = game.stats;
  lineCount.textContent = String(lines);
  comboCount.textContent = String(Math.max(0, combo));
  b2bCount.textContent = chainLength === 0 ? "—" : b2b === 0 ? "Ready" : String(b2b);
  b2bCount.setAttribute("title", chainLength === 0
    ? "Clear a Quad, spin or all clear to start B2B."
    : b2b === 0 ? "Chain started. The next qualifying clear earns the B2B bonus." : `${b2b} back-to-back clears.`);
  surgeCount.textContent = String(surge);
  const result = game.lastClear;
  const labels: string[] = [];
  if (result) {
    const clear = ["", "Single", "Double", "Triple", "Quad"][result.rows.length];
    let spin = "";
    if (result.spin !== "none") {
      spin = `${LETTERS[result.piece]}-spin`;
      if (result.piece === Piece.T && result.spin === "mini") spin += " mini";
    }
    const placement = [spin, clear].filter(Boolean).join(" ");
    if (placement) labels.push(placement);
    if (result.allClear) labels.push("All clear");
    const attack = result.attacks.reduce((sum, packet) => sum + packet.lines, 0);
    if (attack) labels.push(`Attack ${attack}`);
  }
  clearResult.textContent = labels.join(" · ");
  zenStatus.hidden = !game.zen;
  zenStatus.textContent = `${game.topOut ? "Top out. " : ""}Zen · Ctrl+Z to undo (${game.undoCount} available)${game.topOut ? " or restart." : ""}`;
}

function consumeEvents() {
  if (game.drainEvents().length || game.topOut) refreshHud();
}

function applyInput(input: InputId) {
  game.apply(input, performance.now());
  consumeEvents();
}

const cell = canvas.width / COLS;
const hidden = ROWS - VISIBLE_ROWS;

function drawPreview(context: CanvasRenderingContext2D, piece: PieceId, slot: number) {
  drawPiecePreview(context, piece, cell, context.canvas.width, cell * 3, slot * cell * 3, skins.loaded);
}

function drawActivePiece(y: number, ghost = false) {
  const minos = MINOS[game.piece][game.rot];
  for (let i = 0; i < 8; i += 2) {
    const px = game.x + minos[i];
    const py = y + minos[i + 1] - hidden;
    if (py >= 0) drawTile(ctx, game.piece, px * cell, py * cell, cell, skins.loaded, joinedAbove(minos, i), ghost);
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
      drawTile(ctx, id, x * cell, y * cell, cell, skins.loaded, cellAt(game.board, x, y + hidden - 1) === id);
    }
  }

  if (!game.starting) {
    if (showGhost && !game.topOut) {
      let landingY = game.y;
      while (canPlace(game.board, game.piece, game.rot, game.x, landingY + 1)) landingY++;
      if (landingY !== game.y) {
        ctx.globalAlpha = 0.25;
        drawActivePiece(landingY, true);
        ctx.globalAlpha = 1;
      }
    }
    drawActivePiece(game.y);
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

window.addEventListener("keydown", (e) => {
  if (e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && e.key.toLowerCase() === "z") {
    if (game.zen && !game.paused && !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLTextAreaElement)) {
      e.preventDefault();
      if (!e.repeat && !e.isComposing && game.undo(performance.now())) {
        pressed.clear();
        consumeEvents();
      }
    }
    return;
  }
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
  if (!("up" in binding) || !alreadyHeld) applyInput(binding.down);
});
window.addEventListener("keyup", (e) => {
  // Use the physical key recorded on keydown, even if Shift changed its symbol.
  const action = pressed.get(e.code);
  pressed.delete(e.code);
  if (!action || [...pressed.values()].includes(action)) return;
  const binding = ACTIONS[action];
  if ("up" in binding) applyInput(binding.up);
});

function frame(now: number) {
  game.tick(now);
  consumeEvents();
  if (game.topOut && !game.paused && !game.zen) restart();
  render();
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
