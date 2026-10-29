import { describe, expect, test } from "bun:test";
import { MINOS, Piece, type PieceId } from "@42tris/core";
import { BUILTIN_SKINS, CLASSIC, customSkin } from "./src/skin-catalog";
import { createSkinLoader, sheetTile, SKIN_CACHE_LIMIT, type LoadedSkin } from "./src/skin-loader";
import { parseCustomSkinUrl, parseSkinPreferences, removeCustom } from "./src/skin-preferences";
import { SkinState } from "./src/skin-state";
import { COLORS, drawTile, joinedAbove, previewLayout } from "./src/tile-renderer";

const a = "https://example.com/a.png", b = "https://example.com/b.png";
const four = BUILTIN_SKINS.find(def => def.id === "four")!;
const tetrio = BUILTIN_SKINS.find(def => def.id === "tetrio")!;
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function storage() {
  let value: string | null = null;
  return { getItem: () => value, setItem: (_key: string, next: string) => { value = next; } };
}
function fakeImage() {
  return { src: "", naturalWidth: 288, naturalHeight: 64, onload: null, onerror: null } as unknown as HTMLImageElement;
}
function loaded(def = tetrio): LoadedSkin { return { def, image: fakeImage(), tile: 30 }; }

describe("skin preferences", () => {
  test("accepts HTTPS only, trims and rejects credentials, malformed and oversized links", () => {
    expect(parseCustomSkinUrl(` ${a} `)).toBe(a);
    for (const url of ["http://example.com/x", "data:image/png;base64,x", "javascript:alert(1)",
      "https://u:p@example.com/x", "https://", "https://example.com/" + "x".repeat(512),
      "https://example.com/" + "é".repeat(100), null]) {
      expect(parseCustomSkinUrl(url)).toBeUndefined();
    }
  });
  test("validates persisted data and resolves unknown or missing selections", () => {
    const defaults = { active: "classic", customs: [] };
    for (const raw of [null, "{", "null", "[]", JSON.stringify({ active: "classic", customs: [a, a] }),
      JSON.stringify({ active: "classic", customs: ["http://example.com"] }),
      JSON.stringify({ active: "classic", customs: Array.from({ length: 13 }, (_, i) => a + i) })]) {
      expect(parseSkinPreferences(raw)).toEqual(defaults);
    }
    expect(parseSkinPreferences(JSON.stringify({ active: "custom:1", customs: [a] }))).toEqual({ active: "classic", customs: [a] });
    expect(parseSkinPreferences(JSON.stringify({ active: "unknown", customs: [] }))).toEqual(defaults);
    expect(parseSkinPreferences(JSON.stringify({ active: "four", customs: [a] }))).toEqual({ active: "four", customs: [a] });
  });
  test("removal preserves the selected URL when indexes shift", () => {
    expect(removeCustom({ active: "custom:1", customs: [a, b] }, 0)).toEqual({ active: "custom:0", customs: [b] });
    expect(removeCustom({ active: "custom:1", customs: [a, b] }, 1)).toEqual({ active: "classic", customs: [a] });
    expect(removeCustom({ active: "four", customs: [a] }, 0)).toEqual({ active: "four", customs: [] });
  });
});

