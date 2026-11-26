import { expect, spyOn, test } from "bun:test";
import { loadSurgeIcon } from "./src/surge-icon";

function board(width = 512, height = width) {
  const bytes = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 0, 0, 0, 0, 0);
  const header = new DataView(bytes.buffer);
  header.setUint32(16, width);
  header.setUint32(20, height);
  return btoa(String.fromCharCode(...bytes));
}

test("loads the known gallery export and crops only its Surge sprite", async () => {
  const fetch = spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json({
    board: "data:application/octet-stream;base64," + board(), skin: "ignored",
  }));
  try {
    const draws: unknown[][] = [];
    const canvas = {
      width: 0, height: 0,
      getContext: () => ({ drawImage: (...args: unknown[]) => draws.push(args) }),
      toDataURL: () => "data:image/png;base64,crop",
    } as unknown as HTMLCanvasElement;
    const image = { src: "", async decode() {} } as HTMLImageElement;
    expect(await loadSurgeIcon(() => image, () => canvas)).toBe("data:image/png;base64,crop");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe("https://you.have.fail/tetrioplus/data/tpsefiles/unknown/AGoatt/Cyclone_Surge_Icon.zip.tpse");
    expect(fetch.mock.calls[0][1]).toMatchObject({ credentials: "omit", referrerPolicy: "no-referrer" });
    expect(image.src).toBe("data:image/png;base64," + board());
    expect([canvas.width, canvas.height]).toEqual([85, 82]);
    expect(draws).toEqual([[image, 6, 220, 85, 82, 0, 0, 85, 82]]);
  } finally { fetch.mockRestore(); }
});

test("rejects invalid board payloads before decoding", async () => {
  const fetch = spyOn(globalThis, "fetch");
  try {
    let decoded = 0;
    const makeImage = () => { decoded++; return { src: "", async decode() {} } as HTMLImageElement; };
    for (const value of [undefined, "data:image/svg+xml,<svg/>", "data:image/png;base64,AQID",
      "data:application/octet-stream;base64," + board(512, 1024)]) {
      fetch.mockResolvedValueOnce(Response.json({ board: value }));
      await expect(loadSurgeIcon(makeImage)).rejects.toThrow();
    }
    expect(decoded).toBe(0);
  } finally { fetch.mockRestore(); }
});
