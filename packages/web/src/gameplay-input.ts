import type { InputId } from "@42tris/core";
import { ACTIONS, actionForKey, type Action, type Keybinds } from "./keybinds";

export function mountGameplayInput(target: EventTarget, options: {
  bindings: Keybinds;
  pressed: Map<string, Action>;
  editable(target: EventTarget | null): boolean;
  blocked(): boolean;
  settingsOpen(): boolean;
  starting(): boolean;
  menu(): void;
  undo(): void;
  restart(): void;
  input(input: InputId): void;
  lateRelease(): void;
}) {
  const { pressed, bindings } = options;
  const down = (event: Event) => {
    const e = event as KeyboardEvent;
    if (e.key === "Escape") {
      e.preventDefault();
      if (!e.repeat && !e.isComposing) options.menu();
      return;
    }
    if (options.editable(e.target)) return;
    if (e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (!e.repeat && !e.isComposing && !options.blocked()) options.undo();
      return;
    }
    const action = actionForKey(bindings, e.key);
    const gameplayModifiers = (!e.ctrlKey || pressed.has("ControlLeft") || pressed.has("ControlRight"))
      && (!e.metaKey || pressed.has("MetaLeft") || pressed.has("MetaRight"));
    if ((e.ctrlKey || e.metaKey) && !["Control", "Meta", "Shift", "Alt"].includes(e.key)
      && (!gameplayModifiers || action === "restart")) return;
    if (action === "pause" && !options.settingsOpen()) {
      e.preventDefault();
      if (!e.repeat && !e.isComposing) options.menu();
      return;
    }
    if (options.blocked() || !action || action === "pause") return;
    e.preventDefault();
    if (e.repeat || e.isComposing || pressed.has(e.code)) return;
    if (action === "restart") { options.restart(); return; }
    if (options.starting()) return;
    const held = [...pressed.values()].includes(action);
    pressed.set(e.code, action);
    const binding = ACTIONS[action];
    if (!("up" in binding) || !held) options.input(binding.down);
  };
  const up = (event: Event) => {
    const e = event as KeyboardEvent;
    const action = pressed.get(e.code);
    pressed.delete(e.code);
    if (!action || [...pressed.values()].includes(action)) return;
    const binding = ACTIONS[action];
    if ("up" in binding) {
      if (options.blocked()) options.lateRelease();
      else options.input(binding.up);
    }
  };
  target.addEventListener("keydown", down);
  target.addEventListener("keyup", up);
  return () => {
    target.removeEventListener("keydown", down);
    target.removeEventListener("keyup", up);
    pressed.clear();
  };
}
