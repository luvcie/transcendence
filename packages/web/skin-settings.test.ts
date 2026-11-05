import { expect, spyOn, test } from "bun:test";
import { setupSkins } from "./src/skin-settings";
import { SkinState } from "./src/skin-state";
import type { LoadedSkin } from "./src/skin-loader";
import { Element, FakeDocument } from "./test-dom";

test("skin previews limit work, retain recent rows, and release older previews", async () => {
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
  const pending: { resolve: (skin: LoadedSkin) => void; reject: (error: Error) => void; skin: LoadedSkin }[] = [];
  const state = new SkinState(() => ({ getItem: () => null, setItem() {} }), def => new Promise((resolve, reject) => {
    pending.push({ resolve, reject, skin: { def, tile: 32, image: {} as HTMLCanvasElement, connected: true, animation: { frames: 2, delay: 30 } } });
  }));
  state.preferences.active = "tp580fd6ace3343135";
  const flush = () => new Promise(resolve => setTimeout(resolve, 0));
  const settle = async (index: number) => { pending[index].resolve(pending[index].skin); await flush(); };
  const clock = spyOn(performance, "now").mockReturnValue(0);
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
    const canvases = row.children[1].children;
    const draws = () => canvases.reduce((sum, canvas) => sum + canvas.images.length, 0);
    const painted = draws();
    const [id, callback] = [...frames][0];
    frames.delete(id); callback(0);
    expect(frames.size).toBe(1);
    expect(draws()).toBe(painted);
    clock.mockReturnValue(500);
    const [nextId, next] = [...frames][0];
    frames.delete(nextId); next(500);
    expect(draws()).toBe(painted + 28);
    visible(false);
    expect(frames.size).toBe(0);
    expect(canvases.every(canvas => canvas.width === 136)).toBe(true);
    visible(true);
    expect(canvases.every(canvas => canvas.width === 136)).toBe(true);
    expect(draws()).toBe(painted + 28);
    expect(row.children[2].textContent).toBe("");
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
    const options = list.children[2].children[1].children[2].children[1].children;
    intersect(options.slice(0, 4).map(target => ({ target, isIntersecting: true })));
    expect(pending).toHaveLength(6);
    intersect([{ target: options[2], isIntersecting: false }]);
    pending[4].reject(new Error("Preview unavailable"));
    await flush();
    expect(pending).toHaveLength(7);
    expect(pending[6].skin.def.label).toBe(options[3].children[0].children[0].textContent);
    pending[5].skin.animation = undefined;
    pending[5].skin.preview = pending[6].skin.preview = true;
    pending[5].skin.image = { src: "blob:static" } as HTMLImageElement;
    pending[6].skin.image = { src: "blob:animated" } as HTMLImageElement;
    await settle(5); await settle(6);
    expect((pending[5].skin.image as HTMLImageElement).src).toBe("");
    intersect([{ target: options[1], isIntersecting: false }]);
    intersect([{ target: options[1], isIntersecting: true }]);
    expect(pending).toHaveLength(7);
    expect(options[1].children[2].textContent).toBe("");
    intersect(options.map(target => ({ target, isIntersecting: false })));
    expect((pending[6].skin.image as HTMLImageElement).src).toBe("");
    const standard = list.children[2].children[1].children[0].children[1].children;
    for (const target of standard.slice(0, 97)) {
      intersect([{ target, isIntersecting: true }]);
      pending.at(-1)!.skin.animation = undefined;
      await settle(pending.length - 1);
      intersect([{ target, isIntersecting: false }]);
    }
    expect(standard[0].children[1].children.every(canvas => canvas.width === 0)).toBe(true);
    expect(standard[96].children[1].children.every(canvas => canvas.width === 136)).toBe(true);
    const loaded = pending.length;
    intersect([{ target: standard[96], isIntersecting: true }]);
    expect(pending).toHaveLength(loaded);
    show(false);
    expect(standard[96].children[1].children.every(canvas => canvas.width === 0)).toBe(true);
    expect(frames.size).toBe(0);
  } finally {
    clock.mockRestore();
    globals.forEach((name, index) => {
      if (originals[index]) Object.defineProperty(globalThis, name, originals[index]!);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
});
