import { fetchExternalFile } from "./external-file";
import { MAX_SKIN_EXPORT_BYTES } from "./tetrio-skins";

export function gifTiming(data: ArrayBuffer) {
  const bytes = new Uint8Array(data), view = new DataView(data);
  let at = 13, delay = 100, elapsed = 0;
  const ends: number[] = [];
  const require = (length: number) => {
    if (at + length > bytes.length) throw new Error("Incomplete skin GIF.");
  };
  const blocks = () => {
    for (;;) {
      require(1);
      const size = bytes[at++];
      require(size); at += size;
      if (!size) return;
    }
  };
  if (bytes.length < 13 || !/^GIF8[79]a$/.test(new TextDecoder().decode(bytes.subarray(0, 6)))) throw new Error("Invalid skin GIF.");
  const width = view.getUint16(6, true), height = view.getUint16(8, true);
  if (!width || !height || width * height > 16 * 1024 * 1024) throw new Error("Skin GIF is too large.");
  if (bytes[10] & 128) at += 3 * (2 << (bytes[10] & 7));
  for (;;) {
    require(1);
    const type = bytes[at++];
    if (type === 0x3b && ends.length) return { width, height, ends };
    if (type === 0x21) {
      require(1);
      if (bytes[at++] === 0xf9) {
        require(6);
        if (bytes[at] !== 4 || bytes[at + 5] !== 0) throw new Error("Invalid skin GIF timing.");
        const ticks = view.getUint16(at + 2, true);
        delay = ticks < 2 ? 100 : ticks * 10;
        at += 6;
      } else blocks();
    } else if (type === 0x2c) {
      require(9);
      const packed = bytes[at + 8]; at += 9;
      if (packed & 128) at += 3 * (2 << (packed & 7));
      require(1); at++; blocks();
      elapsed += delay; ends.push(elapsed); delay = 100;
      if (ends.length > 4096) throw new Error("Skin GIF has too many frames.");
    } else throw new Error("Invalid skin GIF block.");
  }
}

export async function skinSourceAnimation(url: string, frames?: number) {
  const source = new URL(url);
  if (source.origin !== "https://you.have.fail" || !source.pathname.startsWith("/tetrioplus/data/tpsefiles/")) return;
  source.pathname = source.pathname.replace("/tpsefiles/", "/content/").replace(/\.tpse$/i, "");
  const original = source.pathname.toLowerCase().endsWith(".gif");
  if (!original && frames === undefined) return;
  if (!original) source.pathname += ".preview.gif";
  try {
    const path = source.pathname.slice("/tetrioplus/data/content/".length);
    const data = await fetchExternalFile(`/api/skin-source?path=${encodeURIComponent(path)}`, MAX_SKIN_EXPORT_BYTES, new AbortController().signal, 10_000);
    const timing = gifTiming(data);
    const count = frames ?? timing.ends.length;
    if (count > 64) return;
    // Gallery previews can repeat the mino cycle while a longer ghost animation runs.
    if (timing.ends.length % count || original && timing.ends.length !== count) return;
    const durations = timing.ends.map((end, i) => end - (timing.ends[i - 1] ?? 0));
    if (durations.some((duration, i) => duration !== durations[i % count])) return;
    return { data, original, width: timing.width, height: timing.height, frameEnds: timing.ends.slice(0, count) };
  } catch {
    // Source timing is optional; a missing or invalid source keeps the export's own delay.
    return;
  }
}
