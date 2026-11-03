import { expect, test } from "bun:test";
import { Game, Input } from "@42tris/core";
import { DEFAULT_KEYBINDS } from "./src/keybinds";
import { mountGameplayInput } from "./src/gameplay-input";

for (const modifier of ["Control", "Meta"] as const) {
  test(`hard drop locks on its first press while ${modifier} is held for 180 rotation`, () => {
    const target = new EventTarget();
    const game = new Game(1);
    const bindings = structuredClone(DEFAULT_KEYBINDS);
    bindings.counterclockwise = ["z", ""];
    bindings.rotate180 = [modifier.toLowerCase(), ""];
    const unmount = mountGameplayInput(target, {
      bindings, pressed: new Map(), editable: () => false, blocked: () => false,
      settingsOpen: () => false, starting: () => false,
      menu() {}, undo() {}, restart() {}, lateRelease() {},
      input: input => game.apply(input, 0),
    });
    const key = (type: string, key: string, code: string) => {
      const event = Object.assign(new Event(type, { cancelable: true }), {
        key, code, ctrlKey: modifier === "Control", metaKey: modifier === "Meta",
      });
      target.dispatchEvent(event);
      return event;
    };
    key("keydown", modifier, `${modifier}Left`);
    expect(game.rot).toBe(2);
    key("keydown", " ", "Space");
    expect(game.lastClear?.sequence).toBe(1);
    key("keyup", " ", "Space");
    key("keydown", " ", "Space");
    expect(game.lastClear?.sequence).toBe(2);
    key("keyup", " ", "Space");
    expect(key("keydown", "r", "KeyR").defaultPrevented).toBe(false);
    unmount();
  });
}

test("input mount filters repeats, deduplicates dual bindings, releases by physical key and unmounts", () => {
  const target = new EventTarget();
  const inputs: number[] = [];
  let blocked = false, editable = false, releases = 0;
  const options = {
    bindings: { ...structuredClone(DEFAULT_KEYBINDS), left: ["a", "arrowleft"] as [string, string] }, pressed: new Map(),
    editable: () => editable, blocked: () => blocked, settingsOpen: () => false, starting: () => false,
    menu() {}, undo() {}, restart() {}, input: (input: number) => { inputs.push(input); }, lateRelease: () => { releases++; },
  };
  const key = (type: string, key: string, code: string, repeat = false) => {
    target.dispatchEvent(Object.assign(new Event(type, { cancelable: true }), { key, code, repeat }));
  };
  let unmount = mountGameplayInput(target, options);
  key("keydown", "a", "KeyA"); key("keydown", "a", "KeyA", true); key("keydown", "ArrowLeft", "ArrowLeft");
  expect(inputs).toEqual([Input.LeftDown]);
  key("keyup", "A", "KeyA");
  expect(inputs).toEqual([Input.LeftDown]);
  key("keyup", "ArrowLeft", "ArrowLeft");
  expect(inputs).toEqual([Input.LeftDown, Input.LeftUp]);
  editable = true; key("keydown", "a", "KeyA");
  expect(inputs).toHaveLength(2);
  editable = false; key("keydown", "a", "KeyA"); blocked = true; key("keyup", "a", "KeyA");
  expect(releases).toBe(1);
  unmount(); blocked = false; key("keydown", "a", "KeyA");
  expect(inputs).toHaveLength(3);
  unmount = mountGameplayInput(target, options); key("keydown", "a", "KeyA");
  expect(inputs).toHaveLength(4);
  unmount();
});

test("browser Ctrl/Meta shortcuts pass through while undo and standalone modifiers remain bound", () => {
  const target = new EventTarget();
  const inputs: number[] = [];
  let restarts = 0, undos = 0;
  const unmount = mountGameplayInput(target, {
    bindings: { ...structuredClone(DEFAULT_KEYBINDS), right: ["l", ""] }, pressed: new Map(),
    editable: () => false, blocked: () => false, settingsOpen: () => false, starting: () => false,
    menu() {}, undo() { undos++; }, restart() { restarts++; }, input: input => { inputs.push(input); }, lateRelease() {},
  });
  const key = (key: string, modifiers: object = {}) => {
    const event = Object.assign(new Event("keydown", { cancelable: true }), { key, code: key, ...modifiers });
    target.dispatchEvent(event);
    return event;
  };
  for (const modified of ["r", "R", "l", "x", "ArrowLeft", " "]) {
    for (const modifier of ["ctrlKey", "metaKey"]) {
      expect(key(modified, { [modifier]: true }).defaultPrevented).toBe(false);
    }
  }
  expect(restarts).toBe(0);
  expect(inputs).toEqual([]);
  expect(key("z", { ctrlKey: true }).defaultPrevented).toBe(true);
  expect(undos).toBe(1);
  expect(key("Control", { ctrlKey: true }).defaultPrevented).toBe(true);
  expect(inputs).toEqual([Input.RotateCcw]);
  expect(key("r").defaultPrevented).toBe(true);
  expect(restarts).toBe(1);
  unmount();
});

test("replay isolation blocks gameplay, undo and restart and restores input after exit", () => {
  const target = new EventTarget();
  const game = new Game(1);
  let watching = true, undos = 0, restarts = 0, exits = 0;
  const pressed = new Map();
  const unmount = mountGameplayInput(target, {
    bindings: structuredClone(DEFAULT_KEYBINDS), pressed, editable: () => false,
    blocked: () => watching, settingsOpen: () => false, starting: () => false,
    menu() { exits++; watching = false; pressed.clear(); },
    undo() { undos++; }, restart() { restarts++; }, lateRelease() {},
    input: input => game.apply(input, 0),
  });
  const key = (key: string, modifiers: object = {}) => target.dispatchEvent(Object.assign(new Event("keydown", { cancelable: true }), {
    key, code: key, repeat: false, ...modifiers,
  }));
  const initial = game.saveState();
  for (const keyName of ["ArrowLeft", "ArrowRight", "ArrowDown", "ArrowUp", " ", "c", "x", "z", "r"]) key(keyName);
  key("z", { ctrlKey: true });
  expect(game.saveState()).toEqual(initial); expect(undos).toBe(0); expect(restarts).toBe(0);
  expect(pressed.size).toBe(0);
  key("Escape"); expect(exits).toBe(1);
  key(" "); expect(game.lastClear?.sequence).toBe(1);
  watching = true; pressed.clear();
  key(" "); expect(game.lastClear?.sequence).toBe(1);
  unmount(); key("Escape"); expect(exits).toBe(1);
});
