import { DEFAULT_HANDLING, FRAME_MS, HANDLING_MAX, validateHandling, type Handling } from "@42tris/core";

const storageKey = "42tris.handling";
const note = document.querySelector<HTMLParagraphElement>("#storage-note")!;

export function loadHandling(): Handling {
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved) {
      const value = JSON.parse(saved);
      validateHandling(value);
      return value;
    }
  } catch {
    note.textContent = "Saved settings could not be loaded. Using defaults.";
  }
  return { ...DEFAULT_HANDLING };
}

export function setupHandling(handling: Handling, onChange: (value: Handling) => void): void {
  const container = document.querySelector<HTMLDivElement>("#handling-controls")!;
  const rows: { key: keyof Handling; label: string; help: string }[] = [
    { key: "das", label: "DAS", help: "Delay before a held direction starts repeating." },
    { key: "arr", label: "ARR", help: "Time between sideways moves. 0 F moves to the wall." },
    { key: "sddas", label: "Soft-drop DAS", help: "Delay before held Down Arrow starts repeating." },
    { key: "sdarr", label: "Soft-drop ARR", help: "Soft-drop interval. 0 F drops instantly to the surface." },
  ];
  const refresh: (() => void)[] = [];
  function save() {
    onChange({ ...handling });
    try {
      localStorage.setItem(storageKey, JSON.stringify(handling));
      note.textContent = "Changes are saved on this device.";
    } catch {
      note.textContent = "Settings apply for this session; browser storage is unavailable.";
    }
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
        save();
      });
      input.addEventListener("change", update);
    }
    update();
  }
  document.querySelector("#reset-handling")!.addEventListener("click", () => {
    Object.assign(handling, DEFAULT_HANDLING);
    refresh.forEach(update => update());
    save();
  });
}
