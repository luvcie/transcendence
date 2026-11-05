import { BUILTIN_SOUNDS, JSTRIS_SOUND_PRESETS, SOUND_DATABASE, TETRIO_SOUND_DATABASE, type SoundDef } from "./sound-catalog";
import { comboClip, type SoundClip } from "./sound-pack";
import { SoundPlayer } from "./sound-player";
import { customSound, resolveSound, SoundState } from "./sound-state";
import { createSettingsGroup, setupSettingsSearch } from "./settings-search";
import { levelToVolume, volumeToLevel } from "./audio-volume";

export function setupSounds(state: SoundState, player: SoundPlayer) {
  const panel = document.querySelector<HTMLElement>("#settings-sounds")!;
  const list = document.querySelector<HTMLElement>("#sound-list")!;
  const filter = setupSettingsSearch(document.querySelector<HTMLInputElement>("#sound-search")!, list,
    document.querySelector<HTMLElement>("#sound-empty")!);
  const note = document.querySelector<HTMLElement>("#sound-note")!;
  const form = document.querySelector<HTMLFormElement>("#sound-form")!;
  const input = document.querySelector<HTMLTextAreaElement>("#custom-sound")!;
  const add = form.querySelector<HTMLButtonElement>("button")!;
  const enabled = document.querySelector<HTMLInputElement>("#sounds-enabled")!;
  const volume = document.querySelector<HTMLInputElement>("#sound-volume")!;
  const output = document.querySelector<HTMLOutputElement>("#sound-volume-value")!;
  let generation = 0;
  function refresh() {
    document.querySelector("#sound-selected")!.textContent = `Selected: ${resolveSound(state.preferences).label}`;
    enabled.checked = state.preferences.enabled;
    volume.value = String(Math.round(volumeToLevel(state.preferences.volume) * 100));
    output.value = `${Math.round(state.preferences.volume * 100)}%`;
    volume.setAttribute("aria-valuetext", output.value);
    player.setVolume(state.preferences.enabled ? state.preferences.volume : 0);
    if (!panel.hidden) for (const button of list.querySelectorAll<HTMLButtonElement>("button[data-sound]")) {
      const selected = button.dataset.sound === state.preferences.active;
      button.setAttribute("aria-pressed", String(selected));
      button.textContent = selected ? "Selected (retry)" : "Use";
    }
    note.textContent = state.message;
  }
  state.changed = refresh;
  enabled.addEventListener("change", () => {
    player.stop();
    state.configure({ enabled: enabled.checked });
    if (enabled.checked) void player.unlock().catch((error: Error) => { note.textContent = error.message; });
  });
  volume.addEventListener("input", () => state.configure({ volume: levelToVolume(volume.valueAsNumber / 100) }));
  function link(url: string, text: string) {
    const anchor = document.createElement("a");
    anchor.href = url; anchor.textContent = text; anchor.target = "_blank"; anchor.rel = "noreferrer";
    return anchor;
  }
  document.querySelector("#sound-credit")!.append("Sound effect assets from the community Jstris customization database ",
    link(JSTRIS_SOUND_PRESETS, "[1]"), " ", link(SOUND_DATABASE, "[2]"), " and the TETR.IO+ database ", link(TETRIO_SOUND_DATABASE, "[3]"),
    ".", document.createElement("br"),
    "42tris ships no sound effect assets other than its own originals, community sounds are loaded from external links.");
  function option(def: SoundDef, index?: number) {
    const item = document.createElement("article"); item.className = "sound-option";
    item.dataset.search = [def.id, def.label, def.credit, def.source].join(" ");
    const head = document.createElement("div"); head.className = "sound-head";
    const title = document.createElement("h3"); title.textContent = def.label;
    const use = document.createElement("button");
    use.type = "button"; use.dataset.sound = def.id; use.setAttribute("aria-label", `Use ${def.label}`);
    use.addEventListener("click", () => {
      player.stop();
      if (!state.preferences.enabled) state.configure({ enabled: true });
      void player.unlock().catch((error: Error) => { note.textContent = error.message; });
      void state.select(def.id);
    });
    head.append(title, use);
    if (index !== undefined) {
      const remove = document.createElement("button");
      remove.type = "button"; remove.textContent = "Remove"; remove.setAttribute("aria-label", `Remove ${def.label}`);
      remove.addEventListener("click", () => { player.stop(); void state.remove(index); render(); input.focus(); });
      head.append(remove);
    }
    item.append(head);
    if (def.id !== "silent") {
      const row = document.createElement("div"); row.className = "sound-preview";
      row.setAttribute("role", "group"); row.setAttribute("aria-label", `Preview ${def.label}`);
      const pack = def.pack;
      const samples: [string, SoundClip | undefined][] = [
        ["Move", pack.move ? { url: pack.move } : undefined],
        ["Rotate", pack.rotate ? { url: pack.rotate } : undefined],
        ["Drop", pack.harddrop || pack.lock ? { url: pack.harddrop ?? pack.lock! } : undefined],
        ["Quad", pack.scoring?.CLEAR4 ? { url: pack.scoring.CLEAR4 } : undefined],
        ["T-spin", pack.scoring?.TSPIN_DOUBLE ? { url: pack.scoring.TSPIN_DOUBLE } : undefined],
        ["Combo", comboClip(pack, 1)],
      ];
      const status = document.createElement("p"); status.className = "hint"; status.setAttribute("role", "status");
      for (const [label, clip] of samples) {
        const button = document.createElement("button"); button.type = "button"; button.textContent = label;
        button.disabled = !clip; button.setAttribute("aria-label", `Preview ${def.label}: ${label}`);
        if (!clip) button.title = "This pack has no sound for this event.";
        button.addEventListener("click", () => {
          if (!state.preferences.enabled || !state.preferences.volume) { status.textContent = "Enable sound effects and turn up the volume to preview."; return; }
          const current = generation;
          status.textContent = `Loading ${label.toLowerCase()}…`;
          void player.preview([clip!]).then(() => {
            if (current === generation) status.textContent = "";
          }).catch((error: Error) => {
            if (current === generation) status.textContent = error.name === "AbortError" ? "" : "Preview unavailable. Check the audio link or try another pack.";
          });
        });
        row.append(button);
      }
      item.append(row, status);
      const source = document.createElement("p"); source.className = "hint";
      if (def.credit) source.append(`${def.credit}. `);
      if (def.source) source.append(link(def.source, "Source"), " · ");
      const edit = document.createElement("button"); edit.type = "button"; edit.className = "sound-template"; edit.textContent = "Use JSON as template";
      edit.setAttribute("aria-label", `Use ${def.label} JSON as template`);
      edit.addEventListener("click", () => { input.value = JSON.stringify(pack, null, 2); input.focus(); });
      source.append(edit); item.append(source);
    } else {
      const status = document.createElement("p"); status.className = "hint"; status.textContent = "No sound effects."; item.append(status);
    }
    return item;
  }
  function render() {
    generation++; list.replaceChildren();
    const groups: [string, readonly SoundDef[]][] = [
      ["42tris", BUILTIN_SOUNDS.filter(def => !def.source)],
      ["Jstris+ presets", BUILTIN_SOUNDS.filter(def => def.source === JSTRIS_SOUND_PRESETS)],
      ["Eddiez-Soundz", BUILTIN_SOUNDS.filter(def => def.source === SOUND_DATABASE)],
      ["TETR.IO+ database", BUILTIN_SOUNDS.filter(def => def.source?.startsWith(TETRIO_SOUND_DATABASE))],
      ["Custom sounds", state.preferences.customs.map(customSound)],
    ];
    for (const [label, defs] of groups) {
      if (!defs.length) continue;
      const options = createSettingsGroup(list, label, defs.some(def => def.id === state.preferences.active));
      defs.forEach((def, index) => options.append(option(def, def.id.startsWith("custom:") ? index : undefined)));
    }
    filter();
    refresh();
  }
  form.addEventListener("submit", event => {
    event.preventDefault();
    if (add.disabled) return;
    add.disabled = true;
    note.textContent = "Checking sound pack…";
    player.stop();
    void player.unlock().catch((error: Error) => { note.textContent = error.message; });
    void state.add(input.value).then(added => {
      add.disabled = false;
      if (added) { input.value = ""; if (!panel.hidden) render(); }
      refresh();
    });
  });
  refresh();
  return (open: boolean) => {
    panel.hidden = !open;
    if (open) render();
    else { generation++; player.stop(); state.cancelPendingAdd(); }
  };
}
