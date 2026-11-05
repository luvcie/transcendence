import { describe, expect, spyOn, test } from "bun:test";
import { BUILTIN_SKINS, customSkin } from "./src/skin-catalog";
import { createSkinLoader, type LoadedSkin } from "./src/skin-loader";
import { parseSkinPreferences } from "./src/skin-preferences";
import { SkinState } from "./src/skin-state";
import { shareableSkinId, skinDefForId } from "./src/multiplayer-skins";
import { convertTetrioSkin, MAX_SKIN_EXPORT_BYTES, parseTetrioSkin } from "./src/tetrio-skins";
import { drawPiecePreview, drawTile, pieceConnections, renderSkinPreview } from "./src/tile-renderer";
import { drawBoard } from "./src/board-view";
import { createBoard, Piece, place, ROWS, type PieceId } from "@42tris/core";

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
  const context = { imageSmoothingEnabled: true, drawImage: (...args: unknown[]) => draws.push(args) };
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
  test("crops the seven piece colors into the existing nine-column layout without texture borders", async () => {
    const atlas = image(), output = canvas();
    expect(await convertTetrioSkin(atlas, () => output.element)).toBe(output.element);
    expect([output.element.width, output.element.height]).toEqual([288, 768]);
    expect(output.context.imageSmoothingEnabled).toBe(false);
    expect(output.draws).toHaveLength(168);
    expect(output.draws.slice(84, 91).map(call => call.slice(1))).toEqual([
      [2, 290, 92, 92, 64, 384, 32, 32], [386, 290, 92, 92, 96, 384, 32, 32],
      [770, 290, 92, 92, 128, 384, 32, 32], [1154, 290, 92, 92, 160, 384, 32, 32],
      [2, 866, 92, 92, 192, 384, 32, 32], [386, 866, 92, 92, 224, 384, 32, 32],
      [770, 866, 92, 92, 256, 384, 32, 32],
    ]);
    const small = canvas();
    await convertTetrioSkin(image(512), () => small.element);
    expect([small.element.width, small.element.height]).toEqual([198, 528]);
    expect(small.draws[84].slice(1)).toEqual([1, 73, 22, 22, 44, 264, 22, 22]);
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
    expect(output.draws).toHaveLength(168);
    let yielded = false;
    setTimeout(() => { yielded = output.draws.length < 22 * 168; }, 0);
    await conversion;
    expect(yielded).toBe(true);
    expect([output.element.width, output.element.height]).toEqual([4608, 1536]);
    expect(output.draws).toHaveLength(22 * 168);
    expect(output.draws[17 * 168].slice(1)).toEqual([1025, 1025, 46, 46, 352, 768, 32, 32]);
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
  test("compact previews keep the same piece artwork using one sixth of the crop operations", async () => {
    const atlas = image(16384, 2048), full = canvas(), compact = canvas();
    await convertTetrioSkin(atlas, () => full.element, 22);
    renderSkinPreview({ width: 16384, height: 2048 } as ImageBitmap, 22, (width, height) => {
      compact.element.width = width; compact.element.height = height;
      return compact.element as unknown as OffscreenCanvas;
    });
    expect([compact.element.width, compact.element.height]).toEqual([14336, 128]);
    expect(compact.draws).toHaveLength(22 * 28);
    const clock = spyOn(performance, "now").mockReturnValue(0);
    const skin: LoadedSkin = { def: customSkin(url, 0), image: full.element, tile: 32, connected: true,
      animation: { frames: 22, delay: 30 } };
    try {
      for (const frame of [0, 17, 21]) for (let piece = 1; piece <= 7; piece++) {
        clock.mockReturnValue(frame * 500);
        const output = canvas();
        drawPiecePreview(output.context as unknown as CanvasRenderingContext2D, piece as PieceId, 32, 136, 80, 0, skin);
        output.draws.forEach((draw, index) => {
          const row = Number(draw[2]) / 32 - Math.floor(frame / 16) * 24;
          const crop = full.draws[frame * 168 + row * 7 + piece - 1];
          const preview = compact.draws[frame * 28 + (piece - 1) * 4 + index];
          expect(preview.slice(1, 5)).toEqual(crop.slice(1, 5));
          expect(Number(preview[5]) - (frame % 16 * 7 + piece - 1) * 128).toBe(Number(draw[5]) - 4);
          expect(Number(preview[6]) - Math.floor(frame / 16) * 64).toBe(Number(draw[6]) - 8);
        });
      }
      clock.mockReturnValue(8500);
      const output = canvas();
      drawPiecePreview(output.context as unknown as CanvasRenderingContext2D, Piece.S, 32, 136, 80, 0,
        { ...skin, image: compact.element, preview: true });
      expect(output.draws).toEqual([[compact.element, 1280, 64, 128, 64, 4, 8, 128, 64]]);
    } finally { clock.mockRestore(); }
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
  test("animated tiles select the exported timing and frame grid while ghosts and garbage stay flat", () => {
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
      expect(output.draws).toHaveLength(2);
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
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch.mock.calls[0][1]).toMatchObject({ credentials: "omit", referrerPolicy: "no-referrer" });
      await load(customSkin(url, 1));
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(output.draws).toHaveLength(168);
      const drawn: unknown[][] = [];
      const ctx = { drawImage: (...args: unknown[]) => drawn.push(args) } as unknown as CanvasRenderingContext2D;
      drawTile(ctx, 1, 0, 0, 30, a);
      expect(drawn[0]).toEqual([output.element, 64, 384, 32, 32, 0, 0, 30, 30]);
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
      expect(restored.loaded!.animation).toEqual({ frames: 2, delay: 30 });
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally { fetch.mockRestore(); }
  });
});
