import { formatTime } from "./singleplayer";

export interface ReplayControlsPlayback {
  playing: boolean;
  complete: boolean;
  speed: number;
  positionMs: number;
  durationMs: number;
  toggle(): void;
  restart(): void;
  setSpeed(speed: number): void;
  positionFrames?: number;
  durationFrames?: number;
  /** Match uses cumulative frames; Sprint uses recorded-timeline milliseconds. */
  seek(position: number): void;
}

/** One control bar and seek interaction for Sprint and competitive playback. */
export function mountReplayControls(document: Document, options: {
  playback(): ReplayControlsPlayback | null;
  resetClock(): void;
  exit(): void;
}) {
  const node = <T extends HTMLElement>(id: string) => document.querySelector<T>(`#replay-${id}`)!;
  const toggle = node<HTMLButtonElement>("toggle");
  const restart = node<HTMLButtonElement>("restart");
  const exit = node<HTMLButtonElement>("exit");
  const speed = node<HTMLSelectElement>("speed");
  const seek = node<HTMLInputElement>("seek");
  const time = node<HTMLElement>("time");
  const state = node<HTMLElement>("state");
  let pendingSeek: { playback: ReplayControlsPlayback; position: number } | undefined;
  function flushSeek() {
    const pending = pendingSeek;
    pendingSeek = undefined;
    if (!pending || pending.playback !== options.playback()) return;
    pending.playback.seek(pending.position);
    options.resetClock();
    sync();
  }
  function sync() {
    const playback = options.playback();
    seek.hidden = !playback;
    if (!playback) return;
    toggle.textContent = playback.complete ? "Replay" : playback.playing ? "Pause" : "Play";
    speed.value = String(playback.speed);
    time.textContent = `${formatTime(playback.positionMs)} / ${formatTime(playback.durationMs)}`;
    const label = playback.complete ? "Finished"
      : `${playback.playing ? "Playing" : "Paused"} · ${playback.speed}×`;
    if (state.textContent !== label) state.textContent = label;
    seek.max = String(playback.durationFrames ?? playback.durationMs);
    seek.step = playback.durationFrames === undefined ? "any" : "1";
    if (pendingSeek?.playback !== playback) seek.value = String(playback.positionFrames ?? playback.positionMs);
    seek.setAttribute("aria-valuetext", time.textContent);
  }
  const onToggle = () => {
    const playback = options.playback();
    if (!playback) return;
    flushSeek();
    if (playback.complete) playback.restart(); else playback.toggle();
    options.resetClock(); toggle.blur(); sync();
  };
  const onRestart = () => {
    pendingSeek = undefined;
    options.playback()?.restart(); options.resetClock(); sync(); toggle.focus({ preventScroll: true });
  };
  const onSpeed = () => {
    const value = Number(speed.value);
    flushSeek(); options.playback()?.setSpeed(value); options.resetClock(); sync();
  };
  const onSeek = () => {
    const playback = options.playback();
    if (playback) pendingSeek = { playback, position: Number(seek.value) };
  };
  const onExit = () => { pendingSeek = undefined; options.exit(); };
  toggle.addEventListener("click", onToggle);
  restart.addEventListener("click", onRestart);
  exit.addEventListener("click", onExit);
  speed.addEventListener("change", onSpeed);
  seek.addEventListener("input", onSeek);
  seek.addEventListener("change", flushSeek);
  return { sync, flushSeek, dispose() {
    pendingSeek = undefined;
    toggle.removeEventListener("click", onToggle);
    restart.removeEventListener("click", onRestart);
    exit.removeEventListener("click", onExit);
    speed.removeEventListener("change", onSpeed);
    seek.removeEventListener("input", onSeek);
    seek.removeEventListener("change", flushSeek);
  } };
}
