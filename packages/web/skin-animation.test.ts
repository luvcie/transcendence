import { expect, spyOn, test } from "bun:test";
import { gifTiming, skinSourceAnimation } from "./src/skin-animation";
import { skinFrame } from "./src/tile-renderer";
import type { LoadedSkin } from "./src/skin-loader";

function gif(delays: number[]) {
  const bytes = [...new TextEncoder().encode("GIF89a"), 124, 0, 10, 0, 128, 0, 0, 0, 0, 0, 255, 255, 255,
    0x21, 0xfe, 3, 65, 66, 67, 0];
  for (const delay of delays) bytes.push(0x21, 0xf9, 4, 0, delay & 255, delay >> 8, 0, 0,
    0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x44, 1, 0);
  bytes.push(0x3b);
  return new Uint8Array(bytes).buffer;
}

test("GIF timing preserves frame durations and skips extension and image data blocks", () => {
  expect(gifTiming(gif([3, 4, 7]))).toEqual({ width: 124, height: 10, ends: [30, 70, 140] });
  expect(gifTiming(gif([0, 1, 2])).ends).toEqual([100, 200, 220]);
  for (const data of [new ArrayBuffer(0), gif([3]).slice(0, -1), gif([3]).slice(0, 27)]) expect(() => gifTiming(data)).toThrow();
  const invalid = new Uint8Array(gif([3])); invalid[28] = 5;
  expect(() => gifTiming(invalid.buffer)).toThrow();
});

test("source timing follows database paths for future GIFs and repeated preview cycles", async () => {
  const base = "https://you.have.fail/tetrioplus/data/";
  const fetch = spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(new Response(gif([3, 4, 3])))
    .mockResolvedValueOnce(new Response(gif([15, 17, 15, 17])))
    .mockResolvedValueOnce(new Response(gif([3, 4, 5])))
    .mockResolvedValueOnce(new Response(gif([3, 4, 3, 5])))
    .mockResolvedValueOnce(new Response("missing", { status: 404 }));
  try {
    expect(await skinSourceAnimation(base + "tpsefiles/skin/future/skin.gif.tpse", 3))
      .toMatchObject({ original: true, frameEnds: [30, 70, 100] });
    expect(fetch.mock.calls[0][0]).toBe("/api/skin-source?path=skin%2Ffuture%2Fskin.gif");
    expect(await skinSourceAnimation(base + "tpsefiles/unknown/future/pack.zip.tpse", 2))
      .toMatchObject({ original: false, frameEnds: [150, 320] });
    expect(fetch.mock.calls[1][0]).toBe("/api/skin-source?path=unknown%2Ffuture%2Fpack.zip.preview.gif");
    expect(await skinSourceAnimation(base + "tpsefiles/skin/future/mismatch.gif.tpse", 2)).toBeUndefined();
    expect(await skinSourceAnimation(base + "tpsefiles/unknown/future/uneven.zip.tpse", 2)).toBeUndefined();
    expect(await skinSourceAnimation(base + "tpsefiles/unknown/future/missing.zip.tpse", 2)).toBeUndefined();
    expect(await skinSourceAnimation("https://skins.test/custom.tpse", 2)).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(5);
  } finally { fetch.mockRestore(); }
});

test("animation follows source frame boundaries and wraps without changing the export fallback", () => {
  const skin = { animation: { frames: 3, delay: 30, frameEnds: [30, 70, 100] } } as LoadedSkin;
  const clock = spyOn(performance, "now");
  try {
    for (const [time, frame] of [[0, 0], [29, 0], [30, 1], [69, 1], [70, 2], [99, 2], [100, 0], [170, 2]]) {
      clock.mockReturnValue(time); expect(skinFrame(skin)).toBe(frame);
    }
    delete skin.animation!.frameEnds;
    clock.mockReturnValue(500); expect(skinFrame(skin)).toBe(1);
  } finally { clock.mockRestore(); }
});

test("original GIF timing can load without downloading an export, within the same frame limit", async () => {
  const fetch = spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(new Response(gif([3, 4, 3])))
    .mockResolvedValueOnce(new Response(gif(Array(65).fill(3))));
  const base = "https://you.have.fail/tetrioplus/data/tpsefiles/skin/future/";
  try {
    expect(await skinSourceAnimation(base + "skin.gif.tpse")).toMatchObject({ original: true, frameEnds: [30, 70, 100] });
    expect(await skinSourceAnimation(base + "pack.zip.tpse")).toBeUndefined();
    expect(await skinSourceAnimation(base + "long.gif.tpse")).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(2);
  } finally { fetch.mockRestore(); }
});
