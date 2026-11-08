import { setText, setHidden, setDisabled, setAttributeIfChanged } from "./dom-update";
import { mountReplayControls } from "./replay-controls";
import { mountCompetitivePlayback } from "./competitive-playback";
import type { requestCompetitiveReplay } from "./replay-request";
import {
  ROWS,
  Input,
  Piece,
  type PieceId,
  type InputId,
} from "@42tris/core";
import { loadHandling, setupHandling, setupGhost } from "./settings";
import { ACTIONS, actionNames, keyLabel, type Action } from "./keybinds";
import { loadKeybinds, setupKeybinds } from "./keybind-settings";
import { SkinState } from "./skin-state";
import { setupSettingsTabs, setupSkins } from "./skin-settings";
import { SoundPlayer } from "./sound-player";
import { SoundState } from "./sound-state";
import { setupSounds } from "./sound-settings";
import { ZenMusic } from "./zen-music";
import { setupMusic } from "./music-settings";
import { mountVolumeOverlay } from "./volume-overlay";
import { GameSounds } from "./game-sounds";
import { withMatchReplaySounds, withSprintReplaySounds, type ReplaySoundOutput } from "./replay-sounds";
import { drawPiecePreview } from "./tile-renderer";
import { drawBoard } from "./board-view";
import { mountOnline } from "./online-view";
import { mountGuestName } from "./guest-name";
import { dismissSettingsOnBackdrop } from "./settings-dialog";
import { MultiplayerSkinPreference, setupMultiplayerSkinSetting, shareableSkinId } from "./multiplayer-skins";
import { mountGameplayInput } from "./gameplay-input";
import { mountHoldExit } from "./hold-exit";
import { renderOnlineWaiting } from "./waiting-view";
import { snapshotDisplay, type GameDisplay } from "./game-display";
import { initialView, mountAppView, onlineView } from "./app-view";
import { Singleplayer, SINGLEPLAYER_MODES, formatTime, finesseSummary, type SingleplayerMode } from "./singleplayer";
import { SprintRecorder } from "@42tris/replay";
import { abandonSprintRecording, sprintRecordingFor, startSprintRecording } from "./sprint-recording";
import { SprintPlayback } from "./sprint-playback";
import { SessionDiagnostics } from "./session-diagnostics";
import { configuredInputLead } from "./netplay-options";
import { mountModeCard, SprintCountdown } from "./sprint-training";

let online: ReturnType<typeof mountOnline> | undefined;
let invite = new URL(location.href).searchParams.get("room");
// Configuration is immutable until page reload; localStorage cannot authorize lead.
const netplayParams = new URL(location.href).searchParams;
const inputLeadMs = configuredInputLead(netplayParams);
// Opt-in only: append ?diagnostics or set localStorage["42tris.diagnostics"] = "1".
const netDiagnostics = (() => {
  try {
    return netplayParams.has("diagnostics") || localStorage.getItem("42tris.diagnostics") === "1"
      ? new SessionDiagnostics() : undefined;
  } catch { return undefined; }
})();
if (netDiagnostics) (globalThis as unknown as { __42trisNetDiagnostics?: SessionDiagnostics }).__42trisNetDiagnostics = netDiagnostics;
let hasResume = false;
try { hasResume = !!sessionStorage.getItem("42tris.resume"); } catch { /* Online session will report storage failures. */ }
let atHome = initialView(location.href, hasResume) === "home";
const showView = mountAppView(document);
showView(atHome ? "home" : "lobby");

