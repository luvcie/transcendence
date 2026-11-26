import type { InputId } from "@42tris/core";
import { ACTIONS, actionForKey, type Action, type Keybinds } from "./keybinds";
import type { TouchControls } from "./touch-controls";

export type GameplayAction = Exclude<Action, "pause" | "restart">;

export function mountGameplayInput(target: EventTarget & { readonly innerWidth?: number }, options: {
  bindings: Keybinds;
  pressed?: Map<string, Action>;
  editable(target: EventTarget | null): boolean;
  blocked(): boolean;
  settingsOpen(): boolean;
  starting(): boolean;
  menu(): void;
  undo(): void;
  restart(): void;
  input(input: InputId): void;
  lateRelease(): void;
  touch?: TouchControls;
}) {
  const { pressed = new Map<string, Action>(), bindings } = options;
  const press = (id: string, action: GameplayAction) => {
    const binding = ACTIONS[action];
    const held = "up" in binding && [...pressed.values()].includes(action);
    pressed.set(id, action);
    if (!held) options.input(binding.down);
  };
  const release = (id: string) => {
    const action = pressed.get(id);
    pressed.delete(id);
    if (!action) return;
    const binding = ACTIONS[action];
    if ("up" in binding && ![...pressed.values()].includes(action)) {
      if (options.blocked()) options.lateRelease();
      else options.input(binding.up);
    }
  };
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
    press(e.code, action);
  };
  const lifetime = new AbortController();
  const listen = { signal: lifetime.signal };
  const pointers = new Map<number, HTMLButtonElement>();
  const releasePointer = (pointerId: number) => {
    const button = pointers.get(pointerId);
    if (!button) return;
    pointers.delete(pointerId);
    if (button.hasPointerCapture(pointerId)) button.releasePointerCapture(pointerId);
    if (![...pointers.values()].includes(button)) button.classList.remove("pressed");
    release(`touch:${pointerId}`);
  };
  const releaseTouches = () => {
    for (const pointerId of pointers.keys()) releasePointer(pointerId);
  };
  const clear = () => {
    pressed.clear();
    releaseTouches();
  };
  const touch = options.touch;
  const setTouchBlocked = (blocked: boolean) => {
    if (!touch || blocked === (touch.element.getAttribute("data-blocked") !== null)) return;
    if (blocked) {
      touch.element.setAttribute("data-blocked", "");
      releaseTouches();
    } else touch.element.removeAttribute("data-blocked");
  };
  if (touch) {
    const canTouch = () => touch.element.getAttribute("data-blocked") === null && !options.blocked();
    const canPlay = () => canTouch() && !options.starting();
    for (const [action, button] of touch.buttons) {
      button.addEventListener("pointerdown", e => {
        if (e.button !== 0) return;
        e.preventDefault();
        if (pointers.has(e.pointerId) || !canPlay()) return;
        button.setPointerCapture(e.pointerId);
        pointers.set(e.pointerId, button);
        button.classList.add("pressed");
        press(`touch:${e.pointerId}`, action);
      }, listen);
      for (const type of ["pointerup", "pointercancel", "lostpointercapture"] as const) {
        button.addEventListener(type, e => releasePointer(e.pointerId), listen);
      }
      button.addEventListener("click", e => {
        if (e.detail !== 0 || !canPlay()) return;
        const id = `touch:${action}:click`;
        press(id, action);
        release(id);
      }, listen);
    }
    for (const action of ["undo", "restart"] as const) {
      const button = touch[action];
      const tap = () => {
        if (!button.hidden && !button.disabled && canTouch() && (action === "restart" || !options.starting())) options[action]();
      };
      button.addEventListener("pointerdown", e => {
        if (e.button !== 0) return;
        e.preventDefault();
        tap();
      }, listen);
      button.addEventListener("click", e => { if (e.detail === 0) tap(); }, listen);
    }
    for (const event of ["blur", "pagehide", "orientationchange"]) target.addEventListener(event, releaseTouches, listen);
    let width = target.innerWidth;
    target.addEventListener("resize", () => {
      const nextWidth = target.innerWidth;
      if (nextWidth === width) return;
      width = nextWidth;
      releaseTouches();
    }, listen);
    const doc = touch.element.ownerDocument;
    doc.addEventListener("visibilitychange", () => { if (doc.hidden) releaseTouches(); }, listen);
  }
  target.addEventListener("keydown", down, listen);
  target.addEventListener("keyup", event => release((event as KeyboardEvent).code), listen);
  return Object.assign(() => {
    lifetime.abort();
    clear();
  }, { clear, releaseTouches, setTouchBlocked });
}
