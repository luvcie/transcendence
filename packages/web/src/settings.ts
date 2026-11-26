import { DEFAULT_HANDLING, FRAME_MS, HANDLING_MAX, validateHandling, type Handling } from "@42tris/core";
import { setupSettingsSearch } from "./settings-search";
import { loadSurgeIcon, SURGE_ICON_HEIGHT, SURGE_ICON_WIDTH } from "./surge-icon";
import { pngSize } from "./tetrio-skins";
import { updatePreferences, withPreferenceLock } from "./preference-storage";

const storageKey = "42tris.handling";

function loadDisplaySetting(key: string, note: HTMLElement) {
  try {
    return localStorage.getItem(key);
  } catch {
    note.textContent = "Saved display settings could not be loaded. Using defaults.";
  }
}

function saveDisplaySetting(key: string, value: string, note: HTMLElement) {
  try {
    localStorage.setItem(key, value);
    note.textContent = "Display settings saved on this device.";
  } catch {
    note.textContent = "Display settings apply for this session; browser storage is unavailable.";
  }
}

export function setupDisplayToggle(id: string, key: string, onChange: (enabled: boolean) => void): boolean {
  const toggle = document.querySelector<HTMLInputElement>(id)!;
  const note = document.querySelector<HTMLParagraphElement>("#display-note")!;
  const saved = loadDisplaySetting(key, note);
  if (saved !== undefined) toggle.checked = toggle.defaultChecked ? saved !== "false" : saved === "true";
  toggle.addEventListener("change", () => {
    onChange(toggle.checked);
    saveDisplaySetting(key, String(toggle.checked), note);
  });
  return toggle.checked;
}

export async function setupSurgeIcon(load = loadSurgeIcon, makeImage = () => new Image()): Promise<void> {
  const key = "42tris.surgeIcon";
  const rotationKey = "42tris.rotateSurgeIcon";
  const panel = document.querySelector<HTMLElement>("#settings-skins")!;
  const download = panel.querySelector<HTMLButtonElement>("#download-surge-icon")!;
  const remove = panel.querySelector<HTMLButtonElement>("#remove-surge-icon")!;
  const rotate = panel.querySelector<HTMLInputElement>("#rotate-surge-icon")!;
  const icons = () => document.querySelectorAll<HTMLElement>(".surge-icon");
  const note = panel.querySelector<HTMLElement>("#surge-icon-note")!;

  function save(preference: string, value: string | null) {
    try {
      if (value === null) localStorage.removeItem(preference);
      else localStorage.setItem(preference, value);
    } catch {
      const message = "This change applies for this session only.";
      if (!note.textContent?.endsWith(message)) note.textContent = [note.textContent, message].filter(Boolean).join(" ");
    }
  }

  function apply(mask: string) {
    for (const icon of icons()) {
      icon.setAttribute("style", `--surge-mask: url("${mask}")`);
      icon.hidden = false;
    }
    download.hidden = true;
    remove.hidden = false;
    note.textContent = "Cyclone Surge Icon is in use.";
  }

  async function enable() {
    if (download.disabled) return;
    download.disabled = remove.disabled = true;
    note.textContent = "Downloading Cyclone Surge Icon…";
    try {
      const mask = await load();
      apply(mask);
      await withPreferenceLock(key, () => save(key, mask));
    } catch {
      note.textContent = "Cyclone Surge Icon could not load. Try again.";
    } finally {
      download.disabled = remove.disabled = false;
    }
  }

  download.addEventListener("click", () => { void enable(); });
  remove.addEventListener("click", () => {
    for (const icon of icons()) {
      icon.hidden = true;
      icon.removeAttribute("style");
    }
    download.hidden = false;
    remove.hidden = true;
    note.textContent = "Cyclone Surge Icon removed.";
    void withPreferenceLock(key, () => save(key, null));
    download.focus();
  });
  rotate.addEventListener("change", () => {
    setRotation();
    save(rotationKey, String(rotate.checked));
  });
  function setRotation() {
    for (const icon of icons()) icon.dataset.rotate = String(rotate.checked);
  }
  try {
    rotate.checked = localStorage.getItem(rotationKey) !== "false";
    const mask = localStorage.getItem(key);
    if (mask !== null) {
      download.disabled = true;
      try {
        const [width, height] = pngSize(mask);
        if (width !== SURGE_ICON_WIDTH || height !== SURGE_ICON_HEIGHT) throw new Error("Unexpected Surge icon dimensions.");
        const image = makeImage();
        image.src = mask;
        await image.decode();
        if (image.naturalWidth !== width || image.naturalHeight !== height) throw new Error("Unexpected Surge icon dimensions.");
        apply(mask);
      } catch {
        await withPreferenceLock(key, () => {
          if (localStorage.getItem(key) === mask) localStorage.removeItem(key);
        });
      } finally {
        download.disabled = false;
      }
    }
  } catch {
    note.textContent = "The saved Surge icon setting could not be loaded.";
  }
  setRotation();
}

