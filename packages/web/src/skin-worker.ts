/// <reference lib="webworker" />
import { fetchExternalFile } from "./external-file";
import { MAX_SKIN_EXPORT_BYTES, parseTetrioSkin, TETRIO_SKIN_ROWS } from "./tetrio-skins";
import { drawTetrioFrame, packSkinFrames } from "./skin-atlas";
import { skinSourceAnimation } from "./skin-animation";

const scope = self as unknown as DedicatedWorkerGlobalScope;
scope.onmessage = async ({ data: url }: MessageEvent<string>) => {
  let image: ImageBitmap | undefined, canvas: OffscreenCanvas | undefined;
  let decoder: ImageDecoder | undefined;
  try {
    let source = await skinSourceAnimation(url);
    let frames = source?.frameEnds.length ?? 0, delay = (source?.frameEnds[0] ?? 0) * 60 / 1000;
    const pack = async () => {
      const width = decoder ? source!.width : image!.width / Math.min(frames, 16);
      const tile = decoder ? Math.min(source!.height, 32) : Math.min(width * 3 / 64 - (width >= 2048 ? 4 : 2), 32);
      return packSkinFrames(frames, async (ctx, frame) => {
        if (!decoder) {
          drawTetrioFrame(ctx, image!, width, frame, frames, tile);
          return;
        }
        const { image: decoded } = await decoder.decode({ frameIndex: frame });
        try {
          for (let piece = 0; piece < 7; piece++) ctx.drawImage(decoded, piece * source!.width / 12, 0,
            source!.width / 12.4, source!.height, piece * tile, 0, tile, tile);
          for (let row = 1; row < TETRIO_SKIN_ROWS; row++) ctx.drawImage(ctx.canvas, 0, 0, 7 * tile, tile, 0, row * tile, 7 * tile, tile);
        } finally { decoded.close(); }
      }, (width, height) => new OffscreenCanvas(width, height), tile);
    };
    let packed;
    if (source?.original && source.width / source.height === 12.4 && typeof ImageDecoder !== "undefined") {
      try {
        if (await ImageDecoder.isTypeSupported("image/gif")) {
          decoder = new ImageDecoder({ data: source.data, type: "image/gif" });
          await decoder.tracks.ready;
          packed = await pack();
        }
      } catch {
        // A failed optional GIF decoder must not prevent loading the valid PNG export.
        decoder?.close(); decoder = undefined;
      }
    }
    if (!packed) {
      const bytes = await fetchExternalFile(url, MAX_SKIN_EXPORT_BYTES, new AbortController().signal, 10_000);
      const skin = parseTetrioSkin(JSON.parse(new TextDecoder().decode(bytes)));
      frames = skin.frames; delay = skin.delay;
      if (frames === 1) source = undefined;
      else if (source?.frameEnds.length !== frames) source = await skinSourceAnimation(url, frames);
      const blob = await fetch(skin.image).then(response => response.blob());
      image = await createImageBitmap(blob);
      packed = await pack();
    }
    canvas = packed.image;
    const preview = await canvas.convertToBlob({ type: "image/png" });
    scope.postMessage({ blob: preview, tiles: packed.tiles, tile: packed.tile, frames, delay, frameEnds: source?.frameEnds }, [packed.tiles.buffer]);
  } catch (error) {
    scope.postMessage({ error: (error as Error).message });
  } finally {
    image?.close();
    decoder?.close();
    if (canvas) canvas.width = 0;
  }
};