const canvas = document.querySelector<HTMLCanvasElement>("#board")!;
const status = document.querySelector<HTMLParagraphElement>("#status")!;
const guestName = mountGuestName(document.querySelector<HTMLElement>("#guest-name-editor")!, () => online?.session);
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
const sprintClock = document.querySelector<HTMLElement>("#sprint-clock")!;
const elapsedTime = document.querySelector<HTMLElement>("#elapsed-time")!;
const resultPanel = document.querySelector<HTMLElement>("#sprint-result")!;
const watchReplayButton = document.querySelector<HTMLButtonElement>("#watch-replay-button")!;
const replayBar = document.querySelector<HTMLElement>("#replay-bar")!;
const replayToggle = document.querySelector<HTMLButtonElement>("#replay-toggle")!;
const clearResult = document.querySelector("#clear-result")!;
const zenStatus = document.querySelector<HTMLParagraphElement>("#zen-status")!;
const LETTERS = "_ZLOSIJT";
const pressed = new Map<string, Action>();
for (const mode of ["sprint", "zen"] as const) mountModeCard(document, mode, () => localStorage);
const sprintOption = document.querySelector<HTMLInputElement>("#sprint-reset-finesse")!;
const finesseSoundOptions = {
  sprint: document.querySelector<HTMLInputElement>("#sprint-sound-finesse")!,
  zen: document.querySelector<HTMLInputElement>("#zen-sound-finesse")!,
};
const countdown = new SprintCountdown();
const countdownOverlay = document.querySelector<HTMLElement>("#sprint-countdown")!;
let resetOnFinesseFault = false;
let soundOnFinesseFault = false;
const bindings = loadKeybinds();
const cancelKeyCapture = setupKeybinds(bindings, updateControls);
const skins = new SkinState(() => localStorage);
void skins.select(skins.preferences.active, false);
const multiplayerSkins = new MultiplayerSkinPreference();
setupMultiplayerSkinSetting(multiplayerSkins);
const soundPlayer = new SoundPlayer();
const music = new ZenMusic(() => soundPlayer.audio(), () => localStorage);
setupMusic(music, syncZenMusic);
const sounds = new SoundState(() => localStorage, (pack, signal) => soundPlayer.load(pack, signal));
const gameSounds = new GameSounds(() => sounds.preferences.enabled ? sounds.loaded?.pack : undefined,
  clips => {
    if (sounds.preferences.enabled && sounds.loaded && !document.hidden && !atHome && !settingsDialog.open && !activePlayback()) soundPlayer.play(clips, sounds.loaded);
  }, () => !!online || soundOnFinesseFault);
const replaySoundOutput: ReplaySoundOutput = {
  pack: () => sounds.preferences.enabled && sounds.preferences.active !== "silent" ? sounds.loaded?.pack : undefined,
  play: clips => {
    if (sounds.preferences.enabled && sounds.loaded && !document.hidden && !settingsDialog.open) soundPlayer.play(clips, sounds.loaded);
  },
  stop: () => soundPlayer.stop(),
};
setupSettingsTabs(cancelKeyCapture, setupSkins(skins), setupSounds(sounds, soundPlayer));
void sounds.select(sounds.preferences.active, false);
const unlockSounds = () => {
  if (sounds.preferences.enabled && sounds.preferences.active !== "silent") {
    void soundPlayer.unlock().catch((error: Error) => { sounds.message = `Audio unavailable: ${error.message}`; sounds.changed(); });
  }
};
window.addEventListener("pointerdown", unlockSounds);
window.addEventListener("keydown", unlockSounds);
let showGhost = setupGhost(enabled => { showGhost = enabled; });
// Zen is selected per game; old preferences no longer control gameplay.
try { localStorage.removeItem("42tris.zen"); } catch { /* Storage is optional. */ }

function updateControls() {
  document.querySelector("#controls")!.textContent = actionNames.map(action =>
    `${bindings[action].filter(Boolean).map(keyLabel).join(" / ") || "Unbound"}: ${ACTIONS[action].label}`
  ).join(" · ");
}
updateControls();

// Desynchronized canvas lets the browser skip the compositor queue, lowering input latency.
const ctx = canvas.getContext("2d", { desynchronized: true })!;

