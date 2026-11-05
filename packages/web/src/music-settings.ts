import type { ZenMusic } from "./zen-music";

export function setupMusic(music: ZenMusic, sync: () => void) {
  const enabled = document.querySelector<HTMLInputElement>("#music-enabled")!;
  const volume = document.querySelector<HTMLInputElement>("#music-volume")!;
  const output = document.querySelector<HTMLOutputElement>("#music-volume-value")!;
  const note = document.querySelector<HTMLElement>("#music-note")!;
  function refresh() {
    enabled.checked = music.preferences.enabled;
    volume.value = String(Math.round(music.preferences.volume * 100));
    output.value = `${volume.value}%`;
    volume.setAttribute("aria-valuetext", output.value);
    note.textContent = music.message;
  }
  music.changed = refresh;
  enabled.addEventListener("change", () => { music.configure({ enabled: enabled.checked }); sync(); });
  volume.addEventListener("input", () => { music.configure({ volume: volume.valueAsNumber / 100 }); sync(); });
  refresh();
}
