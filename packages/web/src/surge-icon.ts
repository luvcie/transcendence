import { fetchExternalFile } from "./external-file";
import { pngSize } from "./tetrio-skins";

const source = "https://you.have.fail/tetrioplus/data/tpsefiles/unknown/AGoatt/Cyclone_Surge_Icon.zip.tpse";
const octetStream = "data:application/octet-stream;base64,";
export const SURGE_ICON_WIDTH = 85;
export const SURGE_ICON_HEIGHT = 82;

export async function loadSurgeIcon(makeImage = () => new Image(), makeCanvas = () => document.createElement("canvas")) {
  const bytes = await fetchExternalFile(source, 2 * 1024 * 1024, undefined, 10_000);
  const { board } = JSON.parse(new TextDecoder().decode(bytes)) ?? {};
  if (typeof board !== "string") throw new Error("The export is missing its board atlas.");
  const png = board.startsWith(octetStream) ? "data:image/png;base64," + board.slice(octetStream.length) : board;
  const [width, height] = pngSize(png);
  if (width !== 512 || height !== 512) throw new Error("Unexpected Cyclone board atlas dimensions.");
  const image = makeImage();
  image.src = png;
  await image.decode();

  // the surge sprite sits below the warning sign in this atlas
  const canvas = makeCanvas();
  canvas.width = SURGE_ICON_WIDTH;
  canvas.height = SURGE_ICON_HEIGHT;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("The Surge icon needs a 2D canvas.");
  context.drawImage(image, 6, 220, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL();
}
