import { describe, expect, test } from "bun:test";
import { DEFAULT_HANDLING, Game, Input, LEAGUE_LOCK, PRACTICE_LOCK } from "@42tris/core";
import { Match } from "@42tris/match";
import { MatchDriver, SoloDriver, type MatchInitial, type MatchRecord, type SoloRecord } from "./index";

const handling = { ...DEFAULT_HANDLING, arr: 0, sdarr: 0 };
const initial = { seed: -42, gravityMs: 500, previewCount: 5, handling, readyMs: 250,
  lockProfile: PRACTICE_LOCK, width: 8, zen: false as const };
const matchInitial: MatchInitial = { players: ["a", "b"], width: 10, seed: -7, firstTo: 2,
  handlingByPlayer: { a: handling, b: handling }, mode: "competitive", attacksEnabled: true, lockProfile: LEAGUE_LOCK };

describe("solo driver", () => {
  test("preserves observations, events and state across equal and fractional clocks", () => {
    const driver = new SoloDriver(initial);
    const game = new Game(initial.seed, initial.gravityMs, initial.previewCount, handling, initial.readyMs, null, initial.lockProfile, initial.width);
    const operations: SoloRecord["op"][] = [
      { type: "tick", atMs: 1234.5 }, { type: "tick", atMs: 1300.25 },
      { type: "handling", observedAtMs: 1300.25, handling }, { type: "tick", atMs: 1500.75 },
      { type: "input", atMs: 1500.75, input: Input.LeftDown }, { type: "tick", atMs: 1600.125 },
      { type: "input", atMs: 1600.125, input: Input.Hold }, { type: "pause", atMs: 1650.5, paused: true },
      { type: "tick", atMs: 1700.5 }, { type: "handling", observedAtMs: 1700.5, handling: DEFAULT_HANDLING },
      { type: "pause", atMs: 1800.5, paused: false }, { type: "input", atMs: 1801.5, input: Input.HardDrop },
    ];
    operations.forEach((op, seq) => {
      switch (op.type) {
        case "tick": game.tick(op.atMs); break;
        case "input": game.apply(op.input, op.atMs); break;
        case "pause": game.setPaused(op.paused, op.atMs); break;
        case "handling": game.setHandling(op.handling); break;
      }
      expect(driver.apply({ seq, op })).toEqual(game.drainEvents());
      expect(driver.state).toEqual(game.saveState());
    });
    expect(Game.fromState(driver.state, null).saveState()).toEqual(driver.state);
  });
  test("rejects invalid clocks, sequence, and configuration", () => {
    expect(() => new SoloDriver({ ...initial, seed: 2 ** 31 })).toThrow();
    const driver = new SoloDriver(initial);
    expect(() => driver.apply({ seq: 0, op: { type: "input", input: Input.Hold, atMs: 0 } })).toThrow();
    driver.apply({ seq: 0, op: { type: "tick", atMs: 5 } });
    expect(() => driver.apply({ seq: 1, op: { type: "handling", observedAtMs: 6, handling } })).toThrow();
    expect(() => driver.apply({ seq: 2, op: { type: "tick", atMs: 7 } })).toThrow();
  });
});

describe("match driver", () => {
  test("cancels future input in journal order and preserves partial advances", () => {
    const submit: MatchRecord["op"] = { type: "submit", input: { player: "a", frame: 2, subframe: 0.25, order: 0, input: Input.HardDrop, epoch: 0 } };
    const release: MatchRecord["op"] = { type: "release", player: "a" };
    const advance: MatchRecord["op"] = { type: "advance", toFrame: 10, reachedFrame: 10 };
    function run(ops: MatchRecord["op"][], split: boolean) {
      const driver = new MatchDriver(matchInitial);
      const events = [];
      for (const [seq, op] of ops.entries()) {
        events.push(...driver.apply({ seq, before: { round: 1, frame: 0 }, op }, split ? 2 : undefined));
        while (driver.hasPendingAdvance) events.push(...driver.advance(2));
      }
      return { state: driver.state, events };
    }
    const cancelled = run([submit, release, advance], false);
    expect(run([submit, release, advance], true)).toEqual(cancelled);
    expect(run([release, submit, advance], false).state).not.toEqual(cancelled.state);
    const actual = new Match(matchInitial);
    actual.submit(submit.input); actual.releaseControls("a"); actual.advanceToFrame(10);
    expect(cancelled.events).toEqual(actual.drainEvents());
    expect(cancelled.state).toEqual(actual.saveState());
    expect(Match.fromState(cancelled.state).saveState()).toEqual(cancelled.state);
  });
  test("checks bounds, epochs and transitions", () => {
    expect(() => new MatchDriver({ ...matchInitial, mode: "practice" } as unknown as MatchInitial)).toThrow();
    const driver = new MatchDriver(matchInitial);
    const before = { round: 1, frame: 0 };
    expect(() => driver.apply({ seq: 0, before, op: { type: "nextRound", seed: 12 } })).toThrow();
    expect(() => driver.apply({ seq: 0, before, op: { type: "submit", input: { player: "a", frame: 0, subframe: 0, order: 0, epoch: 1, input: Input.Hold } } })).toThrow();
    expect(() => driver.apply({ seq: 0, before, op: { type: "advance", toFrame: 500000, reachedFrame: 0 } })).toThrow();
  });
});

test("canonical JSON and SHA-256 are stable across key order and JSON round trips", async () => {
  const { canonicalJson, sha256 } = await import("./canonical");
  const a = { z: [1, -0, { b: 2, a: 3 }], a: "x" };
  const b = { a: "x", z: [1, 0, { a: 3, b: 2 }] };
  expect(canonicalJson(a)).toBe(canonicalJson(b));
  expect(await sha256(a)).toBe(await sha256(JSON.parse(JSON.stringify(b))));
  expect(await sha256(a)).not.toBe(await sha256({ ...b, a: "y" }));
  expect(() => canonicalJson({ bad: Infinity })).toThrow();
  expect(() => canonicalJson([undefined])).toThrow();
});
