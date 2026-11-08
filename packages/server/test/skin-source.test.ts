import { expect, spyOn, test } from "bun:test";
import { createApp } from "../src/app";
import { createSkinSource } from "../src/skin-source";

test("skin source relays gallery GIFs without storing or redirecting artwork", async () => {
  const app = createApp({ scheduled: false });
  const bytes = new TextEncoder().encode("GIF89a");
  const fetch = spyOn(globalThis, "fetch").mockResolvedValue(new Response(bytes));
  try {
    const response = await app.handle(new Request("http://localhost/api/skin-source?path=skin%2Ffuture%2Fanimation.gif"));
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(response.headers.get("content-type")).toBe("image/gif");
    expect(response.headers.get("cache-control")).toBe("public, max-age=86400");
    expect(String(fetch.mock.calls[0][0])).toBe("https://you.have.fail/tetrioplus/data/content/skin/future/animation.gif");
    expect(fetch.mock.calls[0][1]).toMatchObject({ redirect: "error" });
    for (const path of ["", "https://other.test/skin.gif", "//other.test/skin.gif", "../elsewhere.gif",
      "%2e%2e/elsewhere.gif", "skin/file.tpse", "skin/file.gif?redirect=1", "skin/file.gif#fragment"]) {
      expect((await app.handle(new Request(`http://localhost/api/skin-source?path=${encodeURIComponent(path)}`))).status).toBe(400);
    }
    expect(fetch).toHaveBeenCalledTimes(1);
  } finally { fetch.mockRestore(); }
});

test("skin source bounds downloads and releases capacity after failures", async () => {
  const source = createSkinSource();
  const fetch = spyOn(globalThis, "fetch");
  let cancelled = false;
  try {
    fetch.mockResolvedValueOnce(new Response(new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); },
      cancel() { cancelled = true; },
    })));
    expect((await source("skin/large.gif")).status).toBe(413);
    expect(cancelled).toBe(true);
    fetch.mockResolvedValueOnce(new Response(null, { status: 404 }));
    expect((await source("skin/missing.gif")).status).toBe(404);
    fetch.mockRejectedValueOnce(new Error("Redirect rejected"));
    expect((await source("skin/redirect.gif")).status).toBe(502);
    const finish: Array<(response: Response) => void> = [];
    for (let i = 0; i < 4; i++) fetch.mockReturnValueOnce(new Promise(resolve => { finish.push(resolve); }));
    const pending = Array.from({ length: 4 }, () => source("skin/queued.gif"));
    expect((await source("skin/over-capacity.gif")).status).toBe(503);
    finish.forEach(resolve => resolve(new Response("GIF89a")));
    expect((await Promise.all(pending)).map(response => response.status)).toEqual([200, 200, 200, 200]);
    fetch.mockResolvedValueOnce(new Response("GIF89a"));
    expect((await source("unknown/future/pack.zip.preview.gif")).status).toBe(200);
  } finally { fetch.mockRestore(); }
});
