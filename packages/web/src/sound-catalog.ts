import presets from "./sound-presets.json";
import eddiePresets from "./eddie-sound-presets.json";
import { parseSoundPack, type SoundPack } from "./sound-pack";

export interface SoundDef { id: string; label: string; pack: SoundPack; source?: string; credit?: string }
export const SOUND_DATABASE = "https://github.com/Ecdldaiiere/Eddiez-Soundz";
export const JSTRIS_SOUND_PRESETS = "https://github.com/JstrisPlus/jstris-plus-assets/blob/main/presets/soundPresets.json";
export const SILENT: SoundDef = { id: "silent", label: "Silent", pack: { name: "Silent" } };
const ids = ["tetra-online", "tetrio", "toj", "friends", "t99", "ppt", "battle"];

export const BUILTIN_SOUNDS: readonly SoundDef[] = [SILENT,
  ...presets.map((pack, i) => ({ id: ids[i], label: pack.name.replace(" Sound Pack", ""), pack: parseSoundPack(pack), source: JSTRIS_SOUND_PRESETS, credit: "Jstris+ preset" })),
  ...eddiePresets.map(({ id, pack }) => ({ id, label: pack.name, pack: parseSoundPack(pack), source: SOUND_DATABASE, credit: "Eddiez-Soundz" })),
];
