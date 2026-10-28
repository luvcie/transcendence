import { ACTIONS, DEFAULT_KEYBINDS, actionForKey, actionNames, keyLabel, parseKeybinds, type Action, type Keybinds } from "./keybinds";

const storageKey = "42tris.keybinds";
const note = document.querySelector<HTMLParagraphElement>("#keybind-note")!;

export function loadKeybinds(): Keybinds {
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved) return parseKeybinds(saved);
  } catch {
    note.textContent = "Saved keybinds could not be loaded. Using defaults.";
  }
  return structuredClone(DEFAULT_KEYBINDS);
}

export function setupKeybinds(bindings: Keybinds, onChange: () => void): () => void {
  const container = document.querySelector<HTMLDivElement>("#keybind-controls")!;
  const buttons = new Map<Action, HTMLButtonElement[]>();
  let capture: { action: Action; slot: number } | null = null;
  function refresh() {
    for (const action of actionNames) {
      buttons.get(action)!.forEach((button, slot) => {
        button.textContent = capture?.action === action && capture.slot === slot ? "Press a key…" : keyLabel(bindings[action][slot]);
      });
    }
  }
  function cancel() {
    capture = null;
    refresh();
  }
  function save() {
    cancel();
    onChange();
    try {
      localStorage.setItem(storageKey, JSON.stringify(bindings));
      note.textContent = "Keybinds saved on this device.";
    } catch {
      note.textContent = "Keybinds apply for this session; browser storage is unavailable.";
    }
  }
  for (const action of actionNames) {
    const row = document.createElement("div");
    row.className = "keybind-row";
    const label = document.createElement("span");
    label.textContent = ACTIONS[action].label;
    row.append(label);
    const slots: HTMLButtonElement[] = [];
    for (let slot = 0; slot < 2; slot++) {
      const group = document.createElement("div");
      group.className = "keybind-slot";
      const button = document.createElement("button");
      button.setAttribute("aria-label", `${ACTIONS[action].label}, key ${slot + 1}`);
      button.addEventListener("click", () => {
        capture = { action, slot };
        note.textContent = "Press a key to assign it. Esc cancels.";
        refresh();
      });
      const clear = document.createElement("button");
      clear.textContent = "×";
      clear.setAttribute("aria-label", `Clear ${ACTIONS[action].label} key ${slot + 1}`);
      clear.addEventListener("click", () => {
        bindings[action][slot] = "";
        save();
      });
      group.append(button, clear);
      row.append(group);
      slots.push(button);
    }
    buttons.set(action, slots);
    container.append(row);
  }
  window.addEventListener("keydown", e => {
    if (!capture) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.repeat || e.isComposing) return;
    if (e.key === "Escape") {
      cancel();
      note.textContent = "Key assignment canceled.";
      return;
    }
    const key = e.key.toLowerCase();
    if (["dead", "unidentified", "process"].includes(key)) {
      note.textContent = "Choose a letter, symbol, modifier, or navigation key.";
      return;
    }
    const owner = actionForKey(bindings, key);
    if (owner && !(owner === capture.action && bindings[owner][capture.slot] === key)) {
      note.textContent = `${keyLabel(key)} is assigned to ${ACTIONS[owner].label}. Clear that binding first.`;
      return;
    }
    bindings[capture.action][capture.slot] = key;
    save();
  }, true);
  document.querySelector("#reset-keybinds")!.addEventListener("click", () => {
    Object.assign(bindings, structuredClone(DEFAULT_KEYBINDS));
    save();
  });
  refresh();
  return cancel;
}
