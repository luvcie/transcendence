export interface SkinDef {
  id: string;
  label: string;
  url?: string;
  tile: number;
  source?: string;
  credit?: string;
  join?: { open: number; joined: number };
}

export const SKIN_DATABASE = "https://konsola5.github.io/jstris-customization-database/";
export const CLASSIC: SkinDef = { id: "classic", label: "Classic", tile: 0 };

// Catalog and source links ported from memominolab's jstris database selection.
const catalog: [string, string, string, number?][] = [
  ["tetrio", "TETR.IO", "XcnWlC6", 30],
  ["ppt", "Puyo Puyo Tetris", "zjItrsg", 36],
  ["effect", "Tetris Effect", "FSxv1jC"],
  ["t99", "Tetris 99", "EBhGQBV"],
  ["t99xeno", "Tetris 99 Xenoblade Chronicles", "7YSQvLX"],
  ["t99poke", "Tetris 99 Pokemon Sword & Shield", "21r3sZ7"],
  ["t99kirby", "Tetris 99 Super Kirby Clash", "3RcauDs"],
  ["t99zelda", "Tetris 99 The Legend of Zelda", "hedIkhr"],
  ["t99sky", "Tetris 99 The Legend of Zelda: Skyward Sword", "M6EpnrV"],
  ["t99ac", "Tetris 99 Animal Crossing", "w1qCuSi"],
  ["t99mario", "Tetris 99 Paper Mario", "O9G0k55"],
  ["t99fe", "Tetris 99 Fire Emblem", "AugBMNr"],
  ["t99splat", "Tetris 99 Splatoon", "PtW72rR"],
  ["forever", "Tetris Forever (2024)", "7UZoQRi"],
  ["ult", "Tetris Ultimate (2014)", "0kZZro6"],
  ["ult3ds", "Tetris Ultimate 3DS", "hRGImm8"],
  ["apotris", "Apotris", "45749qO"],
  ["diamond", "Tetris Diamond, Tetris Remix", "fz8scuB"],
  ["four", "FOUR.lol", "zIFJEZ9"],
  ["hdwiki", "Hard Drop Wiki Skin", "EnCS0Yk"],
  ["hdmin", "Hard Drop Wiki Minimalist Skin", "6EqjUdN"],
  ["jsolid", "jstris solid skin", "uLimKwZ"],
  ["jb1", "jstris b1", "nXwQkAS"],
  ["n3base", "Tetris (N3TWORK) Base Skin", "EMtUZl1"],
  ["n3neon", "Tetris Royale Neon Future", "Y6oYgNQ"],
  ["n3mon", "Tetris Royale Monstris", "5sKpDzt"],
  ["tmino1", "Techmino skin 1", "vsLFWm6"],
  ["tminocrystal", "Techmino crystal scf", "S4zbQvT"],
  ["tminojelly", "Techmino jelly miya", "VXjQ1H6"],
  ["tfriends", "Tetris Friends", "HqGYC5G"],
  ["toj", "Tetris Online Japan default", "P71JsB7"],
  ["tetrinet", "TetriNET", "1viCxJc"],
  ["jawiki", "テトリス (Japanese Wikipedia Tetriminoes)", "c98fqqV"],
  ["nblox", "N-Blox Guideline", "KAr9nTY"],
  ["drmano", "Tetris & Dr Mario", "8eIewoR"],
  ["gb", "Gameboy Tetris", "4LDPaBx"],
  ["gbdX", "Gameboy Tetris DX", "SaaIUFa"],
  ["gbagbc", "Tetris Worlds GBA", "ZtDBvCg"],
  ["axis", "Tetrix Axis (3DS)", "XJ3aZVO"],
  ["bombliss", "Super Bombliss DX (GBC)", "oM4jVAC"],
  ["nes", "NES Tetris", "TV52fTd"],
  ["nesmod", "NES Tetris Modern", "r1KqG2r"],
  ["poke", "Poke Tetris (NES Pirate)", "GS2zWaD"],
  ["t64", "Tetris 64 (N64)", "zrlg9NA"],
  ["saturn", "Tetris S (Sega Saturn)", "16DYHU7"],
  ["ps3", "Tetris (PS3)", "yGWA8MC"],
  ["segadc", "Sega Tetris (Dreamcast)", "vzfIKcC"],
  ["tgc", "TGM Ace (Xbox)", "2xa0Dck"],
  ["tds", "Tetris DS", "uNdMnmD"],
  ["party", "Tetris Party Deluxe (DS)", "430psX3"],
  ["partycover", "Tetris Party Deluxe Cover Minos", "uY7H3Mn"],
  ["zentris", "Zentris (MS-DOS)", "WZFxvcH"],
  ["tplus", "Tetris Plus (1996)", "AStk6Rl"],
  ["mspack", "Tetris 2.00 (Microsoft Entertainment Pack)", "fOt2TXj"],
  ["magical", "Magical Tetris Challenge (1998)", "tCJUjPT"],
  ["crazy", "Crazy Tetris (2002)", "cS7f5Gl"],
  ["kiwami", "Tetris Kiwamemichi", "OlqbDd2"],
  ["kentei", "Tetris Kentei", "PvDVo21"],
  ["dash", "Tetris Dash", "wwIiYNZ"],
  ["sakura", "Tetris with Cardcaptor Sakura Eternal Heart (PS1)", "iYn66Z9"],
  ["tcom", "Tetris.com", "Z1YmTe4"],
  ["hkitty", "Hello Kitty Tetris (Tetris.com special event)", "vhnznDY"],
  ["dreamg", "Dream Girls Tetris (2004, Flash)", "KQXVsVt"],
  ["emoji", "Emojiblocks", "CdCpdnL"],
  ["emo", "Emo Tetris", "sn1WA2H"],
];

export const BUILTIN_SKINS: readonly SkinDef[] = [CLASSIC, ...catalog.map(([id, label, image, tile = 0]) => {
  const url = `https://i.imgur.com/${image}.png`;
  return { id, label, url, tile, source: id === "four" ? "https://imgur.com/zIFJEZ9" : url,
    ...(id === "four" ? { join: { open: 0, joined: 1 } } : {}) };
})];

export function customSkin(url: string, index: number): SkinDef {
  return { id: `custom:${index}`, label: `Custom ${index + 1}`, url, tile: 0, source: url };
}