const widthSelect = document.querySelector<HTMLSelectElement>("#solo-width")!;
try {
  const saved = Number(localStorage.getItem("42tris.boardWidth"));
  if (Number.isInteger(saved) && saved >= 4 && saved <= 12) widthSelect.value = String(saved);
} catch { /* Use the default when storage is unavailable. */ }
widthSelect.addEventListener("change", () => {
  try { localStorage.setItem("42tris.boardWidth", widthSelect.value); } catch { /* Selection remains available for this session. */ }
});
let handling = loadHandling();
let seed: number | undefined;
let solo: Singleplayer | SprintRecorder | null = null;
let soundedResult: Singleplayer["result"] = null;
let soundedGame: Singleplayer["game"] | null = null;
let pendingMode: SingleplayerMode | null = null;
let modeRequest = 0;
let display: GameDisplay | null = null;
let playback: SprintPlayback | null = null;
let competitivePlayback: ReturnType<typeof mountCompetitivePlayback> | null = null;
const matchReplayHost = document.querySelector<HTMLElement>("#match-replay-host")!;
const replaySeek = document.querySelector<HTMLInputElement>("#replay-seek")!;
function activePlayback() { return competitivePlayback ?? playback; }
let openingPlayback = false;
let lastFrameAt: number | null = null;
setupHandling(handling, value => {
  handling = value;
  if (!online && !playback) { solo?.setHandling(value, performance.now()); pressed.clear(); }
});

const pauseDialog = document.querySelector<HTMLDialogElement>("#pause-dialog")!;
const settingsDialog = document.querySelector<HTMLDialogElement>("#settings-dialog")!;
const abandonDialog = document.querySelector<HTMLDialogElement>("#abandon-dialog")!;
const navSettingsButton = document.querySelector<HTMLButtonElement>("#nav-settings-button")!;

function gameplayActive() {
  return !atHome && !activePlayback() && !document.hidden && !document.querySelector("dialog[open]")
    && !online?.detailsOpen && !countdown.active && (online ? online.session.canPlay : !!solo && !solo.paused && !solo.result);
}
const volumeOverlay = mountVolumeOverlay(document, window, {
  active: gameplayActive, sfx: sounds, music, feedback: () => soundPlayer.volumeFeedback(), changed: syncZenMusic,
});
const holdExit = mountHoldExit(window, document, {
  active: () => !atHome && !online && !activePlayback() && !!solo && !solo.paused && !solo.result
    && !document.hidden && !settingsDialog.open && !pauseDialog.open && !abandonDialog.open,
  exit: showHome,
});

function syncZenMusic() {
  if (!gameplayActive()) volumeOverlay.hide();
  void music.setPlaying(!atHome && !online && solo?.mode === "zen" && !solo.paused
    && !activePlayback() && !document.hidden && !settingsDialog.open && !pauseDialog.open && !abandonDialog.open);
}

function releaseSoloControls() {
  for (const action of new Set(pressed.values())) {
    const binding = ACTIONS[action];
    if ("up" in binding) solo?.apply(binding.up, performance.now());
    if (restartOnFinesseFault()) break;
  }
  pressed.clear();
}

function focusView() {
  const gameView = document.querySelector<HTMLElement>("#game-view")!;
  (atHome ? document.querySelector<HTMLElement>("#home-title")! : gameView.hidden ? document.querySelector<HTMLElement>("#view-title")! : gameView).focus({ preventScroll: true });
}

function pause() {
  holdExit.cancel();
  if (playback || online || !solo || solo.mode === "sprint" || solo.paused || solo.result) return;
  solo.setPaused(true, performance.now());
  syncZenMusic();
  refreshHud();
  if (solo.result) return;
  pressed.clear();
  pauseDialog.showModal();
}

async function resume() {
  const game = solo;
  const request = modeRequest;
  if (!online && !playback && game?.mode === "zen") {
    await music.prepare();
    if (solo !== game || request !== modeRequest || document.hidden || !document.hasFocus()) return;
  }
  cancelKeyCapture();
  settingsDialog.close();
  pauseDialog.close();
  if (!online && !playback) solo?.setPaused(false, performance.now());
  syncZenMusic();
  focusView();
}

let settingsFromMenu = false;
function openSettings(fromMenu: boolean) {
  holdExit.cancel();
  if (!online && solo?.mode === "sprint" && !solo.result) return;
  if (activePlayback()) { activePlayback()!.pause(); lastFrameAt = null; syncPlaybackControls(); }
  settingsFromMenu = fromMenu;
  if (fromMenu) pauseDialog.close();
  else if (online) {
    online.session.release();
    pressed.clear();
  } else {
    solo?.setPaused(true, performance.now());
    refreshHud();
    pressed.clear();
  }
  settingsDialog.showModal();
  syncZenMusic();
}

