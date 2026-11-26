import { expect, test } from "bun:test";
import { setupDisplayToggle, setupTouchDisplaySettings } from "./src/settings";
import { FakeDocument } from "./test-dom";

async function withSettings(run: (setup: () => FakeDocument, storage: Map<string, string>) => void | Promise<void>) {
  const globals = ["document", "localStorage"];
  const originals = globals.map(name => Object.getOwnPropertyDescriptor(globalThis, name));
  const storage = new Map<string, string>();
  try {
    Object.assign(globalThis, { localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value); },
      removeItem: (key: string) => { storage.delete(key); },
    } });
    await run(() => {
      const document = new FakeDocument();
      Object.assign(globalThis, { document: Object.assign(document, { documentElement: document.root }) });
      return document;
    }, storage);
  } finally {
    globals.forEach((name, index) => {
      if (originals[index]) Object.defineProperty(globalThis, name, originals[index]!);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
}

test("fast skins default off, apply on change, and persist across settings setup", () => {
  return withSettings((setup, storage) => {
    const changes: boolean[] = [];
    const document = setup();
    const toggle = document.querySelector("#fast-skins");
    expect(setupDisplayToggle("#fast-skins", "42tris.fastSkins", enabled => changes.push(enabled))).toBe(false);
    toggle.checked = true;
    toggle.dispatchEvent(new Event("change"));
    expect(changes).toEqual([true]);
    expect(storage.get("42tris.fastSkins")).toBe("true");
    setup();
    expect(setupDisplayToggle("#fast-skins", "42tris.fastSkins", () => {})).toBe(true);
  });
});

test("touch restart symbol defaults to R, applies on change, and survives setup again", () => {
  return withSettings(setup => {
    const pointer = Object.assign(new EventTarget(), { matches: true }) as MediaQueryList;
    const document = setup();
    setupTouchDisplaySettings(pointer);
    const select = document.querySelector("#restart-symbol");
    expect(select.value).toBe("r");
    expect(document.root.dataset.restartSymbol).toBe("r");

    select.value = "arrow";
    select.dispatchEvent(new Event("change"));
    expect(document.root.dataset.restartSymbol).toBe("arrow");
    const reloaded = setup();
    setupTouchDisplaySettings(pointer);
    expect(reloaded.querySelector("#restart-symbol").value).toBe("arrow");
    expect(reloaded.root.dataset.restartSymbol).toBe("arrow");
  });
});
