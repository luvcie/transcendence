/// <reference lib="webworker" />
import { packedTileSize, tetrioSourceTile, TETRIO_SKIN_ROWS } from "./tetrio-skins";
import { drawTetrioFrame, packSkinFrames } from "./skin-atlas";
import { skinSourceAnimation } from "./skin-animation";
import { loadSkinExport, skinAnimations } from "./skin-files";

const scope = self as unknown as DedicatedWorkerGlobalScope;
scope.onmessage = async ({ data: { url, custom } }: MessageEvent<{ url: string; custom: boolean }>) => {
  let image: ImageBitmap | undefined, ghost: ImageBitmap | undefined, canvas: OffscreenCanvas | undefined;
  let decoder: ImageDecoder | undefined;
  try {
    let source = await skinSourceAnimation(url, undefined, custom);
    let frames = source?.frameEnds.length ?? 0, delay = (source?.frameEnds[0] ?? 0) * 60 / 1000;
    const pack = () => {
      const width = decoder ? source!.width : image!.width / Math.min(frames, 16);
      const tile = packedTileSize(decoder ? source!.height : tetrioSourceTile(width), frames);
      return packSkinFrames(frames, async (ctx, frame) => {
        if (!decoder) {
          drawTetrioFrame(ctx, image!, width, frame, frames, tile, ghost);
          return;
        }
        const { image: decoded } = await decoder.decode({ frameIndex: frame });
        try {
          // the strip goes Z L O S I J T, ghost, hold, garbage
          [0, 1, 2, 3, 4, 5, 6, 9, 7].forEach((strip, column) => ctx.drawImage(decoded, strip * source!.width / 12, 0,
            source!.width / 12.4, source!.height, column * tile, 0, tile, tile));
          for (let row = 1; row < TETRIO_SKIN_ROWS; row++) ctx.drawImage(ctx.canvas, 0, 0, 9 * tile, tile, 0, row * tile, 9 * tile, tile);
        } finally { decoded.close(); }
      }, (width, height) => new OffscreenCanvas(width, height), tile);
    };
    async function encode(packed: Awaited<ReturnType<typeof pack>>) {
      canvas = packed.image;
      const blob = await canvas.convertToBlob({ type: "image/png" });
      return { blob, tiles: packed.tiles, tile: packed.tile, frames, delay, frameEnds: source?.frameEnds,
        ghost: !!decoder || !!ghost };
    }
    let packed, failedSource = false;
    if (source?.original && source.width / source.height === 12.4 && typeof ImageDecoder !== "undefined") {
      try {
        if (await ImageDecoder.isTypeSupported("image/gif")) {
          decoder = new ImageDecoder({ data: source.data, type: "image/gif" });
          await decoder.tracks.ready;
          packed = await pack();
        }
      } catch {
        decoder?.close(); decoder = undefined;
        failedSource = true;
        if (custom) await skinAnimations.remove(url);
      }
    }
    const prepared = packed ? await encode(packed) : await loadSkinExport(url, custom, 10_000, async skin => {
      frames = skin.frames; delay = skin.delay;
      if (frames === 1) source = undefined;
      else if (source?.frameEnds.length !== frames) source = failedSource ? undefined : await skinSourceAnimation(url, frames, custom);
      const blob = await fetch(skin.image).then(response => response.blob());
      image = await createImageBitmap(blob);
      if (skin.ghost) ghost = await createImageBitmap(await fetch(skin.ghost).then(response => response.blob()));
      return encode(await pack());
    });
    scope.postMessage(prepared, [prepared.tiles.buffer]);
  } catch (error) {
    scope.postMessage({ error: (error as Error).message });
  } finally {
    image?.close();
    ghost?.close();
    decoder?.close();
    if (canvas) canvas.width = 0;
  }
};
