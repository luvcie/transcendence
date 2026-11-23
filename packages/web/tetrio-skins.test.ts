import { describe, expect, spyOn, test } from "bun:test";
import { BUILTIN_SKINS, customSkin } from "./src/skin-catalog";
import { createSkinLoader, type LoadedSkin } from "./src/skin-loader";
import { parseSkinPreferences } from "./src/skin-preferences";
import { SkinState } from "./src/skin-state";
import { shareableSkinId, skinDefForId } from "./src/multiplayer-skins";
import { convertTetrioSkin, MAX_SKIN_EXPORT_BYTES, parseTetrioSkin } from "./src/tetrio-skins";
import { drawTile, pieceConnections } from "./src/tile-renderer";
import { drawTetrioFrame } from "./src/skin-atlas";
import { drawBoard } from "./src/board-view";
import { createBoard, Piece, place, ROWS } from "@42tris/core";

const url = "https://example.com/skin.png.tpse";
function png(width = 2048, height = width) {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  bytes.set([73, 72, 68, 82], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width); view.setUint32(20, height);
  return "data:image/png;base64," + btoa(String.fromCharCode(...bytes));
}
function image(width = 2048, height = width) {
  return { src: "", naturalWidth: width, naturalHeight: height, onload: null, onerror: null } as unknown as HTMLImageElement;
}
function canvas() {
  const draws: unknown[][] = [];
  const context = { imageSmoothingEnabled: true, drawImage: (...args: unknown[]) => draws.push(args),
    clearRect() {}, getImageData: () => ({ data: new Uint8ClampedArray(224 * 768 * 4) }),
    createImageData: () => ({ data: new Uint8ClampedArray(32 * 32 * 4) }), putImageData() {},
  };
  return { draws, context, element: { width: 0, height: 0, getContext: () => context } as unknown as HTMLCanvasElement };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

describe("TETR.IO+ skins", () => {
  test("accepts only bounded PNG atlases and ignores unrelated export settings", () => {
    expect(parseTetrioSkin({ skin: png(), keybinds: { move: "ignored" }, customSounds: "ignored" }))
      .toEqual({ image: png(), frames: 1, delay: 0 });
    for (const value of [null, {}, { skin: "data:image/svg+xml,<svg/>" }, { skin: "data:image/png;base64,AQID" },
      { skin: "data:image/png;base64," + "A".repeat(MAX_SKIN_EXPORT_BYTES) },
      ...[0, 32, 100, 4096].map(size => ({ skin: png(size) })), { skin: png(2048, 1024) },
      { skin: png(), skinAnim: "data:image/png;base64,AQID" }, { skin: png(), skinAnimMeta: { frames: 2 } },
    ]) expect(() => parseTetrioSkin(value)).toThrow();
  });
  test("keeps a half-size ghost atlas and drops a mismatched one without failing the skin", () => {
    expect(parseTetrioSkin({ skin: png(), ghost: png(1024) })).toEqual({ image: png(), frames: 1, delay: 0, ghost: png(1024) });
    for (const ghost of [png(2048), png(1024, 512), "data:image/png;base64,AQID", 7]) {
      expect(parseTetrioSkin({ skin: png(), ghost })).toEqual({ image: png(), frames: 1, delay: 0 });
    }
    const animated = { skin: png(), ghost: png(1024), skinAnim: png(16384, 2048), skinAnimMeta: { frames: 22, delay: 30 },
      ghostAnim: png(8192, 1024), ghostAnimMeta: { frames: 22, delay: 30 } };
    expect(parseTetrioSkin(animated).ghost).toBe(animated.ghostAnim);
    expect(parseTetrioSkin({ ...animated, ghostAnimMeta: { frames: 11, delay: 30 } }).ghost).toBeUndefined();
  });
  test("crops the ghost atlas into column 1 for every connection, frame by frame", async () => {
    const output = canvas();
    await convertTetrioSkin(image(), () => output.element, 1, image(1024));
    expect(output.draws).toHaveLength(216);
    expect(output.draws[12 * 9 + 8].slice(1)).toEqual([2, 290, 92, 92, 32, 384, 32, 32]);
    const packed = canvas();
    drawTetrioFrame(packed.context as unknown as CanvasRenderingContext2D, image(16384, 2048), 1024, 17, 22, 32, image(8192, 1024));
    expect(packed.draws).toHaveLength(216);
    expect(packed.draws[8].slice(1)).toEqual([513, 513, 46, 46, 256, 0, 32, 32]);
    expect(packed.draws[13 * 9 + 8].slice(1)).toEqual([513 + 48, 513 + 144, 46, 46, 256, 13 * 32, 32, 32]);
  });
  test("ghosts use the skin's ghost tiles with their connections, flat colors without them", () => {
    const draws: unknown[][] = [], fills: unknown[] = [];
    const ctx = { set fillStyle(color: string) { fills.push(color); }, fillRect: (...args: unknown[]) => fills.push(args),
      drawImage: (...args: unknown[]) => draws.push(args) } as unknown as CanvasRenderingContext2D;
    const sheet: LoadedSkin = { def: customSkin(url, 0), image: canvas().element, tile: 32, connected: true };
    drawTile(ctx, 6, 5, 6, 30, sheet, 22, true);
    expect(draws).toHaveLength(0);
    expect(fills).toEqual(["#3b82f6", [5, 6, 30, 30]]);
    drawTile(ctx, 6, 5, 6, 30, { ...sheet, ghost: true }, 22, true);
    expect(draws[0].slice(1)).toEqual([32, 512, 32, 32, 5, 6, 30, 30]);
    const tiles = new Uint16Array(216).map((_, i) => i);
    drawTile(ctx, 6, 0, 0, 30, { ...sheet, image: { width: 32 * 15 } as HTMLCanvasElement, tiles, ghost: true }, 22, true);
    expect(draws[1].slice(1, 3)).toEqual([(16 * 9 + 8) % 15 * 32, Math.floor((16 * 9 + 8) / 15) * 32]);
    drawTile(ctx, 6, 0, 0, 30, { ...sheet, tiles }, 22, true);
    expect(draws).toHaveLength(2);
    expect(fills).toHaveLength(4);
  });
  test("crops the seven piece colors and the lone garbage tile into the nine-column layout without texture borders", async () => {
    const atlas = image(), output = canvas();
    expect(await convertTetrioSkin(atlas, () => output.element)).toBe(output.element);
    expect([output.element.width, output.element.height]).toEqual([288, 768]);
    expect(output.context.imageSmoothingEnabled).toBe(false);
    expect(output.draws).toHaveLength(192);
    expect(output.draws.slice(96, 104).map(call => call.slice(1))).toEqual([
      [2, 290, 92, 92, 64, 384, 32, 32], [386, 290, 92, 92, 96, 384, 32, 32],
      [770, 290, 92, 92, 128, 384, 32, 32], [1154, 290, 92, 92, 160, 384, 32, 32],
      [2, 866, 92, 92, 192, 384, 32, 32], [386, 866, 92, 92, 224, 384, 32, 32],
      [770, 866, 92, 92, 256, 384, 32, 32], [1538, 290, 92, 92, 0, 384, 32, 32],
    ]);
    const small = canvas();
    await convertTetrioSkin(image(512), () => small.element);
    expect([small.element.width, small.element.height]).toEqual([198, 528]);
    expect(small.draws[96].slice(1)).toEqual([1, 73, 22, 22, 44, 264, 22, 22]);
    await expect(convertTetrioSkin(image(4096), () => small.element)).rejects.toThrow();
  });
  test("validates animation metadata and dimensions, then packs frames while yielding to other tasks", async () => {
    const data = { skin: png(), skinAnim: png(16384, 2048), skinAnimMeta: { frames: 22, delay: 30 } };
    expect(parseTetrioSkin(data)).toEqual({ image: data.skinAnim, frames: 22, delay: 30 });
    for (const meta of [{ frames: 0, delay: 30 }, { frames: 65, delay: 30 }, { frames: 1.5, delay: 30 },
      { frames: 22, delay: 0 }, { frames: 22, delay: Infinity }, { frames: 22, delay: NaN }]) {
      expect(() => parseTetrioSkin({ ...data, skinAnimMeta: meta })).toThrow();
    }
    expect(() => parseTetrioSkin({ ...data, skinAnim: png(16384, 1024) })).toThrow("dimensions");
    const output = canvas();
    const conversion = convertTetrioSkin(image(16384, 2048), () => output.element, 22);
    expect(output.draws).toHaveLength(192);
    let yielded = false;
    setTimeout(() => { yielded = output.draws.length < 22 * 192; }, 0);
    await conversion;
    expect(yielded).toBe(true);
    expect([output.element.width, output.element.height]).toEqual([4608, 1536]);
    expect(output.draws).toHaveLength(22 * 192);
    expect(output.draws[17 * 192].slice(1)).toEqual([1025, 1025, 46, 46, 352, 768, 32, 32]);
  });
  test("distinguishes isolated tiles, straight joins, inner corners, and filled square corners", () => {
    expect(pieceConnections([0, 0], 0)).toBe(0);
    expect(pieceConnections([0, 0, 1, 0, 2, 0, 3, 0], 2)).toBe(5);
    expect(pieceConnections([0, 0, 1, 0, 0, 1, 2, 0], 0)).toBe(22);
    expect(pieceConnections([0, 0, 1, 0, 0, 1, 1, 1], 0)).toBe(6);
    const output = canvas();
    const skin: LoadedSkin = { def: customSkin(url, 0), image: output.element, tile: 32, connected: true };
    const ctx = { drawImage: (...args: unknown[]) => output.draws.push(args) } as unknown as CanvasRenderingContext2D;
    for (const mask of [0, 5, 22, 6]) drawTile(ctx, 1, 0, 0, 30, skin, mask);
    expect(output.draws.map(call => call[2])).toEqual([384, 448, 512, 32]);
  });
  test("compact atlas preparation keeps every frame, piece, and connection crop", async () => {
    const atlas = image(16384, 2048), full = canvas();
    await convertTetrioSkin(atlas, () => full.element, 22);
    for (const frame of [0, 17, 21]) {
      const packed = canvas();
      drawTetrioFrame(packed.context as unknown as CanvasRenderingContext2D, atlas, 1024, frame, 22);
      expect(packed.draws).toHaveLength(192);
      packed.draws.forEach((draw, i) => {
        expect(draw.slice(1, 5)).toEqual(full.draws[frame * 192 + i].slice(1, 5));
        expect(draw.slice(5)).toEqual([i % 8 * 32, Math.floor(i / 8) * 32, 32, 32]);
      });
    }
  });
  test("touching S pieces keep their original tiles instead of creating transparent four-way joins", () => {
    for (const width of [4, 10, 12]) {
      const board = createBoard(width), hidden = ROWS - 20, output = canvas();
      const skin: LoadedSkin = { def: customSkin(url, 0), image: output.element, tile: 32, connected: true };
      const ctx = { canvas: { width: width * 30, height: 600 }, clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
        drawImage: (...args: unknown[]) => output.draws.push(args) } as unknown as CanvasRenderingContext2D;
      const view = { board, piece: Piece.T, rot: 0, x: 0, y: 0, starting: true, topOut: false };
      board[hidden * width + width - 1] = 1;
      board[(hidden + 1) * width] = 1;
      drawBoard(ctx, view, skin);
      expect(output.draws.map(call => call[2])).toEqual([384, 384]);
      output.draws.length = 0;
      board.fill(0);
      place(board, Piece.S, 1, 0, 24);
      place(board, Piece.S, 3, 0, 25);
      const before = board.slice();
      drawBoard(ctx, view, skin);
      expect(output.draws.map(call => call[2])).toEqual([0, 0, 640, 544, 640, 544, 256, 256]);
      expect(board).toEqual(before);
    }
  });
  test("animated tiles select the exported timing and frame grid while ghosts stay flat", () => {
    const output = canvas(), clock = spyOn(performance, "now").mockReturnValue(8500);
    const skin: LoadedSkin = { def: customSkin(url, 0), image: output.element, tile: 32, connected: true,
      animation: { frames: 22, delay: 30 } };
    const ctx = { fillRect() {}, drawImage: (...args: unknown[]) => output.draws.push(args) } as unknown as CanvasRenderingContext2D;
    try {
      drawTile(ctx, 1, 0, 0, 30, skin, 22);
      expect(output.draws[0].slice(1, 3)).toEqual([352, 1280]);
      clock.mockReturnValue(11000);
      drawTile(ctx, 1, 0, 0, 30, skin, 22);
      expect(output.draws[1].slice(1, 3)).toEqual([64, 512]);
      drawTile(ctx, 1, 0, 0, 30, skin, 22, true);
      drawTile(ctx, 8, 0, 0, 30, skin);
      expect(output.draws).toHaveLength(3);
      expect(output.draws[2].slice(1, 3)).toEqual([0, 384]);
    } finally { clock.mockRestore(); }
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
      expect(def.source).toMatch(/#(?:skin|unknown)-/);
      expect(["Standard", "Connected", "Animated"]).toContain(def.category);
    }
    expect(skinDefForId("tp459e828d920d4b93")!.category).toBe("Standard");
    expect(skinDefForId("tpd837cae3109a466c")!.category).toBe("Connected");
    expect(skinDefForId("tp580fd6ace3343135")!.category).toBe("Animated");
    expect(skinDefForId("tpa8d67ffdc9bb1323")!.category).toBe("Connected");
    expect(skinDefForId("tp511e98cdcc535d63")!.category).toBe("Standard");
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
      expect(a!.tile).toBe(32);
      expect(a!.connected).toBe(true);
      expect(a!.ghost).toBe(false);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch.mock.calls[0][1]).toMatchObject({ credentials: "omit", referrerPolicy: "no-referrer" });
      await load(customSkin(url, 1));
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(output.draws).toHaveLength(192);
      const drawn: unknown[][] = [];
      const ctx = { drawImage: (...args: unknown[]) => drawn.push(args) } as unknown as CanvasRenderingContext2D;
      drawTile(ctx, 1, 0, 0, 30, a);
      expect(drawn[0]).toEqual([output.element, 64, 384, 32, 32, 0, 0, 30, 30]);
    } finally { fetch.mockRestore(); }
  });
  test("an export with a ghost atlas loads it next to the skin and draws ghosts from it", async () => {
    const fetch = spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({ skin: png(), ghost: png(1024) })));
    const images: HTMLImageElement[] = [], output = canvas();
    const load = createSkinLoader(() => {
      const img = image(images.length ? 1024 : 2048);
      images.push(img);
      queueMicrotask(() => img.onload!(new Event("load")));
      return img;
    }, 1000, () => output.element);
    try {
      const skin = await load(customSkin(url, 0));
      expect(images.map(img => img.src)).toEqual(["", ""]);
      expect(output.draws.filter(call => call[0] === images[1])).toHaveLength(24);
      expect(skin!.ghost).toBe(true);
      const drawn: unknown[][] = [];
      drawTile({ drawImage: (...args: unknown[]) => drawn.push(args) } as unknown as CanvasRenderingContext2D, 1, 0, 0, 30, skin, 0, true);
      expect(drawn[0].slice(0, 3)).toEqual([output.element, 32, 384]);
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
      expect((await retry)!.tile).toBe(32);
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally { fetch.mockRestore(); }
  });
  test("custom animated exports persist as links and restore through the same loader", async () => {
    const fetch = spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({ skin: png(),
      skinAnim: png(2048, 1024), skinAnimMeta: { frames: 2, delay: 30 } })));
    let raw: string | null = null;
    const storage = () => ({ getItem: () => raw, setItem: (_key: string, value: string) => { raw = value; } });
    const created = deferred<HTMLImageElement>(), output = canvas();
    const load = createSkinLoader(() => { const img = image(2048, 1024); created.resolve(img); return img; }, 1000, () => output.element);
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
      expect(restored.loaded!.animation).toMatchObject({ frames: 2, delay: 30 });
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally { fetch.mockRestore(); }
  });
});
