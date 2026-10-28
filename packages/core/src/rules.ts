import { canPlace, COLS, ROWS } from "./board";
import { Piece, type PieceId } from "./pieces";

export const RULES_VERSION = "42tris-tl-s2-v1";
export type Spin = "none" | "mini" | "full";
export type Attack = Readonly<{ kind: "normal" | "surge" | "allClear"; lines: number }>;

export interface ClearStats {
  readonly pieces: number;
  readonly lines: number;
  readonly combo: number;
  readonly chainLength: number;
  readonly b2b: number;
  readonly surge: number;
  readonly attack: number;
}

export const INITIAL_STATS: ClearStats = Object.freeze({
  pieces: 0, lines: 0, combo: -1, chainLength: 0, b2b: 0, surge: 0, attack: 0,
});

export interface Clear {
  readonly lines: number;
  readonly spin: Spin;
  readonly allClear: boolean;
  readonly garbage: boolean;
}

export function classifySpin(
  board: Uint8Array, piece: PieceId, rot: number, x: number, y: number,
  lastWasRotation: boolean, lastKickIndex: number,
): Spin {
  if (!lastWasRotation) return "none";
  if (piece === Piece.T && !canPlace(board, piece, rot, x, y + 1)) {
    const occupied = (cx: number, cy: number) =>
      cx < 0 || cx >= COLS || cy < 0 || cy >= ROWS || board[cy * COLS + cx] !== 0;
    // Clockwise corners, starting at the top left. Rotation selects the front pair.
    const corners = [occupied(x, y), occupied(x + 2, y), occupied(x + 2, y + 2), occupied(x, y + 2)];
    if (corners.filter(Boolean).length >= 3) {
      return (corners[rot] && corners[(rot + 1) & 3]) || lastKickIndex === 4 ? "full" : "mini";
    }
  }
  return !canPlace(board, piece, rot, x - 1, y) && !canPlace(board, piece, rot, x + 1, y)
    && !canPlace(board, piece, rot, x, y - 1) && !canPlace(board, piece, rot, x, y + 1)
    ? "mini" : "none";
}

export function resolveClear(previous: ClearStats, clear: Clear): { stats: ClearStats; attacks: readonly Attack[] } {
  const { lines, spin, allClear, garbage } = clear;
  const combo = lines ? previous.combo + 1 : -1;
  const qualifies = lines > 0 && (lines === 4 || spin !== "none" || allClear);
  const chainLength = qualifies ? previous.chainLength + 1 : lines ? 0 : previous.chainLength;
  const b2b = Math.max(0, chainLength - 1);
  const attacks: Attack[] = [];
  const add = (kind: Attack["kind"], amount: number) => {
    if (amount > 0) attacks.push(Object.freeze({ kind, lines: amount }));
  };
  if (lines && !qualifies && previous.surge) {
    const third = Math.round(previous.surge / 3);
    add("surge", third);
    add("surge", third);
    add("surge", previous.surge - 2 * third);
  }
  if (lines) {
    const base = spin === "full" ? [0, 2, 4, 6][lines] : [0, 0, 1, 2, 4][lines];
    let normal = (base + (qualifies && chainLength > 1 ? 1 : 0)) * (1 + 0.25 * combo);
    if (combo >= 2) normal = Math.max(normal, Math.log1p(1.25 * combo));
    normal = Math.floor(normal);
    if (garbage && (lines === 4 || spin !== "none")) normal++;
    add("normal", normal);
    if (allClear) add("allClear", 5);
  }
  const stats = Object.freeze({
    pieces: previous.pieces + 1,
    lines: previous.lines + lines,
    combo, chainLength, b2b,
    surge: b2b >= 4 ? b2b : 0,
    attack: previous.attack + attacks.reduce((sum, packet) => sum + packet.lines, 0),
  });
  return { stats, attacks: Object.freeze(attacks) };
}
