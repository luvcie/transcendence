/// <reference lib="webworker" />
import { fetchExternalFile } from "./external-file";
import { MAX_SKIN_EXPORT_BYTES, parseTetrioSkin } from "./tetrio-skins";
import { renderSkinPreview } from "./tile-renderer";

const scope = self as unknown as DedicatedWorkerGlobalScope;
scope.onmessage = async ({ data: url }: MessageEvent<string>) => {
  let image: ImageBitmap | undefined, canvas: OffscreenCanvas | undefined;
  try {
    const bytes = await fetchExternalFile(url, MAX_SKIN_EXPORT_BYTES, new AbortController().signal, 10_000);
    const skin = parseTetrioSkin(JSON.parse(new TextDecoder().decode(bytes)));
    const blob = await fetch(skin.image).then(response => response.blob());
    image = await createImageBitmap(blob);
    canvas = renderSkinPreview(image, skin.frames);
    const preview = await canvas.convertToBlob({ type: "image/png" });
    scope.postMessage({ blob: preview, frames: skin.frames, delay: skin.delay });
  } catch (error) {
    scope.postMessage({ error: (error as Error).message });
  } finally {
    image?.close();
    if (canvas) canvas.width = 0;
  }
};
