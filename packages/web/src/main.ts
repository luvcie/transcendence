import {
  COLS,
  Game,
  Input,
  finesseAccuracy,
  Piece,
  type PieceId,
  type InputId,
} from "@42tris/core";
import { loadHandling, setupHandling, setupGhost, setupZen } from "./settings";
import { ACTIONS, actionNames, keyLabel, type Action } from "./keybinds";
import { loadKeybinds, setupKeybinds } from "./keybind-settings";
import { SkinState } from "./skin-state";
import { setupSettingsTabs, setupSkins } from "./skin-settings";
import { drawPiecePreview } from "./tile-renderer";
import { drawBoard } from "./board-view";
import { mountOnline } from "./online-view";
import { mountGameplayInput } from "./gameplay-input";
import { renderOnlineWaiting } from "./waiting-view";
import { snapshotDisplay, type GameDisplay } from "./game-display";
import { mountAppView } from "./app-view";

let online: ReturnType<typeof mountOnline> | undefined;
const showView = mountAppView(document);
showView("solo");

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
const finesseCount = document.querySelector("#finesse-count")!;
const finalFinesse = document.querySelector<HTMLParagraphElement>("#final-finesse")!;
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
  if (!online) game.setZen(enabled);
  refreshHud();
});

function updateControls() {
  document.querySelector("#controls")!.textContent = actionNames.map(action =>
    `${bindings[action].filter(Boolean).map(keyLabel).join(" / ") || "Unbound"}: ${ACTIONS[action].label}`
  ).join(" · ");
}
updateControls();

// Desynchronized canvas lets the browser skip the compositor queue, lowering input latency.
const ctx = canvas.getContext("2d", { desynchronized: true })!;

const PREVIEWS = 5;
const READY_MS = 250;
let handling = loadHandling();
let seed: number;
let game: Game;
let display: GameDisplay | null = null;
restart();
setupHandling(handling, value => {
  handling = value;
  if (!online) game.setHandling(value);
});

const pauseDialog = document.querySelector<HTMLDialogElement>("#pause-dialog")!;
const settingsDialog = document.querySelector<HTMLDialogElement>("#settings-dialog")!;

function focusView() {
  const gameView = document.querySelector<HTMLElement>("#game-view")!;
  (gameView.hidden ? document.querySelector<HTMLElement>("#view-title")! : gameView).focus({ preventScroll: true });
}

function pause() {
  if (online || game.paused) return;
  game.setPaused(true, performance.now());
  consumeEvents();
  pressed.clear();
  pauseDialog.showModal();
}

function resume() {
  cancelKeyCapture();
  settingsDialog.close();
  pauseDialog.close();
  if (!online) game.setPaused(false, performance.now());
  focusView();
}

let settingsFromMenu = false;
function openSettings(fromMenu: boolean) {
  settingsFromMenu = fromMenu;
  if (fromMenu) pauseDialog.close();
  else if (online) {
    online.session.release();
    pressed.clear();
  } else {
    game.setPaused(true, performance.now());
    consumeEvents();
    pressed.clear();
  }
  settingsDialog.showModal();
}

function closeSettings() {
  if (!settingsFromMenu) { resume(); return; }
  cancelKeyCapture();
  settingsDialog.close();
  pauseDialog.showModal();
}

function restart() {
  if (online) { online.session.practice("practiceReset"); return; }
  const random = new Uint32Array(1);
  do {
    crypto.getRandomValues(random);
  } while (random[0] === seed);
  seed = random[0];
  game = new Game(seed, 500, PREVIEWS, handling, READY_MS);
  game.setZen(zen);
  game.tick(performance.now());
  display = game;
  refreshHud();
  status.textContent = "Singleplayer";
  pressed.clear();
}

document.querySelector("#pause-button")!.addEventListener("click", pause);
function enterOnline() {
  cancelKeyCapture();
  settingsDialog.close();
  pauseDialog.close();
  pressed.clear();
  if (online) {
    online.session.release();
    focusView();
    return;
  }
  game.setPaused(true, performance.now());
  display = null;
  const root = document.querySelector<HTMLElement>("#online")!;
  showView("lobby");
  online = mountOnline(root, {
    clearKeys: () => pressed.clear(), handling: () => handling, skins, view: showView,
    local() {
      online?.destroy();
      online = undefined;
      pauseDialog.close();
      settingsDialog.close();
      document.querySelector("#pause-title")!.textContent = "Paused";
      showView("solo");
      restart();
    },
  });
}
document.querySelector("#online-button")!.addEventListener("click", enterOnline);
function enterSolo() {
  if (online) online.local();
  else if (pauseDialog.open || settingsDialog.open) resume();
  else document.querySelector<HTMLElement>("#game-view")!.focus({ preventScroll: true });
}
document.querySelector("#solo-button")!.addEventListener("click", enterSolo);
document.querySelector("#resume-button")!.addEventListener("click", resume);
document.querySelector("#settings-button")!.addEventListener("click", () => openSettings(true));
document.querySelector("#nav-settings-button")!.addEventListener("click", () => openSettings(false));
document.querySelector("#settings-back")!.addEventListener("click", closeSettings);
holdButton.addEventListener("click", () => {
  applyInput(Input.Hold);
  holdButton.blur();
});
for (const dialog of [pauseDialog, settingsDialog]) {
  dialog.addEventListener("cancel", e => e.preventDefault());
}
function handleFocusLoss() {
  if (online) {
    online.session.release();
    pressed.clear();
  } else {
    pause();
  }
}

window.addEventListener("blur", handleFocusLoss);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) handleFocusLoss();
});

