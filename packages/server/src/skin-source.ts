const ROOT = new URL("https://you.have.fail/tetrioplus/data/content/");
const MAX_BYTES = 16 * 1024 * 1024;

export function createSkinSource() {
  let active = 0;
  return async (path?: string) => {
    let url: URL;
    try { url = new URL(path ?? "", ROOT); }
    catch { return new Response("Invalid skin source.", { status: 400 }); }
    if (!path || path.length > 2048 || url.origin !== ROOT.origin || !url.pathname.startsWith(ROOT.pathname)
      || !url.pathname.toLowerCase().endsWith(".gif") || url.search || url.hash) {
      return new Response("Invalid skin source.", { status: 400 });
    }
    if (active >= 4) return new Response("Skin source is busy. Try again.", { status: 503 });
    active++;
    try {
      // The gallery allows CORS for exports, but not their original GIFs.
      const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(10_000) });
      if (!response.ok) return new Response("Skin source unavailable.", { status: response.status === 404 ? 404 : 502 });
      const reader = response.body?.getReader();
      if (!reader) return new Response("Skin source is empty.", { status: 502 });
      const chunks: Uint8Array<ArrayBuffer>[] = [];
      let length = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (length > MAX_BYTES) return new Response("Skin source is too large.", { status: 413 });
          chunks.push(value);
        }
      } finally { await reader.cancel(); }
      return new Response(new Blob(chunks), { headers: {
        "Content-Type": "image/gif", "X-Content-Type-Options": "nosniff", "Cache-Control": "public, max-age=86400",
      } });
    } catch {
      return new Response("Skin source unavailable.", { status: 502 });
    } finally { active--; }
  };
}
