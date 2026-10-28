import { expect, test } from "bun:test";
import { DEFAULT_KEYBINDS, actionForKey, parseKeybinds, validateKeybinds } from "./src/keybinds";

test("defaults include Shift hold and both rotation aliases", () => {
  validateKeybinds(DEFAULT_KEYBINDS);
  expect(actionForKey(DEFAULT_KEYBINDS, "Shift")).toBe("hold");
  expect(actionForKey(DEFAULT_KEYBINDS, "X")).toBe("clockwise");
  expect(actionForKey(DEFAULT_KEYBINDS, "ArrowUp")).toBe("clockwise");
  expect(actionForKey(DEFAULT_KEYBINDS, "<")).toBe("rotate180");
});

test("restart defaults to R and can be rebound", () => {
  const keys = structuredClone(DEFAULT_KEYBINDS);
  expect(actionForKey(keys, "R")).toBe("restart");
  keys.restart = ["backspace", ""];
  validateKeybinds(keys);
  expect(actionForKey(keys, "r")).toBeUndefined();
  expect(actionForKey(keys, "Backspace")).toBe("restart");
});

test("saved bindings gain restart without losing custom keys", () => {
  const { restart, ...old } = structuredClone(DEFAULT_KEYBINDS);
  old.hold = ["c", ""];
  const keys = parseKeybinds(JSON.stringify(old));
  expect(keys.hold).toEqual(["c", ""]);
  expect(keys.restart).toEqual(["r", ""]);
  old.hold = ["r", ""];
  const conflict = parseKeybinds(JSON.stringify(old));
  expect(conflict.hold).toEqual(["r", ""]);
  expect(conflict.restart).toEqual(["", ""]);
});

test("a rebound key replaces the default and supports a second key", () => {
  const keys = structuredClone(DEFAULT_KEYBINDS);
  keys.hold = ["c", "v"];
  validateKeybinds(keys);
  expect(actionForKey(keys, "Shift")).toBeUndefined();
  expect(actionForKey(keys, "C")).toBe("hold");
  expect(actionForKey(keys, "v")).toBe("hold");
});

test("stored conflicts and reserved escape bindings are rejected", () => {
  const keys = structuredClone(DEFAULT_KEYBINDS);
  keys.hold[0] = "arrowleft";
  expect(() => validateKeybinds(keys)).toThrow();
  keys.hold[0] = "escape";
  expect(() => validateKeybinds(keys)).toThrow();
});

test("unbound slots are allowed but malformed saved keys are rejected", () => {
  const keys = structuredClone(DEFAULT_KEYBINDS);
  keys.hold = ["", ""];
  validateKeybinds(keys);
  expect(() => validateKeybinds({} as typeof keys)).toThrow();
  keys.hold[0] = "Shift";
  expect(() => validateKeybinds(keys)).toThrow();
});