describe("sheet layout and rendering", () => {
  test("catalog includes all 65 image skins, fixed tiles and FOUR join metadata", () => {
    expect(BUILTIN_SKINS).toHaveLength(66);
    expect(new Set(BUILTIN_SKINS.map(def => def.id)).size).toBe(66);
    expect(tetrio.tile).toBe(30);
    expect(BUILTIN_SKINS.find(def => def.id === "ppt")!.tile).toBe(36);
    expect(four.join).toEqual({ open: 0, joined: 1 });
  });
  test("validates inferred and explicit sizes and required joined rows", () => {
    expect(sheetTile(288, 32, customSkin(a, 0))).toBe(32);
    expect(sheetTile(270, 30, tetrio)).toBe(30);
    expect(sheetTile(288, 64, four)).toBe(32);
    for (const [w, h, def] of [[287, 32, CLASSIC], [288, 31, CLASSIC], [288, 32, four],
      [288, 32, tetrio], [0, 0, CLASSIC], [9000, 1000, CLASSIC]] as const) {
      expect(() => sheetTile(w, h, def)).toThrow();
    }
  });
  test("centers each spawn piece and detects vertical neighbors", () => {
    for (let piece = 1; piece <= 7; piece++) {
      const minos = MINOS[piece as PieceId][0];
      const offset = previewLayout(piece as PieceId, 150, 90, 30);
      const xs = [0, 2, 4, 6].map(i => offset.x + minos[i] * 30);
      const ys = [1, 3, 5, 7].map(i => offset.y + minos[i] * 30);
      expect(Math.min(...xs)).toBe(150 - Math.max(...xs) - 30);
      expect(Math.min(...ys)).toBe(90 - Math.max(...ys) - 30);
    }
    expect(joinedAbove([0, 0, 0, 1, 1, 1, 2, 1], 2)).toBe(true);
    expect(joinedAbove([0, 0, 0, 1, 1, 1, 2, 1], 4)).toBe(false);
  });
  test("maps Z2 through T8, uses joined rows, never sprites ghosts or garbage", () => {
    const sprites: unknown[][] = [], fills: unknown[][] = [];
    const ctx = { fillStyle: "", globalAlpha: 0.25, drawImage: (...args: unknown[]) => sprites.push(args),
      fillRect: (...args: unknown[]) => fills.push(args) } as unknown as CanvasRenderingContext2D;
    const skin = { ...loaded(four), tile: 32 };
    for (let id = 1; id <= 7; id++) {
      drawTile(ctx, id, 10, 20, 30, skin, true);
      expect(sprites.at(-1)!.slice(1)).toEqual([(id + 1) * 32, 32, 32, 32, 10, 20, 30, 30]);
      drawTile(ctx, id, 10, 20, 30, skin, true, true);
      expect(ctx.fillStyle).toBe(COLORS[id]);
    }
    drawTile(ctx, 8, 0, 0, 30, skin);
    expect(ctx.fillStyle).toBe("#6b7280");
    expect(ctx.globalAlpha).toBe(0.25);
    expect(sprites).toHaveLength(7);
    expect(fills).toHaveLength(8);
    expect(COLORS[Piece.L]).toBe("#f97316");
    expect(COLORS[Piece.O]).toBe("#eab308");
  });
});

describe("image loader", () => {
  test("invalid dimensions are evicted so a corrected same-URL image can retry", async () => {
    const images: HTMLImageElement[] = [];
    const load = createSkinLoader(() => {
      const img = fakeImage();
      if (!images.length) Object.defineProperty(img, "naturalWidth", { value: 287 });
      images.push(img);
      return img;
    });
    const first = load(four), shared = load(four);
    expect(images).toHaveLength(1);
    const failures = Promise.all([first.catch(error => error), shared.catch(error => error)]);
    images[0].onload!(new Event("load"));
    for (const error of await failures) {
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain("nine equal");
    }
    const retry = load(four);
    expect(images).toHaveLength(2);
    images[1].onload!(new Event("load"));
    expect((await retry)!.tile).toBe(32);
    expect((await load(four))!.image).toBe(images[1]);
  });
  test("bounds settled images without evicting inflight requests or clearing active references", async () => {
    const images: HTMLImageElement[] = [];
    const load = createSkinLoader(() => { const img = fakeImage(); images.push(img); return img; });
    const pending = load(four);
    let active: LoadedSkin | undefined;
    for (let i = 0; i <= SKIN_CACHE_LIMIT; i++) {
      const request = load(customSkin(`${a}?${i}`, i));
      images.at(-1)!.onload!(new Event("load"));
      const result = await request;
      if (i === 0) active = result;
    }
    const count = images.length;
    const shared = load(four);
    expect(images).toHaveLength(count);
    images[0].onload!(new Event("load"));
    expect((await pending)!.image).toBe((await shared)!.image);
    expect(active!.image.src).toBe(`${a}?0`);
    expect(active!.image.naturalWidth).toBe(288);
    await load(customSkin(`${a}?${SKIN_CACHE_LIMIT}`, 0));
    expect(images).toHaveLength(count);
    const evicted = load(customSkin(`${a}?0`, 0));
    expect(images).toHaveLength(count + 1);
    images.at(-1)!.onload!(new Event("load"));
    expect((await evicted)!.image).not.toBe(active!.image);
  });
  test("deduplicates inflight loads and caches images while validating each definition", async () => {
    const images: HTMLImageElement[] = [];
    const load = createSkinLoader(() => { const img = fakeImage(); images.push(img); return img; });
    const first = load(four), second = load(four);
    expect(images).toHaveLength(1);
    images[0].onload!(new Event("load"));
    expect((await first)!.image).toBe((await second)!.image);
    await load(four);
    expect(images).toHaveLength(1);
    await expect(load({ ...four, tile: 30 })).rejects.toThrow("nine equal");
  });
  test("errors clear inflight cache for retry", async () => {
    const images: HTMLImageElement[] = [];
    const load = createSkinLoader(() => { const img = fakeImage(); images.push(img); return img; });
    const failed = load(four);
    images[0].onerror!(new Event("error"));
    await expect(failed).rejects.toThrow("could not load");
    expect(images[0].onload).toBeNull();
    const retry = load(four);
    expect(images).toHaveLength(2);
    images[1].onload!(new Event("load"));
    expect((await retry)!.tile).toBe(32);
  });
  test("timeouts detach handlers and permit retry", async () => {
    const images: HTMLImageElement[] = [];
    const load = createSkinLoader(() => { const img = fakeImage(); images.push(img); return img; }, 5);
    await expect(load(four)).rejects.toThrow("timed out");
    expect(images[0].onload).toBeNull();
    expect(images[0].src).toBe("");
    const retry = load(four);
    images[1].onload!(new Event("load"));
    await retry;
  });
});