function closeSettings() {
  if (!settingsFromMenu) { resume(); return; }
  cancelKeyCapture();
  settingsDialog.close();
  pauseDialog.showModal();
}

async function launchMode(mode: SingleplayerMode, training = mode === "sprint" && sprintOption.checked) {
  holdExit.cancel();
  volumeOverlay.hide();
  const request = ++modeRequest;
  if (mode === "zen") {
    status.textContent = "Loading Zen…";
    status.hidden = false;
    await music.prepare();
    if (request !== modeRequest) return;
  } else music.release();
  countdown.cancel();
  countdownOverlay.hidden = true;
  resetOnFinesseFault = mode === "sprint" && training;
  soundOnFinesseFault = finesseSoundOptions[mode].checked;
  stopPlayback();
  const random = new Uint32Array(1);
  do { crypto.getRandomValues(random); } while (random[0] === seed);
  seed = random[0];
  const now = performance.now();
  if (mode === "sprint") {
    solo = startSprintRecording(seed, now, handling, resetOnFinesseFault);
  } else {
    abandonSprintRecording();
    solo = new Singleplayer(mode, seed, now, handling, Number(widthSelect.value));
  }
  display = solo.game;
  gameSounds.reset();
  soundedResult = null;
  soundedGame = solo.game;
  atHome = false;
  gameSounds.observe(display, solo.game);
  resultPanel.hidden = true;
  showView("solo");
  navSettingsButton.disabled = mode === "sprint";
  refreshHud();
  status.textContent = `${SINGLEPLAYER_MODES[mode].name} · ${solo.game.width} wide`;
  pressed.clear();
  if (mode === "zen" && (document.hidden || !document.hasFocus() || settingsDialog.open)) {
    solo.setPaused(true, performance.now());
    if (!settingsDialog.open) pauseDialog.showModal();
  }
  syncZenMusic();
  focusView();
}

function restart() {
  if (activePlayback()) return;
  if (online) { online.session.practice("practiceReset"); return; }
  if (solo) void launchMode(solo.mode, resetOnFinesseFault);
}

function restartOnFinesseFault(): boolean {
  if (!resetOnFinesseFault || !(solo instanceof SprintRecorder)
    || !countdown.restartOnFault(solo.game.finesse.faults, () => { void launchMode("sprint", true); }, () => performance.now())) return false;
  countdownOverlay.textContent = "3";
  countdownOverlay.hidden = false;
  return true;
}

async function abandonSolo(): Promise<boolean> {
  holdExit.cancel();
  if (!solo?.active) return true;
  const wasPaused = solo.paused;
  if (solo.mode === "zen") solo.setPaused(true, performance.now());
  else releaseSoloControls();
  syncZenMusic();
  pressed.clear();
  refreshHud();
  if (!solo.active) return true;
  document.querySelector("#abandon-description")!.textContent = `Your ${SINGLEPLAYER_MODES[solo.mode].name} progress will be lost.`;
  abandonDialog.returnValue = "cancel";
  const choice = new Promise<boolean>(resolve => {
    abandonDialog.addEventListener("close", () => resolve(abandonDialog.returnValue === "abandon"), { once: true });
  });
  abandonDialog.showModal();
  volumeOverlay.hide();
  if (!await choice) {
    if (!wasPaused && solo.mode === "zen") solo.setPaused(false, performance.now());
    syncZenMusic();
    if (!document.querySelector("dialog[open]")) {
      if (solo.result) document.querySelector<HTMLElement>("#sprint-result-title")!.focus({ preventScroll: true });
      else focusView();
    }
    return false;
  }
  return true;
}

function closeMenus() {
  cancelKeyCapture();
  settingsDialog.close();
  pauseDialog.close();
  pressed.clear();
}

async function enterHome() {
  if (!await abandonSolo()) return;
  showHome();
}

