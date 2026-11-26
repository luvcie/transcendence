import { expect, test } from "bun:test";
import { Game, Input } from "@42tris/core";
import { DEFAULT_KEYBINDS } from "./src/keybinds";
import { mountGameplayInput } from "./src/gameplay-input";
import { createTouchControls } from "./src/touch-controls";
import { FakeDocument } from "./test-dom";

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

function touchInput() {
  const document = new FakeDocument();
  const target = Object.assign(new EventTarget(), { innerWidth: 320 });
  const controls = createTouchControls(document.root as unknown as HTMLElement);
  const captures = new Map<number, HTMLButtonElement>();
  for (const button of controls.buttons.values()) {
    button.setPointerCapture = id => { captures.set(id, button); };
    button.hasPointerCapture = id => captures.get(id) === button;
    button.releasePointerCapture = id => { captures.delete(id); };
  }
  const state = { blocked: false, starting: false };
  const events: (number | "late release" | "undo" | "restart")[] = [];
  const inputMount = mountGameplayInput(target, {
    bindings: DEFAULT_KEYBINDS, touch: controls,
    editable: () => false, blocked: () => state.blocked, settingsOpen: () => false, starting: () => state.starting,
    menu() {}, undo: () => { events.push("undo"); }, restart: () => { events.push("restart"); },
    input: input => { events.push(input); }, lateRelease: () => { events.push("late release"); },
  });
  const pointer = (type: string, action: Parameters<typeof controls.buttons.get>[0], pointerId: number) => {
    const event = Object.assign(new Event(type, { cancelable: true }), { pointerId, pointerType: "touch", button: 0 });
    controls.buttons.get(action)!.dispatchEvent(event);
    return event;
  };
  const tapEvent = (action: "undo" | "restart", type: string, detail = 0) => controls[action].dispatchEvent(
    Object.assign(new Event(type, { cancelable: true }), { button: 0, pointerType: "touch", detail }));
  const key = (type: string) => target.dispatchEvent(Object.assign(new Event(type), { key: "ArrowLeft", code: "ArrowLeft" }));
  return { document, target, controls, pointer, tapEvent, key, captures, events, state, inputMount };
}

test("touch undo shares the keyboard callback and fires once on press when available", () => {
  const { target, controls, tapEvent, events, state, inputMount } = touchInput();
  const send = (type: string, detail = 0) => tapEvent("undo", type, detail);
  controls.setUndoCount(null);
  expect(controls.undo.hidden).toBe(true);
  expect(controls.undo.tabIndex).toBe(-1);
  send("pointerdown");
  controls.setUndoCount(0);
  expect(controls.undo.disabled).toBe(true);
  send("pointerdown");
  controls.setUndoCount(1);
  state.blocked = true;
  send("pointerdown");
  state.blocked = false;
  state.starting = true;
  send("pointerdown");
  state.starting = false;
  expect(events).toEqual([]);
  expect(send("pointerdown")).toBe(false);
  expect(events).toEqual(["undo"]);
  send("pointerup");
  send("click", 1);
  expect(events).toEqual(["undo"]);
  target.dispatchEvent(Object.assign(new Event("keydown"), { key: "z", code: "KeyZ", ctrlKey: true }));
  expect(events).toEqual(["undo", "undo"]);
  inputMount();
});

test("touch restart fires once on press and shares the keyboard restart gates", () => {
  const { target, controls, tapEvent, events, state, inputMount } = touchInput();
  expect(controls.restart.hidden).toBe(true);
  tapEvent("restart", "pointerdown");
  controls.restart.hidden = false;
  state.blocked = true;
  tapEvent("restart", "pointerdown");
  expect(events).toEqual([]);

  state.blocked = false;
  state.starting = true;
  expect(tapEvent("restart", "pointerdown")).toBe(false);
  expect(events).toEqual(["restart"]);
  tapEvent("restart", "pointerup");
  tapEvent("restart", "click", 1);
  expect(events).toEqual(["restart"]);
  target.dispatchEvent(Object.assign(new Event("keydown"), { key: "r", code: "KeyR" }));
  expect(events).toEqual(["restart", "restart"]);
  inputMount();
});