export function setupTouchDisplaySettings(coarsePointer: MediaQueryList): void {
  const key = "42tris.touchRestartSymbol";
  const select = document.querySelector<HTMLSelectElement>("#restart-symbol")!;
  const note = document.querySelector<HTMLElement>("#display-note")!;
  select.value = loadDisplaySetting(key, note) === "arrow" ? "arrow" : "r";
  document.documentElement.dataset.restartSymbol = select.value;
  select.addEventListener("change", () => {
    document.documentElement.dataset.restartSymbol = select.value;
    saveDisplaySetting(key, select.value, note);
  });

  const input = document.querySelector<HTMLInputElement>("#display-search")!;
  const filter = setupSettingsSearch(input, document.querySelector<HTMLElement>("#display-settings")!,
    document.querySelector<HTMLElement>("#display-empty")!);
  coarsePointer.addEventListener("change", () => {
    if (coarsePointer.matches) return;
    input.value = "";
    filter();
  });
}

function parseHandling(saved: string | null): Handling {
  if (!saved) return { ...DEFAULT_HANDLING };
  const value = JSON.parse(saved);
  validateHandling(value);
  return value;
}

export function loadHandling(): Handling {
  try {
    return parseHandling(localStorage.getItem(storageKey));
  } catch {
    document.querySelector<HTMLParagraphElement>("#storage-note")!.textContent = "Saved settings could not be loaded. Using defaults.";
    return { ...DEFAULT_HANDLING };
  }
}

export function setupHandling(handling: Handling, onChange: (value: Handling) => void): void {
  const note = document.querySelector<HTMLParagraphElement>("#storage-note")!;
  const container = document.querySelector<HTMLDivElement>("#handling-controls")!;
  const rows: { key: keyof Handling; label: string; help: string }[] = [
    { key: "das", label: "DAS", help: "Delay before a held direction starts repeating." },
    { key: "arr", label: "ARR", help: "Time between sideways moves. 0 F moves to the wall." },
    { key: "sddas", label: "Soft-drop DAS", help: "Delay before the held soft-drop key starts repeating." },
    { key: "sdarr", label: "Soft-drop ARR", help: "Soft-drop interval. 0 F drops instantly to the surface." },
  ];
  const refresh: (() => void)[] = [];
  function save(change: Partial<Handling>) {
    onChange({ ...handling });
    void withPreferenceLock(storageKey, () => {
      const { saved } = updatePreferences(() => localStorage, storageKey, raw => {
        try { return parseHandling(raw); } catch { return { ...DEFAULT_HANDLING }; }
      }, handling, preferences => ({ ...preferences, ...change }));
      note.textContent = saved ? "Changes are saved on this device." : "Settings apply for this session; browser storage is unavailable.";
    });
  }
  for (const { key, label, help } of rows) {
    const row = document.createElement("div");
    row.className = "setting";
    row.innerHTML = `<label for="${key}">${label}</label>
      <div class="inputs">
        <input id="${key}" type="range" min="0" max="${HANDLING_MAX[key]}" step="0.01" aria-describedby="${key}-help">
        <input id="${key}-value" type="number" min="0" max="${HANDLING_MAX[key]}" step="0.01" aria-label="${label} in frames" aria-describedby="${key}-help"><span>F</span>
      </div>
      <output for="${key} ${key}-value"></output>
      <p id="${key}-help" class="hint">${help}</p>`;
    container.append(row);
    const slider = row.querySelector<HTMLInputElement>("input[type=range]")!;
    const number = row.querySelector<HTMLInputElement>("input[type=number]")!;
    const output = row.querySelector<HTMLOutputElement>("output")!;
    const update = () => {
      slider.value = number.value = String(handling[key]);
      output.value = `${handling[key]} F / ${(handling[key] * FRAME_MS).toFixed(2)} ms${handling[key] === 0 && (key === "arr" || key === "sdarr") ? " · Instant" : ""}`;
    };
    refresh.push(update);
    for (const input of [slider, number]) {
      input.addEventListener("input", () => {
        if (!input.validity.valid || !Number.isFinite(input.valueAsNumber)) return;
        handling[key] = input.valueAsNumber;
        // Preserve an unfinished number while typing (for example, "4.").
        slider.value = String(handling[key]);
        if (input === slider) number.value = slider.value;
        output.value = `${handling[key]} F / ${(handling[key] * FRAME_MS).toFixed(2)} ms${handling[key] === 0 && (key === "arr" || key === "sdarr") ? " · Instant" : ""}`;
        save({ [key]: handling[key] });
      });
      input.addEventListener("change", update);
    }
    update();
  }
  document.querySelector("#reset-handling")!.addEventListener("click", () => {
    Object.assign(handling, DEFAULT_HANDLING);
    refresh.forEach(update => update());
    save({ ...handling });
  });
  const finesseButton = document.querySelector<HTMLButtonElement>("#finesse-handling")!;
  let appliedTimer: ReturnType<typeof setTimeout>;
  finesseButton.addEventListener("click", () => {
    Object.assign(handling, { das: 4.9, arr: 0, sddas: 0, sdarr: 0 });
    refresh.forEach(update => update());
    save({ ...handling });
    finesseButton.classList.add("applied");
    clearTimeout(appliedTimer);
    appliedTimer = setTimeout(() => finesseButton.classList.remove("applied"), 1200);
  });
}
