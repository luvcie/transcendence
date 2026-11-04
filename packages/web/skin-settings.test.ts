import { expect, test } from "bun:test";
import { setupSkins } from "./src/skin-settings";
import { SkinState } from "./src/skin-state";
import type { LoadedSkin } from "./src/skin-loader";
import { Element, FakeDocument } from "./test-dom";

test("skin previews stop when hidden and ignore late loads after scrolling or closing", async () => {
  class PreviewElement extends Element {
    append(...children: Element[]) { super.append(...children.filter(child => child instanceof Element)); }
  }
  class PreviewDocument extends FakeDocument {
    createElement() { return new PreviewElement(this); }
  }
  const document = new PreviewDocument();
  const list = document.querySelector("#skin-list");
  Object.assign(list, { querySelectorAll: () => [] });
  document.querySelector("#skin-credit").append = () => {};
  let intersect!: (entries: { target: Element; isIntersecting: boolean }[]) => void;
  class Observer {
    constructor(callback: typeof intersect) { intersect = callback; }
    observe() {} disconnect() {}
  }
  let frame = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const globals = ["document", "IntersectionObserver", "requestAnimationFrame", "cancelAnimationFrame"];
  const originals = globals.map(name => Object.getOwnPropertyDescriptor(globalThis, name));
  Object.assign(globalThis, { document, IntersectionObserver: Observer,
    requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++frame, callback); return frame; },
    cancelAnimationFrame: (id: number) => { frames.delete(id); },
  });
  const pending: { resolve: (skin: LoadedSkin) => void; skin: LoadedSkin }[] = [];
  const state = new SkinState(() => ({ getItem: () => null, setItem() {} }), def => new Promise(resolve => {
    pending.push({ resolve, skin: { def, tile: 32, image: {} as HTMLCanvasElement, connected: true, animation: { frames: 2, delay: 30 } } });
  }));
  state.preferences.active = "tp580fd6ace3343135";
  const settle = async (index: number) => { pending[index].resolve(pending[index].skin); await Promise.resolve(); };
  try {
    const show = setupSkins(state);
    show(true);
    const database = list.children[2], categories = database.children[1].children;
    expect(database.open).toBe(true);
    expect(categories.map(group => group.children[0].textContent)).toEqual(["Standard", "Connected", "Animated"]);
    expect(categories.map(group => group.open)).toEqual([false, false, true]);
    const row = categories[2].children[1].children[0];
    const visible = (isIntersecting: boolean) => intersect([{ target: row, isIntersecting }]);
    expect(pending).toHaveLength(0);
    visible(true); visible(false); visible(true);
    expect(pending).toHaveLength(2);
    await settle(0);
    expect(frames.size).toBe(0);
    await settle(1);
    expect(frames.size).toBe(1);
    const [id, callback] = [...frames][0];
    frames.delete(id); callback(0);
    expect(frames.size).toBe(1);
    visible(false);
    expect(frames.size).toBe(0);
    visible(true);
    expect(pending).toHaveLength(3);
    show(false);
    await settle(2);
    expect(frames.size).toBe(0);
    show(true);
    intersect([{ target: list.children[2].children[1].children[2].children[1].children[0], isIntersecting: true }]);
    await settle(3);
    expect(frames.size).toBe(1);
    show(true);
    expect(frames.size).toBe(0);
    show(false);
  } finally {
    globals.forEach((name, index) => {
      if (originals[index]) Object.defineProperty(globalThis, name, originals[index]!);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
});
