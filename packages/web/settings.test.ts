import { expect, test } from "bun:test";
import { setupDisplayToggle, setupSurgeIcon, setupTouchDisplaySettings } from "./src/settings";
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
      Object.assign(globalThis, { document: Object.assign(document, {
        documentElement: document.root,
        querySelectorAll(selector: string) {
          return selector === ".surge-icon" ? [document.querySelector("#surge-icon"), document.querySelector("#editor-surge-icon")] : [];
        },
      }) });
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

test("the Surge icon downloads on demand and boots from storage without another download", () => {
  return withSettings(async (setup, storage) => {
    const key = "42tris.surgeIcon";
    const mask = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAFUAAABSCAYAAAAl8JjiAAAAMklEQVR4nO3BMQEAAADCoPVPbQo/oAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAN4GbToAAX8az9kAAAAASUVORK5CYII=";
    const truncated = mask.slice(0, "data:image/png;base64,".length + 32);
    const decoded: string[] = [];
    let downloads = 0;
    let unavailable = true;
    function mount() {
      const document = setup();
      const panel = document.querySelector("#settings-skins");
      const download = panel.querySelector("#download-surge-icon");
      const remove = panel.querySelector("#remove-surge-icon");
      const icon = document.querySelector("#surge-icon");
      const editorIcon = document.querySelector("#editor-surge-icon");
      const note = panel.querySelector("#surge-icon-note");
      icon.hidden = editorIcon.hidden = remove.hidden = true;
      const ready = setupSurgeIcon(async () => {
        downloads++;
        if (unavailable) throw new Error("Unavailable");
        return mask;
      }, () => ({
        src: "", naturalWidth: 85, naturalHeight: 82,
        async decode() {
          decoded.push(this.src);
          if (this.src !== mask) throw new Error("Incomplete PNG");
        },
      }) as HTMLImageElement);
      return { download, remove, icon, editorIcon, note, ready };
    }
    const { download, icon, editorIcon, note } = mount();
    expect(downloads).toBe(0);
    expect(icon.hidden).toBe(true);
    download.dispatchEvent(new Event("click"));
    download.dispatchEvent(new Event("click"));
    expect(download.disabled).toBe(true);
    await Promise.resolve();
    expect(downloads).toBe(1);
    expect(note.textContent).toContain("Try again");
    expect(icon.hidden).toBe(true);
    expect(storage.has(key)).toBe(false);

    unavailable = false;
    download.dispatchEvent(new Event("click"));
    await Promise.resolve();
    expect(icon.hidden).toBe(false);
    expect(icon.getAttribute("style")).toBe(`--surge-mask: url("${mask}")`);
    expect(editorIcon.hidden).toBe(false);
    expect(editorIcon.getAttribute("style")).toBe(icon.getAttribute("style"));
    expect(storage.get(key)).toBe(mask);

    unavailable = true;
    const reloaded = mount();
    expect(reloaded.icon.hidden).toBe(true);
    await reloaded.ready;
    expect(downloads).toBe(2);
    expect(reloaded.icon.hidden).toBe(false);
    expect(reloaded.icon.getAttribute("style")).toBe(icon.getAttribute("style"));
    expect(reloaded.download.hidden).toBe(true);
    expect(reloaded.remove.hidden).toBe(false);
    reloaded.remove.dispatchEvent(new Event("click"));
    expect(reloaded.icon.hidden).toBe(true);
    expect(reloaded.icon.getAttribute("style")).toBeNull();
    expect(reloaded.editorIcon.hidden).toBe(true);
    expect(reloaded.download.hidden).toBe(false);
    expect(storage.has(key)).toBe(false);
    expect(mount().icon.hidden).toBe(true);
    for (const invalid of ["true", "data:image/png;base64,AQID", truncated]) {
      storage.set(key, invalid);
      const fallback = mount();
      await fallback.ready;
      expect(fallback.icon.hidden).toBe(true);
      expect(fallback.download.hidden).toBe(false);
      expect(fallback.download.disabled).toBe(false);
      expect(fallback.remove.hidden).toBe(true);
      expect(storage.has(key)).toBe(false);
    }
    expect(downloads).toBe(2);
    expect(decoded).toEqual([mask, truncated]);
  });
});

test("Surge icon rotation defaults on and persists independently of the download", () => {
  return withSettings((setup, storage) => {
    function mount() {
      const document = setup();
      const rotate = document.querySelector("#settings-skins").querySelector("#rotate-surge-icon");
      const icon = document.querySelector("#surge-icon");
      setupSurgeIcon();
      return { rotate, icon, editorIcon: document.querySelector("#editor-surge-icon") };
    }
    const { rotate, icon, editorIcon } = mount();
    expect(rotate.checked).toBe(true);
    expect(icon.dataset.rotate).toBe("true");

    rotate.checked = false;
    rotate.dispatchEvent(new Event("change"));
    expect(icon.dataset.rotate).toBe("false");
    expect(editorIcon.dataset.rotate).toBe("false");
    expect(storage.get("42tris.rotateSurgeIcon")).toBe("false");

    const reloaded = mount();
    expect(reloaded.rotate.checked).toBe(false);
    expect(reloaded.icon.dataset.rotate).toBe("false");
    reloaded.rotate.checked = true;
    reloaded.rotate.dispatchEvent(new Event("change"));
    expect(storage.get("42tris.rotateSurgeIcon")).toBe("true");
    expect(storage.has("42tris.surgeIcon")).toBe(false);
  });
});
