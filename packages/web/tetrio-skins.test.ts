import { describe, expect, spyOn, test } from "bun:test";
import { BUILTIN_SKINS, customSkin } from "./src/skin-catalog";
import { createSkinLoader } from "./src/skin-loader";
import { parseSkinPreferences } from "./src/skin-preferences";
import { SkinState } from "./src/skin-state";
import { shareableSkinId, skinDefForId } from "./src/multiplayer-skins";
import { convertTetrioSkin, MAX_SKIN_EXPORT_BYTES, parseTetrioSkin } from "./src/tetrio-skins";
import { drawTile } from "./src/tile-renderer";

const url = "https://example.com/skin.png.tpse";
function png(width = 2048, height = width) {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  bytes.set([73, 72, 68, 82], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width); view.setUint32(20, height);
  return "data:image/png;base64," + btoa(String.fromCharCode(...bytes));
}
function image(width = 2048) {
  return { src: "", naturalWidth: width, naturalHeight: width, onload: null, onerror: null } as unknown as HTMLImageElement;
}
function canvas() {
  const draws: unknown[][] = [];
  const context = { imageSmoothingEnabled: true, drawImage: (...args: unknown[]) => draws.push(args) };
  return { draws, context, element: { width: 0, height: 0, getContext: () => context } as unknown as HTMLCanvasElement };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

describe("TETR.IO+ static skins", () => {
  test("accepts only bounded PNG atlases and ignores unrelated export settings", () => {
    expect(parseTetrioSkin({ skin: png(), keybinds: { move: "ignored" }, customSounds: "ignored" })).toBe(png());
    for (const value of [null, {}, { skin: "data:image/svg+xml,<svg/>" }, { skin: "data:image/png;base64,AQID" },
      { skin: "data:image/png;base64," + "A".repeat(MAX_SKIN_EXPORT_BYTES) },
      ...[0, 32, 100, 4096].map(size => ({ skin: png(size) })), { skin: png(2048, 1024) },
      { skin: png(), skinAnim: "data:image/png;base64,AQID" }, { skin: png(), skinAnimMeta: { frames: 2 } },
    ]) expect(() => parseTetrioSkin(value)).toThrow();
  });
  test("crops the seven piece colors into the existing nine-column layout without texture borders", () => {
    const atlas = image(), output = canvas();
    expect(convertTetrioSkin(atlas, () => output.element)).toBe(output.element);
    expect([output.element.width, output.element.height]).toEqual([828, 92]);
    expect(output.context.imageSmoothingEnabled).toBe(false);
    expect(output.draws.map(call => call.slice(1))).toEqual([
      [2, 290, 92, 92, 184, 0, 92, 92], [386, 290, 92, 92, 276, 0, 92, 92],
      [770, 290, 92, 92, 368, 0, 92, 92], [1154, 290, 92, 92, 460, 0, 92, 92],
      [2, 866, 92, 92, 552, 0, 92, 92], [386, 866, 92, 92, 644, 0, 92, 92],
      [770, 866, 92, 92, 736, 0, 92, 92],
    ]);
    const small = canvas();
    convertTetrioSkin(image(512), () => small.element);
    expect([small.element.width, small.element.height]).toEqual([198, 22]);
    expect(small.draws[0].slice(1)).toEqual([1, 73, 22, 22, 44, 0, 22, 22]);
    expect(() => convertTetrioSkin(image(4096), () => small.element)).toThrow();
  });
  test("catalog skins have creator credits and ids accepted by the existing multiplayer protocol", () => {
    const skins = BUILTIN_SKINS.filter(def => def.url?.includes("/tetrioplus/"));
    expect(skins.length).toBeGreaterThan(0);
    for (const def of skins) {
      expect(def.id).toMatch(/^[A-Za-z0-9]{1,32}$/);
      expect(shareableSkinId(def.id)).toBe(def.id);
      expect(skinDefForId(def.id)).toBe(def);
      expect(def.url).toEndWith(".tpse");
      expect(def.credit).toEndWith("(TETR.IO+)");
      expect(def.source).toContain("#skin-");
    }
    expect(new Set(BUILTIN_SKINS.map(def => def.id)).size).toBe(BUILTIN_SKINS.length);
  });
  test("deduplicates export downloads and caches the converted sheet used by the renderer", async () => {
    const fetch = spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({ skin: png() })));
    const created = deferred<HTMLImageElement>(), output = canvas();
    const load = createSkinLoader(() => { const img = image(); created.resolve(img); return img; }, 1000, () => output.element);
    try {
      const first = load(customSkin(url, 0)), second = load(customSkin(url, 0));
      const img = await created.promise;
      expect(img.src).toBe(png());
      img.onload!(new Event("load"));
      const [a, b] = await Promise.all([first, second]);
      expect(a!.image).toBe(output.element);
      expect(a!.image).toBe(b!.image);
      expect(a!.tile).toBe(92);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch.mock.calls[0][1]).toMatchObject({ credentials: "omit", referrerPolicy: "no-referrer" });
      await load(customSkin(url, 1));
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(output.draws).toHaveLength(7);
      const drawn: unknown[][] = [];
      const ctx = { drawImage: (...args: unknown[]) => drawn.push(args) } as unknown as CanvasRenderingContext2D;
      drawTile(ctx, 1, 0, 0, 30, a);
      expect(drawn[0]).toEqual([output.element, 184, 0, 92, 92, 0, 0, 30, 30]);
    } finally { fetch.mockRestore(); }
  });
  test("failed exports are evicted and a corrected link can be retried", async () => {
    const fetch = spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ skin: png(4096) })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ skin: png() })));
    const created = deferred<HTMLImageElement>(), output = canvas();
    const load = createSkinLoader(() => { const img = image(); created.resolve(img); return img; }, 1000, () => output.element);
    try {
      await expect(load(customSkin(url, 0))).rejects.toThrow("2048px");
      const retry = load(customSkin(url, 0));
      const img = await created.promise; img.onload!(new Event("load"));
      expect((await retry)!.tile).toBe(92);
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally { fetch.mockRestore(); }
  });
  test("custom exports persist as links and restore through the same loader", async () => {
    const fetch = spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({ skin: png() })));
    let raw: string | null = null;
    const storage = () => ({ getItem: () => raw, setItem: (_key: string, value: string) => { raw = value; } });
    const created = deferred<HTMLImageElement>(), output = canvas();
    const load = createSkinLoader(() => { const img = image(); created.resolve(img); return img; }, 1000, () => output.element);
    try {
      const state = new SkinState(storage, load);
      const added = state.add(url);
      const img = await created.promise; img.onload!(new Event("load"));
      expect(await added).toBe(true);
      expect(state.preferences).toEqual({ active: "custom:0", customs: [url] });
      expect(raw).toBe(JSON.stringify(state.preferences));
      expect(parseSkinPreferences(raw)).toEqual(state.preferences);
      const restored = new SkinState(storage, load);
      await restored.select(restored.preferences.active, false);
      expect(restored.loaded!.image).toBe(output.element);
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally { fetch.mockRestore(); }
  });
});