function refreshHud() {
  if (!display) return;
  const { lines, combo, chainLength, b2b, surge } = display.stats;
  lineCount.textContent = String(lines);
  comboCount.textContent = String(Math.max(0, combo));
  b2bCount.textContent = chainLength === 0 ? "—" : b2b === 0 ? "Ready" : String(b2b);
  b2bCount.setAttribute("title", chainLength === 0
    ? "Clear a Quad, spin or all clear to start B2B."
    : b2b === 0 ? "Chain started. The next qualifying clear earns the B2B bonus." : `${b2b} back-to-back clears.`);
  surgeCount.textContent = String(surge);
  const accuracy = finesseAccuracy(display.finesse);
  finesseCount.textContent = `${accuracy === null ? "—" : `${accuracy.toFixed(1)}%`} · ${display.finesse.faults} faults / ${display.finesse.evaluated} evaluated`;
  const result = display.lastClear;
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
  zenStatus.hidden = !display.zen;
  zenStatus.textContent = online ? "Online practice · Ctrl+Z to undo; restart resets your board."
    : `${display.topOut ? "Top out. " : ""}Zen · Ctrl+Z to undo (${game.undoCount} available)${display.topOut ? " or restart." : ""}`;
}

function consumeEvents() {
  if (game.drainEvents().length || game.topOut) refreshHud();
}

function applyInput(input: InputId) {
  if (online) { online.session.input(input); return; }
  game.apply(input, performance.now());
  consumeEvents();
}

const cell = canvas.width / COLS;

function drawPreview(context: CanvasRenderingContext2D, piece: PieceId, slot: number) {
  drawPiecePreview(context, piece, cell, context.canvas.width, cell * 3, slot * cell * 3, skins.loaded);
}

function render() {
  if (online && renderOnlineWaiting(document, online.session)) return;
  if (!display) return;
  if (canvas.getAttribute("aria-label") !== "42tris playfield") canvas.setAttribute("aria-label", "42tris playfield");
  holdCtx.clearRect(0, 0, holdCanvas.width, holdCanvas.height);
  holdButton.disabled = display.holdUsed || display.paused || display.topOut || display.starting || (!!online && !online.session.canPlay);
  holdCanvas.setAttribute("aria-label", display.held === null ? "Hold empty" : `Held piece ${LETTERS[display.held]}`);
  if (display.held !== null) drawPreview(holdCtx, display.held, 0);

  nextCtx.clearRect(0, 0, nextCanvas.width, nextCanvas.height);
  let nextLabel = "Next pieces:";
  for (let i = 0; i < display.previews.length; i++) {
    drawPreview(nextCtx, display.previews[i] as PieceId, i);
    nextLabel += ` ${LETTERS[display.previews[i]]}`;
  }
  nextCanvas.setAttribute("aria-label", nextLabel);
  drawBoard(ctx, display, skins.loaded, showGhost);
}

const unmountInput = mountGameplayInput(window, {
  bindings, pressed,
  editable: target => target instanceof HTMLElement && !!target.closest("input, textarea, select, button, summary, a, [contenteditable=true]"),
  blocked: () => pauseDialog.open || settingsDialog.open || !!online?.detailsOpen || (online ? !online.session.canPlay : game.paused),
  settingsOpen: () => settingsDialog.open,
  starting: () => display?.starting ?? true,
  menu() {
    if (online?.detailsOpen) online.closeDetails();
    else if (settingsDialog.open) closeSettings();
    else if (pauseDialog.open || (!online && game.paused)) resume();
    else if (!online) pause();
  },
  undo() {
    if (online) online.session.practice("practiceUndo");
    else if (game.zen && game.undo(performance.now())) { pressed.clear(); consumeEvents(); }
  },
  restart, input: applyInput, lateRelease: () => online?.session.release(),
});

function frame() {
  if (online) {
    online.update();
    const session = online?.session;
    const state = session?.prediction?.gameState();
    if (state) { display = snapshotDisplay(state); refreshHud(); }
    else if (session && !session.checkpoint?.state) display = null;
    if (session) {
      const cp = session.checkpoint;
      const index = cp?.state?.roster.indexOf(session.playerId) ?? -1;
      const details = [`${session.name} (you)`];
      if (cp?.state && index >= 0) {
        const score = cp.state.scores[index];
        details.push(`${score} ${score === 1 ? "point" : "points"}`);
        if (cp.state.players[index].game.state.topOut) details.push("Top out");
      }
      const label = details.join(" · ");
      if (status.textContent !== label) status.textContent = label;
    }
  } else {
    game.tick(performance.now());
    consumeEvents();
    if (game.topOut && !game.paused && !game.zen) {
      const accuracy = finesseAccuracy(game.finesse);
      finalFinesse.textContent = `Last game finesse: ${accuracy === null ? "—" : `${accuracy.toFixed(1)}%`} · ${game.finesse.faults} faults / ${game.finesse.evaluated} evaluated`;
      finalFinesse.hidden = false;
      restart();
    }
  }
  render();
  frameId = requestAnimationFrame(frame);
}

let frameId = requestAnimationFrame(frame);
window.addEventListener("pagehide", e => { cancelAnimationFrame(frameId); online?.session.stop(); if (!e.persisted) unmountInput(); });
window.addEventListener("pageshow", e => { if (e.persisted) { online?.session.start(); frameId = requestAnimationFrame(frame); } });
let hasResume = false;
try { hasResume = !!sessionStorage.getItem("42tris.resume"); }
catch { status.textContent += " · Session storage unavailable; refresh cannot resume online play."; }
if (new URL(location.href).searchParams.has("room") || hasResume) enterOnline();
