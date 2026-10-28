import { expect, test } from "bun:test";
import { INITIAL_STATS, resolveClear, type Clear, type ClearStats } from "./rules";

const empty: Clear = { lines: 0, spin: "none", allClear: false, garbage: false };
function clear(stats: ClearStats, changes: Partial<Clear>) {
  return resolveClear(stats, { ...empty, ...changes });
}
function chain(length: number) {
  let stats = INITIAL_STATS;
  for (let i = 0; i < length; i++) {
    stats = clear(stats, { lines: 4 }).stats;
    stats = clear(stats, {}).stats;
  }
  return stats;
}

test("base attacks for ordinary clears, full spins and minis", () => {
  for (const [spin, amounts] of [["none", [0, 1, 2, 4]], ["mini", [0, 1, 2, 4]], ["full", [2, 4, 6]]] as const) {
    amounts.forEach((amount, index) => {
      const result = clear(INITIAL_STATS, { lines: index + 1, spin });
      expect(result.attacks).toEqual(amount ? [{ kind: "normal", lines: amount }] : []);
      expect(result.stats.combo).toBe(0);
    });
  }
});

test("B2B establishes on the first difficult clear and survives empty placements", () => {
  const first = clear(INITIAL_STATS, { lines: 4 });
  expect(first.stats.chainLength).toBe(1);
  expect(first.stats.b2b).toBe(0);
  const gap = clear(first.stats, {});
  expect(gap.stats.combo).toBe(-1);
  expect(gap.stats.chainLength).toBe(1);
  const second = clear(gap.stats, { lines: 1, spin: "mini" });
  expect(second.stats.b2b).toBe(1);
  expect(second.attacks).toEqual([{ kind: "normal", lines: 1 }]);
  const broken = clear(second.stats, { lines: 2 });
  expect(broken.stats.chainLength).toBe(0);
  expect(broken.attacks).toEqual([{ kind: "normal", lines: 1 }]);
});

test("zero-line spins reset combo without increasing or breaking B2B", () => {
  const stats = clear(chain(3), { lines: 4 }).stats;
  for (const spin of ["mini", "full"] as const) {
    const result = clear(stats, { spin });
    expect(result.stats.b2b).toBe(3);
    expect(result.stats.combo).toBe(-1);
    expect(result.attacks).toEqual([]);
  }
});

test("Surge starts at displayed x4 and releases rounded packets before the breaking clear", () => {
  expect(chain(4).surge).toBe(0);
  for (const [length, packets] of [[5, [1, 1, 2]], [6, [2, 2, 1]], [9, [3, 3, 2]]] as const) {
    const charged = chain(length);
    expect(charged.surge).toBe(length - 1);
    const result = clear(charged, { lines: 3 });
    expect(result.attacks).toEqual([
      ...packets.map(lines => ({ kind: "surge", lines })), { kind: "normal", lines: 2 },
    ]);
    expect(result.stats.b2b).toBe(0);
    expect(result.stats.surge).toBe(0);
  }
});

test("all clears advance B2B once, preserve Surge and add a separate five-line packet", () => {
  for (const [lines, spin, normal] of [[1, "none", 1], [4, "none", 5], [2, "full", 5]] as const) {
    const result = clear(chain(5), { lines, spin, allClear: true });
    expect(result.stats.chainLength).toBe(6);
    expect(result.stats.surge).toBe(5);
    expect(result.attacks).toEqual([{ kind: "normal", lines: normal }, { kind: "allClear", lines: 5 }]);
  }
  expect(clear(INITIAL_STATS, { lines: 1, allClear: true }).attacks).toEqual([{ kind: "allClear", lines: 5 }]);
});

test("combos multiply before rounding and give zero-base clears a logarithmic minimum", () => {
  let stats = INITIAL_STATS;
  const attacks: number[] = [];
  for (let i = 0; i < 8; i++) {
    const result = clear(stats, { lines: 1 });
    stats = result.stats;
    attacks.push(result.attacks.reduce((sum, packet) => sum + packet.lines, 0));
  }
  expect(attacks).toEqual([0, 0, 1, 1, 1, 1, 2, 2]);
  const result = clear({ ...INITIAL_STATS, combo: 1, chainLength: 1 }, { lines: 4, allClear: true });
  expect(result.attacks).toEqual([{ kind: "normal", lines: 7 }, { kind: "allClear", lines: 5 }]);
});

test("garbage clear bonus is added after combo rounding, once per qualifying clear", () => {
  expect(clear(INITIAL_STATS, { lines: 2, garbage: true }).attacks).toEqual([{ kind: "normal", lines: 1 }]);
  expect(clear(INITIAL_STATS, { lines: 1, spin: "mini", garbage: true }).attacks).toEqual([{ kind: "normal", lines: 1 }]);
  const result = clear({ ...INITIAL_STATS, combo: 0, chainLength: 1 }, { lines: 4, garbage: true });
  expect(result.attacks).toEqual([{ kind: "normal", lines: 7 }]);
});
