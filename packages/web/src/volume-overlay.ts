import { VolumeSteps, volumeToLevel } from "./audio-volume";
import type { SoundState } from "./sound-state";
import type { ZenMusic } from "./zen-music";

export function mountVolumeOverlay(root: Document, target: Window, options: {
  active(): boolean;
  sfx: SoundState;
  music: ZenMusic;
  feedback(): void;
  changed(): void;
}) {
  const overlay = root.querySelector<HTMLElement>("#volume-overlay")!;
  const channels = [
    { name: "sfx", state: options.sfx, element: root.querySelector<HTMLElement>("#volume-overlay-sfx")! },
    { name: "music", state: options.music, element: root.querySelector<HTMLElement>("#volume-overlay-music")! },
  ];
  const steps = new VolumeSteps();
  const pending = new Set<SoundState | ZenMusic>();
  let fadeTimer = 0, hideTimer = 0, saveTimer = 0;
  function save() {
    target.clearTimeout(saveTimer);
    for (const state of pending) state.configure({ volume: state.preferences.volume });
    pending.clear();
  }
  function hide() {
    target.clearTimeout(fadeTimer);
    target.clearTimeout(hideTimer);
    overlay.hidden = true;
    save();
  }
  function fade() {
    target.clearTimeout(fadeTimer);
    target.clearTimeout(hideTimer);
    fadeTimer = target.setTimeout(() => overlay.classList.add("fading"), 1200);
    hideTimer = target.setTimeout(hide, 5200);
  }
  function adjust(direction: number, selected?: string, exact?: number) {
    if (!options.active()) { hide(); return; }
    const now = target.performance.now();
    for (const { name, state, element } of channels) {
      if (!selected || selected === name) {
        const volume = exact ?? steps.step(state.preferences.volume, direction, now);
        if (volume !== state.preferences.volume) {
          state.configure({ volume }, false);
          pending.add(state);
        }
      }
      const volume = state.preferences.volume;
      const fill = volumeToLevel(volume) / 1.5 * 100;
      const white = Math.min(100 * 2 / 3, fill);
      element.querySelector<HTMLElement>(".volume-bar")!.style.backgroundImage =
        `linear-gradient(to top, #fff 0%, #fff ${white}%, #ff0345 ${white}%, #ff0345 ${fill}%, #fff2 ${fill}%, #fff2 100%)`;
      element.setAttribute("aria-valuenow", String(Math.round(volume * 100)));
      element.setAttribute("aria-valuetext", `${Math.round(volume * 100)}%${state.preferences.enabled ? "" : " (disabled)"}`);
    }
    options.changed();
    if (!selected || selected === "sfx") options.feedback();
    target.clearTimeout(saveTimer);
    saveTimer = target.setTimeout(save, 150);
    overlay.hidden = false;
    overlay.classList.remove("fading");
    target.clearTimeout(fadeTimer);
    target.clearTimeout(hideTimer);
    if (!overlay.contains(root.activeElement)) fade();
  }
  function wheel(event: WheelEvent) {
    if (!options.active() || event.ctrlKey || event.metaKey || !Number.isFinite(event.deltaY) || !event.deltaY) return;
    const element = event.target as Element | null;
    if (!element?.closest || element.closest("input, textarea, select, [contenteditable=true], details[open]")) return;
    event.preventDefault();
    adjust(Math.sign(-event.deltaY), element.closest<HTMLElement>("[data-volume-channel]")?.dataset.volumeChannel);
  }
  const keyHandlers = channels.map(({ name, element }) => {
    const handler = (event: KeyboardEvent) => {
      if (!["ArrowUp", "ArrowRight", "ArrowDown", "ArrowLeft", "Home", "End"].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      adjust(event.key === "ArrowUp" || event.key === "ArrowRight" ? 1 : -1, name,
        event.key === "Home" ? 0 : event.key === "End" ? 2 : undefined);
    };
    element.addEventListener("keydown", handler);
    return () => element.removeEventListener("keydown", handler);
  });
  const focus = () => {
    target.clearTimeout(fadeTimer); target.clearTimeout(hideTimer);
    overlay.classList.remove("fading");
  };
  const blur = (event: FocusEvent) => { if (!overlay.contains(event.relatedTarget as Node | null)) fade(); };
  overlay.addEventListener("focusin", focus);
  overlay.addEventListener("focusout", blur);
  target.addEventListener("wheel", wheel, { passive: false });
  return { hide, dispose() {
    hide();
    target.removeEventListener("wheel", wheel);
    overlay.removeEventListener("focusin", focus);
    overlay.removeEventListener("focusout", blur);
    keyHandlers.forEach(remove => remove());
  } };
}