describe("selection and persistence races", () => {
  test("late success and failure cannot overwrite a newer selection", async () => {
    const old = deferred<LoadedSkin | undefined>();
    const store = storage();
    const state = new SkinState(() => store, def => def.id === "tetrio" ? old.promise : Promise.resolve(undefined));
    const pending = state.select("tetrio");
    await state.select("classic");
    old.resolve(loaded()); await pending;
    expect(state.loaded).toBeUndefined();
    expect(parseSkinPreferences(store.getItem()).active).toBe("classic");
    const failure = deferred<LoadedSkin | undefined>();
    const other = new SkinState(() => store, def => def.id === "tetrio" ? failure.promise : Promise.resolve(undefined));
    const failing = other.select("tetrio"); await other.select("classic");
    failure.reject(new Error("old failure")); await failing;
    expect(other.message).not.toContain("old failure");
  });
  test("storage exceptions preserve session selection and custom additions", async () => {
    const state = new SkinState(() => { throw new Error("blocked"); }, async def => def.url ? loaded(def) : undefined);
    expect(await state.add(a)).toBe(true);
    expect(state.preferences).toEqual({ active: "custom:0", customs: [a] });
    expect(state.loaded!.def.url).toBe(a);
    expect(state.message).toContain("session");
    await state.select("four");
    expect(state.loaded!.def.id).toBe("four");
    expect(state.preferences.customs).toEqual([a]);
  });
  test("custom validation cannot replace a later choice or resurrect removed links", async () => {
    const pending = deferred<LoadedSkin | undefined>();
    const state = new SkinState(storage, def => def.url === a ? pending.promise : Promise.resolve(undefined));
    const add = state.add(a); await state.select("classic");
    pending.resolve(loaded(customSkin(a, 0)));
    expect(await add).toBe(false);
    expect(state.preferences.customs).toEqual([]);
  });
  test("removing a selected custom invalidates its outstanding load", async () => {
    const pending = deferred<LoadedSkin | undefined>();
    const store = storage();
    store.setItem("", JSON.stringify({ active: "custom:0", customs: [a] }));
    const state = new SkinState(() => store, def => def.url ? pending.promise : Promise.resolve(undefined));
    const selection = state.select("custom:0");
    await state.remove(0);
    pending.resolve(loaded(customSkin(a, 0))); await selection;
    expect(state.loaded).toBeUndefined();
    expect(parseSkinPreferences(store.getItem())).toEqual({ active: "classic", customs: [] });
  });
  test("failed custom addition preserves the previous skin", async () => {
    const state = new SkinState(storage, async def => {
      if (def.url === a) throw new Error("invalid dimensions");
      return loaded(def);
    });
    await state.select("four");
    expect(await state.add(a)).toBe(false);
    expect(state.preferences.active).toBe("four");
    expect(state.loaded!.def.id).toBe("four");
    expect(state.preferences.customs).toEqual([]);
  });
  test("closing the tab cancels additions without canceling a selected image load", async () => {
    const pending = deferred<LoadedSkin | undefined>();
    const state = new SkinState(storage, () => pending.promise);
    const selection = state.select("tetrio"); state.cancelPendingAdd();
    pending.resolve(loaded()); await selection;
    expect(state.loaded!.def.id).toBe("tetrio");
    const added = state.add(a); state.cancelPendingAdd();
    expect(await added).toBe(false);
  });
  test("failed selection falls back and retry succeeds", async () => {
    let fails = true;
    const state = new SkinState(storage, async def => { if (fails) throw new Error("offline"); return loaded(def); });
    await state.select("four");
    expect(state.loaded).toBeUndefined(); expect(state.message).toContain("Classic");
    fails = false; await state.select("four");
    expect(state.loaded!.def.id).toBe("four");
  });
  test("custom additions reject duplicates and enforce the 12-link cap", async () => {
    const state = new SkinState(storage, async def => loaded(def));
    expect(await state.add(a)).toBe(true);
    expect(await state.add(a)).toBe(false);
    for (let i = 1; i < 12; i++) expect(await state.add(a + i)).toBe(true);
    expect(await state.add(b)).toBe(false);
    expect(state.preferences.customs).toHaveLength(12);
  });
});
