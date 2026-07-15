import { expect, test } from "bun:test";
import { BOX, MINOS, Piece } from "./pieces";

const ids = Object.values(Piece);

test("every rotation has 4 distinct minos inside the box", () => {
  for (const p of ids) {
    for (let r = 0; r < 4; r++) {
      const m = MINOS[p][r];
      expect(m.length).toBe(8);
      const seen = new Set<number>();
      for (let i = 0; i < 8; i += 2) {
        expect(m[i]).toBeGreaterThanOrEqual(0);
        expect(m[i]).toBeLessThan(BOX[p]);
        expect(m[i + 1]).toBeGreaterThanOrEqual(0);
        expect(m[i + 1]).toBeLessThan(BOX[p]);
        seen.add(m[i] * 8 + m[i + 1]);
      }
      expect(seen.size).toBe(4);
    }
  }
});

test("a fourth clockwise rotation comes back to spawn", () => {
  for (const p of ids) {
    const n = BOX[p];
    const last = MINOS[p][3];
    const back = new Int8Array(8);
    for (let i = 0; i < 8; i += 2) {
      back[i] = n - 1 - last[i + 1];
      back[i + 1] = last[i];
    }
    expect([...back]).toEqual([...MINOS[p][0]]);
  }
});

test("o piece occupies the same cells in every rotation", () => {
  const cells = (m: Int8Array) => {
    const out: number[] = [];
    for (let i = 0; i < 8; i += 2) out.push(m[i] * 8 + m[i + 1]);
    return out.sort((a, b) => a - b);
  };
  const spawn = cells(MINOS[Piece.O][0]);
  for (let r = 1; r < 4; r++) {
    expect(cells(MINOS[Piece.O][r])).toEqual(spawn);
  }
});
