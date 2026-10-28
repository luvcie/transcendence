import { Input, type InputId } from "@42tris/core";

export const ACTIONS = {
  left: { label: "Move left", down: Input.LeftDown, up: Input.LeftUp },
  right: { label: "Move right", down: Input.RightDown, up: Input.RightUp },
  softDrop: { label: "Soft drop", down: Input.SoftDropDown, up: Input.SoftDropUp },
  hardDrop: { label: "Hard drop", down: Input.HardDrop },
  clockwise: { label: "Clockwise", down: Input.RotateCw },
  counterclockwise: { label: "Counterclockwise", down: Input.RotateCcw },
  rotate180: { label: "180° rotation", down: Input.Rotate180 },
  hold: { label: "Hold", down: Input.Hold },
  restart: { label: "Restart" },
  pause: { label: "Pause" },
} satisfies Record<string, { label: string; down?: InputId; up?: InputId }>;
export type Action = keyof typeof ACTIONS;
export type Keybinds = Record<Action, [string, string]>;
export const DEFAULT_KEYBINDS: Keybinds = {
  left: ["arrowleft", ""],
  right: ["arrowright", ""],
  softDrop: ["arrowdown", ""],
  hardDrop: [" ", ""],
  clockwise: ["arrowup", "x"],
  counterclockwise: ["z", "control"],
  rotate180: ["<", ""],
  hold: ["shift", ""],
  restart: ["r", ""],
  pause: ["escape", ""],
};
export const actionNames = Object.keys(ACTIONS) as Action[];

export function keyLabel(key: string): string {
  const labels: Record<string, string> = {
    "": "Unbound", " ": "Space", arrowleft: "←", arrowright: "→", arrowdown: "↓",
    arrowup: "↑", control: "Ctrl", shift: "Shift", escape: "Esc",
  };
  return labels[key] ?? (key.length === 1 ? key.toUpperCase() : key);
}

export function actionForKey(bindings: Keybinds, key: string): Action | undefined {
  return actionNames.find(action => bindings[action].includes(key.toLowerCase()));
}

export function validateKeybinds(value: Keybinds): void {
  const used = new Set<string>();
  for (const action of actionNames) {
    const keys = value[action];
    if (!Array.isArray(keys) || keys.length !== 2) throw new Error("Invalid keybinds");
    for (const key of keys) {
      if (typeof key !== "string" || key !== key.toLowerCase() || (key === "escape" && action !== "pause")) {
        throw new Error("Invalid keybind");
      }
      if (!key) continue;
      if (used.has(key)) throw new Error("Duplicate keybind");
      used.add(key);
    }
  }
}

export function parseKeybinds(saved: string): Keybinds {
  const value = JSON.parse(saved);
  const needsRestart = value && typeof value === "object" && !("restart" in value);
  if (needsRestart) value.restart = ["", ""];
  validateKeybinds(value);
  // Existing bindings take priority if R was already assigned elsewhere.
  if (needsRestart && !actionForKey(value, "r")) value.restart[0] = "r";
  return value;
}
