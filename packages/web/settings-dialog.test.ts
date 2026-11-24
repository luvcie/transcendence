import { expect, test } from "bun:test";
import { setupDisplayToggle } from "./src/settings";
import { dismissSettingsOnBackdrop } from "./src/settings-dialog";
import { FakeDocument } from "./test-dom";

test("only a click outside the settings dialog closes it", () => {
  const dialog = new EventTarget() as HTMLDialogElement;
  dialog.getBoundingClientRect = () => ({ left: 100, right: 300, top: 100, bottom: 300 } as DOMRect);
  let closes = 0;
  dismissSettingsOnBackdrop(dialog, () => { closes++; });
  function click(x: number, y: number, target?: EventTarget) {
    const event = new Event("click");
    Object.defineProperties(event, { clientX: { value: x }, clientY: { value: y }, ...(target ? { target: { value: target } } : {}) });
    dialog.dispatchEvent(event);
  }
  click(150, 150);
  click(20, 20, new EventTarget());
  expect(closes).toBe(0);
  click(20, 20);
  expect(closes).toBe(1);
});

test("fast skins default off, apply on change, and persist across settings setup", () => {
  const globals = ["document", "localStorage"];
  const originals = globals.map(name => Object.getOwnPropertyDescriptor(globalThis, name));
  const storage = new Map<string, string>();
  const document = new FakeDocument();
  Object.assign(globalThis, { document, localStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
  } });
  try {
    const changes: boolean[] = [];
    const toggle = document.querySelector("#fast-skins");
    expect(setupDisplayToggle("#fast-skins", "42tris.fastSkins", enabled => changes.push(enabled))).toBe(false);
    toggle.checked = true;
    toggle.dispatchEvent(new Event("change"));
    expect(changes).toEqual([true]);
    expect(storage.get("42tris.fastSkins")).toBe("true");
    Object.assign(globalThis, { document: new FakeDocument() });
    expect(setupDisplayToggle("#fast-skins", "42tris.fastSkins", () => {})).toBe(true);
  } finally {
    globals.forEach((name, index) => {
      if (originals[index]) Object.defineProperty(globalThis, name, originals[index]!);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
});