function showHome() {
  holdExit.cancel();
  volumeOverlay.hide();
  modeRequest++;
  music.release();
  countdown.cancel();
  countdownOverlay.hidden = true;
  stopPlayback();
  gameSounds.reset();
  soundPlayer.stop();
  abandonSprintRecording();
  closeMenus();
  online?.closeDetails();
  online?.session.release();
  solo = null;
  pendingMode = null;
  display = null;
  resultPanel.hidden = true;
  atHome = true;
  showView("home");
  navSettingsButton.disabled = false;
  status.textContent = "";
  focusView();
}

async function chooseMode(mode: SingleplayerMode) {
  if (online) {
    const room = online.session.room;
    if (room && !["playing", "paused", "countdown", "preparing", "roundResult"].includes(room.phase)
      && !confirm(`Leave your online room and start ${SINGLEPLAYER_MODES[mode].name}?`)) return;
    pendingMode = mode;
    online.local();
    return;
  }
  if (!await abandonSolo()) return;
  closeMenus();
  void launchMode(mode);
}

async function enterOnline() {
  if (!await abandonSolo()) return;
  volumeOverlay.hide();
  modeRequest++;
  music.release();
  countdown.cancel();
  countdownOverlay.hidden = true;
  stopPlayback();
  gameSounds.reset();
  soundPlayer.stop();
  abandonSprintRecording();
  closeMenus();
  sprintClock.hidden = true;
  solo = null;
  atHome = false;
  resultPanel.hidden = true;
  display = null;
  showView(online ? onlineView(online.session.room, online.session.connected) : "lobby");
  navSettingsButton.disabled = false;
  if (online) {
    online.closeDetails();
    online.session.release();
    focusView();
    return;
  }
  const root = document.querySelector<HTMLElement>("#online")!;
  online = mountOnline(root, {
    clearKeys: () => { pressed.clear(); volumeOverlay.hide(); }, handling: () => handling, skins, invite, diagnostics: netDiagnostics, inputLeadMs,
    skin: () => shareableSkinId(skins.preferences.active), skinMode: () => multiplayerSkins.mode,
    replay: watchCompetitiveReplay,
    view: view => {
      if (view !== "playing") volumeOverlay.hide();
      if (!atHome && !competitivePlayback) showView(view);
    },
    local() {
      online?.destroy();
      online = undefined;
      closeMenus();
      const mode = pendingMode;
      pendingMode = null;
      if (mode) void launchMode(mode);
      else enterHome();
    },
  });
  invite = null;
}

document.querySelector("#online-button")!.addEventListener("click", enterOnline);
for (const id of ["#home-button", "#solo-button", "#result-home-button", "#pause-home-button"]) document.querySelector(id)!.addEventListener("click", enterHome);
for (const button of document.querySelectorAll<HTMLButtonElement>("[data-mode]")) {
  button.addEventListener("click", () => chooseMode(button.dataset.mode as SingleplayerMode));
}
document.querySelector("#retry-button")!.addEventListener("click", restart);
document.querySelector("#watch-replay-button")!.addEventListener("click", () => { void watchSprintReplay(); });
const replayControls = mountReplayControls(document, {
  playback: activePlayback, resetClock: () => { lastFrameAt = null; }, exit: backToResults,
});
document.querySelector("#pause-restart-button")!.addEventListener("click", () => { closeMenus(); restart(); });
document.querySelector("#resume-button")!.addEventListener("click", resume);
document.querySelector("#settings-button")!.addEventListener("click", () => openSettings(true));
document.querySelector("#nav-settings-button")!.addEventListener("click", () => openSettings(false));
document.querySelector("#settings-back")!.addEventListener("click", closeSettings);
dismissSettingsOnBackdrop(settingsDialog, closeSettings);
holdButton.addEventListener("click", () => {
  applyInput(Input.Hold);
  holdButton.blur();
});
for (const dialog of [pauseDialog, settingsDialog]) {
  dialog.addEventListener("cancel", e => e.preventDefault());
}
function handleFocusLoss() {
  volumeOverlay.hide();
  void music.setPlaying(false);
  soundPlayer.stop();
  if (activePlayback()) {
    activePlayback()!.pause();
    lastFrameAt = null;
    pressed.clear();
    syncPlaybackControls();
    return;
  }
  if (online) {
    online.session.release();
    pressed.clear();
  } else {
    if (solo?.mode === "sprint") releaseSoloControls();
    else pause();
  }
}

