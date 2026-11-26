import { expect, test } from "bun:test";
import { DEFAULT_KEYBINDS, actionForKey, parseKeybinds, validateKeybinds } from "./src/keybinds";
import { FakeDocument } from "./test-dom";

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

test("keybinds remain editable after a failed save and merge again after recovery", async () => {
  const document = new FakeDocument(), window = new EventTarget();
  const globals = ["document", "window", "localStorage"];
  const originals = globals.map(name => Object.getOwnPropertyDescriptor(globalThis, name));
  let saved = JSON.stringify(DEFAULT_KEYBINDS), full = true;
  const localStorage = {
    getItem: () => saved,
    setItem: (_key: string, value: string) => {
      if (full) throw new DOMException("Storage is full", "QuotaExceededError");
      saved = value;
    },
  };
  try {
    Object.assign(globalThis, { document, window, localStorage });
    const { loadKeybinds, setupKeybinds } = await import("./src/keybind-settings");
    const bindings = loadKeybinds();
    setupKeybinds(bindings, () => {});
    const buttons = document.querySelector("#keybind-controls").children.flatMap(row => row.children.flatMap(slot => slot.children));
    const click = (label: string) => buttons.find(button => button.getAttribute("aria-label") === label)!.dispatchEvent(new Event("click"));
    const assign = (label: string, key: string) => {
      click(label);
      window.dispatchEvent(Object.assign(new Event("keydown", { cancelable: true }), { key }));
    };
    const note = document.querySelector("#keybind-note");

    click("Clear Hold key 1");
    expect(actionForKey(bindings, "Shift")).toBeUndefined();
    expect(actionForKey(parseKeybinds(saved), "Shift")).toBe("hold");
    assign("Restart, key 2", "Shift");
    expect(actionForKey(bindings, "Shift")).toBe("restart");
    expect(note.textContent).toContain("apply for this session");

    full = false;
    assign("Move left, key 2", "a");
    expect(parseKeybinds(saved)).toMatchObject({ left: ["arrowleft", "a"], restart: ["r", "shift"] });

    saved = JSON.stringify({ ...parseKeybinds(saved), right: ["d", ""] });
    assign("Move left, key 2", "q");
    expect(parseKeybinds(saved)).toMatchObject({ left: ["arrowleft", "q"], right: ["d", ""] });

    full = true;
    click("Clear Move left key 2");
    expect(bindings.left[1]).toBe("");
    full = false;
    saved = JSON.stringify({ ...parseKeybinds(saved), right: ["f", ""] });
    assign("Move left, key 2", "s");
    expect(bindings).toMatchObject({ left: ["arrowleft", "s"], right: ["f", ""] });
    expect(parseKeybinds(saved)).toEqual(bindings);
  } finally {
    globals.forEach((name, index) => {
      if (originals[index]) Object.defineProperty(globalThis, name, originals[index]!);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
});
