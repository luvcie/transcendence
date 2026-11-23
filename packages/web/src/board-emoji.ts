import { GARBAGE, Piece } from "@42tris/core";

export const empty = "⬛";
export const ids: Record<string, number> = {
  "🟥": Piece.Z, "🟧": Piece.L, "🟨": Piece.O, "🟩": Piece.S, "⬜": Piece.I, "🟦": Piece.J, "🟪": Piece.T,
  "🟫": GARBAGE,
};
export const emojis = [empty];
for (const [emoji, id] of Object.entries(ids)) emojis[id] = emoji;