window.addEventListener("blur", handleFocusLoss);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) handleFocusLoss();
});

function syncPlaybackControls(): void { replayControls.sync(); }

function stopPlayback(): void {
  online?.cancelReplay();
  if (!activePlayback()) return;
  competitivePlayback?.dispose();
  competitivePlayback = null;
  matchReplayHost.hidden = true;
  replaySeek.hidden = true;
  playback?.dispose();
  playback = null;
  replayBar.hidden = true;
  display = solo?.game ?? null;
  lastFrameAt = null;
  pressed.clear();
}

function backToResults(): void {
  if (competitivePlayback) {
    stopPlayback();
    if (online && !atHome) {
      showView(onlineView(online.session.room, online.session.connected));
      online.update();
      document.querySelector<HTMLElement>("#view-title")!.focus({ preventScroll: true });
    }
    return;
  }
  if (!playback) return;
  stopPlayback();
  showView("solo");
  resultPanel.hidden = !solo?.result;
  status.textContent = solo ? `${SINGLEPLAYER_MODES[solo.mode].name} · ${solo.game.width} wide` : "";
  refreshHud();
  if (solo?.result) document.querySelector<HTMLElement>("#sprint-result-title")!.focus({ preventScroll: true });
}

function watchCompetitiveReplay(replay: Awaited<ReturnType<typeof requestCompetitiveReplay>>): void {
  stopPlayback();
  const audiblePlayback = withMatchReplaySounds(replay.playback, online?.session.playerId ?? replay.playback.state.roster[0], replaySoundOutput);
  competitivePlayback = mountCompetitivePlayback(matchReplayHost, audiblePlayback, replay.summary, replay.appearance, skins.load);
  showView("matchReplay");
  status.textContent = `${replay.playback.state.roster.length} players`;
  status.hidden = false;
  matchReplayHost.hidden = false;
  replayBar.hidden = false;
  pressed.clear();
  lastFrameAt = null;
  syncPlaybackControls();
  replayToggle.focus({ preventScroll: true });
}

async function watchSprintReplay(): Promise<void> {
  const recorder = solo;
  if (playback || openingPlayback || !(recorder instanceof SprintRecorder) || !recorder.result) return;
  const recording = sprintRecordingFor(recorder);
  if (!recording) return;
  openingPlayback = true;
  watchReplayButton.disabled = true;
  let next: SprintPlayback;
  try {
    next = await SprintPlayback.create(recording.replay);
  } catch (error) {
    console.warn("Sprint replay playback failed:", error);
    openingPlayback = false;
    refreshHud();
    return;
  }
  openingPlayback = false;
  if (solo !== recorder || online || atHome) {
    next.dispose();
    return;
  }
  playback = withSprintReplaySounds(next, replaySoundOutput);
  showView("sprintReplay");
  resultPanel.hidden = true;
  replayBar.hidden = false;
  pressed.clear();
  lastFrameAt = null;
  status.textContent = `40 lines · ${next.outcome === "complete" ? "completed attempt" : "topped out attempt"}`;
  display = snapshotDisplay(playback.state);
  refreshHud();
  syncPlaybackControls();
  replayToggle.focus({ preventScroll: true });
}