test("touch taps fire on down and fingers share held actions with the keyboard", () => {
  const { pointer, key, captures, events, inputMount } = touchInput();
  expect(pointer("pointerdown", "left", 1).defaultPrevented).toBe(true);
  pointer("pointerdown", "softDrop", 2);
  pointer("pointerdown", "hardDrop", 3);
  pointer("pointerdown", "hardDrop", 3);
  expect(events).toEqual([Input.LeftDown, Input.SoftDropDown, Input.HardDrop]);
  expect(captures.size).toBe(3);

  key("keydown");
  pointer("pointerup", "hardDrop", 3);
  pointer("pointerup", "left", 1);
  expect(events).toHaveLength(3);
  pointer("pointercancel", "softDrop", 2);
  pointer("lostpointercapture", "softDrop", 2);
  key("keyup");
  expect(events).toEqual([Input.LeftDown, Input.SoftDropDown, Input.HardDrop, Input.SoftDropUp, Input.LeftUp]);
  expect(captures.size).toBe(0);
  inputMount();
});

test("a gameplay touch release suppresses the synthesized click after controls are cleared", () => {
  const { pointer, controls, captures, events, inputMount } = touchInput();
  pointer("pointerdown", "hardDrop", 1);
  inputMount.clear();
  controls.element.hidden = true;
  expect(captures.size).toBe(0);
  expect(pointer("touchend", "hardDrop", 1).defaultPrevented).toBe(true);
  expect(events).toEqual([Input.HardDrop]);
  inputMount();
});

test.each(["resize", "orientationchange"])("touch releases held inputs on viewport %s", type => {
  const { target, pointer, key, captures, events, inputMount } = touchInput();
  key("keydown");
  pointer("pointerdown", "right", 1);
  pointer("pointerdown", "softDrop", 2);
  if (type === "resize") {
    target.dispatchEvent(new Event("resize"));
    expect(captures.size).toBe(2);
    expect(events).toEqual([Input.LeftDown, Input.RightDown, Input.SoftDropDown]);
    target.innerWidth = 360;
  }
  target.dispatchEvent(new Event(type));
  expect(captures.size).toBe(0);
  expect(events).toEqual([Input.LeftDown, Input.RightDown, Input.SoftDropDown, Input.RightUp, Input.SoftDropUp]);
  pointer("pointerup", "right", 1);
  key("keyup");
  expect(events.slice(5)).toEqual([Input.LeftUp]);
  inputMount();
});

test("touch honors starting and blocking and releases on capture loss, blur and hiding", () => {
  const { document, target, pointer, captures, events, state, inputMount } = touchInput();
  state.starting = true;
  pointer("pointerdown", "hardDrop", 1);
  state.starting = false;
  state.blocked = true;
  pointer("pointerdown", "rotate180", 2);
  expect(events).toEqual([]);
  expect(captures.size).toBe(0);

  state.blocked = false;
  pointer("pointerdown", "right", 3);
  state.blocked = true;
  pointer("pointerup", "right", 3);
  state.blocked = false;
  pointer("pointerdown", "left", 4);
  state.blocked = true;
  inputMount.setTouchBlocked(true);
  state.blocked = false;
  pointer("pointerdown", "softDrop", 8);
  inputMount.setTouchBlocked(false);
  pointer("pointerdown", "left", 5);
  pointer("lostpointercapture", "left", 5);
  pointer("pointerdown", "right", 6);
  target.dispatchEvent(new Event("blur"));
  pointer("pointerdown", "softDrop", 7);
  document.hidden = true;
  document.dispatchEvent(new Event("visibilitychange"));
  expect(events).toEqual([
    Input.RightDown, "late release", Input.LeftDown, "late release", Input.LeftDown, Input.LeftUp,
    Input.RightDown, Input.RightUp, Input.SoftDropDown, Input.SoftDropUp,
  ]);
  expect(captures.size).toBe(0);
  inputMount();
});