function refreshHud() {
  if (!display) return;
  const sprint = playback !== null || (!online && solo?.mode === "sprint");
  setHidden(sprintClock, !sprint);
  setText(elapsedTime, formatTime(playback ? playback.elapsedMs : solo?.elapsedMs ?? 0));
  const { lines, combo, chainLength, b2b, surge } = display.stats;
  setText(lineCount, sprint ? `${lines} / 40` : String(lines));
  setText(comboCount, String(Math.max(0, combo)));
  setText(b2bCount, chainLength === 0 ? "—" : b2b === 0 ? "Ready" : String(b2b));
  setAttributeIfChanged(b2bCount, "title", chainLength === 0
    ? "Clear a Quad, spin or all clear to start B2B."
    : b2b === 0 ? "Chain started. The next qualifying clear earns the B2B bonus." : `${b2b} back-to-back clears.`);
  setText(surgeCount, String(surge));
  setText(finesseCount, finesseSummary(display.finesse));
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
  setText(clearResult, labels.join(" · "));
  setHidden(zenStatus, playback !== null || (!display.zen && (!sprint || !!solo?.started)));
  setText(zenStatus, online ? "Online practice · Ctrl+Z to undo; restart resets your board."
    : sprint ? "Sprint 40L · Make your first move to start the clock."
    : `Zen · Ctrl+Z to undo (${solo?.undoCount ?? 0} available)`);
  if (solo?.result && !online && !playback && resultPanel.hidden) {
    holdExit.cancel();
    volumeOverlay.hide();
    const result = solo.result;
    setText(document.querySelector("#sprint-result-title")!, result.outcome === "complete" ? "Sprint complete" : "Topped out");
    setDisabled(navSettingsButton, false);
    setText(document.querySelector("#result-time")!, formatTime(result.elapsedMs));
    setText(document.querySelector("#result-lines")!, `${result.stats.lines} / 40 lines cleared${result.outcome === "failed" ? " · Attempt failed" : ""}`);
    setText(document.querySelector("#result-pieces")!, `${result.stats.pieces} pieces placed`);
    setText(document.querySelector("#result-finesse")!, `Finesse ${finesseSummary(result.finesse)}`);
    setHidden(resultPanel, false);
    pressed.clear();
    if (!document.querySelector("dialog[open]")) document.querySelector<HTMLElement>("#sprint-result-title")!.focus({ preventScroll: true });
  }
  if (!online && solo instanceof SprintRecorder && solo.result) {
    const recording = sprintRecordingFor(solo);
    const failed = !recording && solo.status === "failed";
    setDisabled(watchReplayButton, !recording || openingPlayback);
    const label = openingPlayback ? "Opening replay…"
      : recording ? "Watch replay" : failed ? "Replay unavailable" : "Preparing replay…";
    setText(watchReplayButton, label);
    setAttributeIfChanged(watchReplayButton, "title", recording ? "Watch this attempt from the beginning"
      : failed ? solo.error?.message ?? "This attempt could not be recorded."
      : "Verifying the recording…");
  }
}

function applyInput(input: InputId) {
  if (activePlayback() || countdown.active) return;
  if (online) {
    online.session.input(input);
    const state = online.session.prediction?.gameState();
    if (state) gameSounds.observe(snapshotDisplay(state), onlineSoundIdentity(), input);
    return;
  }
  solo?.apply(input, performance.now());
  observeSoloSounds(input);
  if (restartOnFinesseFault()) return;
  if (solo && display !== solo.game) pressed.clear();
  display = solo?.game ?? null;
  refreshHud();
}

function onlineSoundIdentity() {
  const session = online!.session;
  const prediction = session.prediction!;
  return `${session.room?.code}:${session.room?.matchId}:${prediction.round}:${prediction.epoch}`;
}

function observeSoloSounds(input?: InputId) {
  if (!solo) return;
  if (soundedGame && soundedGame !== solo.game && soundedGame.topOut) gameSounds.observe(soundedGame, soundedGame, input);
  gameSounds.observe(solo.game, solo.game, input);
  soundedGame = solo.game;
  if (solo.result && solo.result !== soundedResult) {
    soundedResult = solo.result;
    if (solo.result.outcome === "complete") gameSounds.event("success");
  }
}

const cell = 30;

function drawPreview(context: CanvasRenderingContext2D, piece: PieceId, slot: number) {
  drawPiecePreview(context, piece, cell, context.canvas.width, cell * 3, slot * cell * 3, skins.loaded);
}

function render() {
  if (atHome || competitivePlayback) return;
  if (online && renderOnlineWaiting(document, online.session)) return;
  if (!display) return;
  const width = display.board.length / ROWS;
  const style = document.querySelector<HTMLElement>("#game-view")!.style;
  const ratio = String(width / 10);
  if (style.getPropertyValue("--board-ratio") !== ratio) style.setProperty("--board-ratio", ratio);
  setAttributeIfChanged(canvas, "aria-label", "42tris playfield");
  holdCtx.clearRect(0, 0, holdCanvas.width, holdCanvas.height);
  setDisabled(holdButton, countdown.active || playback !== null || display.holdUsed || display.paused || display.topOut || display.starting || !!solo?.result || (!!online && !online.session.canPlay));
  setAttributeIfChanged(holdCanvas, "aria-label", display.held === null ? "Hold empty" : `Held piece ${LETTERS[display.held]}`);
  if (display.held !== null) drawPreview(holdCtx, display.held, 0);

  nextCtx.clearRect(0, 0, nextCanvas.width, nextCanvas.height);
  let nextLabel = "Next pieces:";
  for (let i = 0; i < display.previews.length; i++) {
    drawPreview(nextCtx, display.previews[i] as PieceId, i);
    nextLabel += ` ${LETTERS[display.previews[i]]}`;
  }
  setAttributeIfChanged(nextCanvas, "aria-label", nextLabel);
  drawBoard(ctx, display, skins.loaded, showGhost);
}

function toggleMenu() {
  if (activePlayback()) { backToResults(); return; }
  if (abandonDialog.open) abandonDialog.close("cancel");
  else if (online?.detailsOpen) online.closeDetails();
  else if (settingsDialog.open) closeSettings();
  else if (pauseDialog.open || (!online && solo?.paused)) resume();
}

const unmountInput = mountGameplayInput(window, {
  bindings, pressed,
  editable: target => target instanceof HTMLElement && !!target.closest("input, textarea, select, button, summary, a, [contenteditable=true], [role=slider]"),
  blocked: () => countdown.active || abandonDialog.open || pauseDialog.open || settingsDialog.open || !!online?.detailsOpen || atHome || activePlayback() !== null || (online ? !online.session.canPlay : !solo || solo.paused || !!solo.result),
  settingsOpen: () => settingsDialog.open,
  starting: () => display?.starting ?? true,
  menu: toggleMenu,
  undo() {
    if (activePlayback()) return;
    if (online) online.session.practice("practiceUndo");
    else if (solo?.undo(performance.now())) { pressed.clear(); display = solo.game; gameSounds.reset(); refreshHud(); }
  },
  restart, input: applyInput, lateRelease: () => online?.session.release(),
});

function frame(now: number) {
  online?.session.diagnostics?.frame(now);
  replayControls.flushSeek();
  const delta = lastFrameAt === null ? 0 : Math.min(Math.max(0, now - lastFrameAt), 100);
  lastFrameAt = now;
  guestName.update();
  if (competitivePlayback) {
    online?.session.tick();
    competitivePlayback.advance(delta);
    syncPlaybackControls();
  } else if (playback) {
    playback.advance(delta);
    display = snapshotDisplay(playback.state);
    refreshHud();
    syncPlaybackControls();
  } else if (online) {
    online.update();
    const session = online?.session;
    const state = session?.prediction?.gameState();
    if (state) { display = snapshotDisplay(state); gameSounds.observe(display, onlineSoundIdentity()); refreshHud(); }
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
      setHidden(status, session.room?.phase === "waiting");
    }
  } else if (solo) {
    setHidden(status, false);
    const label = countdown.label(now);
    setHidden(countdownOverlay, label === null);
    if (label !== null) setText(countdownOverlay, label);
    else {
      solo.tick(performance.now());
      observeSoloSounds();
      restartOnFinesseFault();
    }
    if (display !== solo.game) pressed.clear();
    display = solo.game;
    refreshHud();
  }
  render();
  frameId = requestAnimationFrame(frame);
}

let frameId = requestAnimationFrame(frame);
window.addEventListener("pagehide", e => { holdExit.cancel(); modeRequest++; music.release(); soundPlayer.stop(); cancelAnimationFrame(frameId); handleFocusLoss(); online?.session.stop(); if (!e.persisted) { holdExit.dispose(); volumeOverlay.dispose(); unmountInput(); replayControls.dispose(); stopPlayback(); } });
window.addEventListener("pageshow", e => { if (e.persisted) { online?.session.start(); frameId = requestAnimationFrame(frame); } });
if (!atHome) enterOnline();
