import { describe, expect, test } from "bun:test";
import { DEFAULT_HANDLING, GAME_STATE_VERSION, Input, LEAGUE_LOCK, PRACTICE_LOCK, RULES_VERSION } from "@42tris/core";
import { GARBAGE_PROFILE, MATCH_VERSION } from "@42tris/match";
import {
  CURRENT_REPLAY_VERSIONS,
  DEFAULT_REPLAY_LIMITS,
  MAX_TIMESTAMP_MS,
  MATCH_MODE_ID,
  REPLAY_SIMULATION_VERSION,
  ReplayError,
  SOLO_MODE_ID,
  SoloDriver,
  computeFinalStateDigest,
  decodeReplay,
  decodeReplayJson,
  decodeReplayWithIntegrity,
  encodeReplay,
  sealReplay,
  sha256,
  verifyReplayIntegrity,
  type MatchReplay,
  type SoloReplay,
  type UnsignedMatchReplay,
  type UnsignedSoloReplay,
} from "./index";

const handling = { ...DEFAULT_HANDLING, arr: 0, sdarr: 0 };
const soloInitial = { seed: -42, gravityMs: 500, previewCount: 5, handling, readyMs: 250,
  lockProfile: PRACTICE_LOCK, width: 8, zen: false as const };
const matchInitial = { players: ["a", "b"], width: 10, seed: -7, firstTo: 1,
  handlingByPlayer: { a: handling, b: handling }, mode: "competitive" as const,
  attacksEnabled: true as const, lockProfile: LEAGUE_LOCK };

function soloPayload(): UnsignedSoloReplay {
  return {
    versions: CURRENT_REPLAY_VERSIONS,
    id: "solo-replay-1",
    kind: "solo",
    mode: { id: SOLO_MODE_ID, version: 1, config: { zen: false } },
    initial: soloInitial,
    records: [
      { seq: 0, op: { type: "tick", atMs: 1000 } },
      { seq: 1, op: { type: "tick", atMs: 1016.5 } },
      { seq: 2, op: { type: "input", atMs: 1016.5, input: Input.HardDrop } },
      { seq: 3, op: { type: "handling", observedAtMs: 1016.5, handling } },
      { seq: 4, op: { type: "tick", atMs: 1100 } },
      { seq: 5, op: { type: "pause", atMs: 1100, paused: true } },
      { seq: 6, op: { type: "tick", atMs: 1200 } },
      { seq: 7, op: { type: "pause", atMs: 1200, paused: false } },
    ],
    end: { atMs: 1200, afterSeq: 7, status: "stopped", reason: "user stopped",
      finalStateDigest: "a".repeat(64) },
    summary: {
      stats: { pieces: 0, lines: 0, combo: -1, chainLength: 0, b2b: 0, surge: 0, attack: 0 },
      topOut: false,
    },
  };
}

function matchPayload(): UnsignedMatchReplay {
  return {
    versions: CURRENT_REPLAY_VERSIONS,
    id: "match-replay-1",
    kind: "match",
    mode: { id: MATCH_MODE_ID, version: 1, config: { attacksEnabled: true, lockProfile: LEAGUE_LOCK } },
    initial: matchInitial,
    records: [
      { seq: 0, before: { round: 1, frame: 0 }, op: { type: "submit",
        input: { player: "a", frame: 2, subframe: 0.25, order: 0, input: Input.HardDrop, epoch: 0 } } },
      { seq: 1, before: { round: 1, frame: 0 }, op: { type: "release", player: "a" } },
      { seq: 2, before: { round: 1, frame: 0 }, op: { type: "advance", toFrame: 10, reachedFrame: 10 } },
      { seq: 3, before: { round: 1, frame: 10 }, op: { type: "forfeit", player: "a" } },
    ],
    end: { round: 1, frame: 10, afterSeq: 3, status: "complete", reason: "set complete",
      finalStateDigest: "b".repeat(64) },
    summary: {
      scores: { a: 0, b: 1 },
      winner: "b",
      reason: "forfeit",
      rounds: [{ round: 1, frame: 10, winner: "b", complete: true }],
    },
  };
}

function withIntegrity(payload: UnsignedSoloReplay | UnsignedMatchReplay) {
  return { ...payload, integrity: { algorithm: "SHA-256" as const, digest: "0".repeat(64) } };
}

function expectCode(fn: () => unknown, code: ReplayError["code"]): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ReplayError);
    expect((error as ReplayError).code).toBe(code);
    return;
  }
  throw new Error(`Expected ReplayError ${code}`);
}

async function expectRejects(fn: () => Promise<unknown>, code: ReplayError["code"]): Promise<void> {
  try {
    await fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ReplayError);
    expect((error as ReplayError).code).toBe(code);
    return;
  }
  throw new Error(`Expected ReplayError ${code}`);
}

describe("replay format", () => {
  test("round-trips solo and match envelopes through canonical JSON", async () => {
    for (const payload of [soloPayload(), matchPayload()]) {
      const sealed = await sealReplay(payload as UnsignedSoloReplay);
      const text = encodeReplay(sealed);
      const decoded = await decodeReplayJson(text);
      expect(decoded).toEqual(sealed);
      expect(await decodeReplayJson(JSON.stringify(sealed, null, 2))).toEqual(sealed);
      expect(await decodeReplayWithIntegrity(sealed)).toEqual(sealed);
    }
  });

  test("detects corruption and does not treat the checksum as authentication", async () => {
    const sealed = await sealReplay(soloPayload()) as SoloReplay;
    const changed = structuredClone(sealed);
    changed.records[1].op = { type: "tick", atMs: 1017 };
    expectCode(() => decodeReplay(changed), "malformed");
    const structurallyValid = structuredClone(sealed);
    structurallyValid.records[5].op = { type: "pause", atMs: 1100, paused: false };
    await expectRejects(() => verifyReplayIntegrity(structurallyValid), "integrity");
    await expectRejects(() => decodeReplayJson(JSON.stringify(structurallyValid)), "integrity");

    const { integrity: _integrity, ...payload } = structurallyValid;
    const resealed = await sealReplay(payload as UnsignedSoloReplay);
    expect(resealed.integrity.digest).not.toBe(sealed.integrity.digest);
    expect(resealed.records[5]).toEqual(structurallyValid.records[5]);
  });

  test("recomputing a checksum cannot bypass structural or ordering validation", async () => {
    const sealed = await sealReplay(matchPayload()) as MatchReplay;
    const broken = structuredClone(sealed);
    broken.end.afterSeq = 0;
    const { integrity: _integrity, ...payload } = broken;
    broken.integrity.digest = await sha256(payload);
    expectCode(() => decodeReplay(broken), "malformed");
    await expectRejects(() => decodeReplayJson(JSON.stringify(broken)), "malformed");
  });

  test("keeps decoded data detached from the source object", async () => {
    const source = JSON.parse(JSON.stringify(await sealReplay(soloPayload()))) as Record<string, unknown>;
    const decoded = decodeReplay(source) as SoloReplay;
    (source.records as { op: { atMs: number } }[])[0].op.atMs = 9000;
    (source.initial as { seed: number }).seed = 123;
    expect(decoded.records[0].op).toEqual({ type: "tick", atMs: 1000 });
    expect(decoded.initial.seed).toBe(-42);
  });

  test("accepts multi-round and empty stopped match journals", async () => {
    const multiRound: UnsignedMatchReplay = {
      ...matchPayload(),
      records: [
        { seq: 0, before: { round: 1, frame: 0 }, op: { type: "advance", toFrame: 400_000, reachedFrame: 5 } },
        { seq: 1, before: { round: 1, frame: 5 }, op: { type: "nextRound", seed: 12 } },
        { seq: 2, before: { round: 2, frame: 0 }, op: { type: "advance", toFrame: 3, reachedFrame: 3 } },
      ],
      end: { round: 2, frame: 3, afterSeq: 2, status: "stopped", reason: "stopped",
        finalStateDigest: "c".repeat(64) },
      summary: { scores: { a: 0, b: 0 }, winner: null, reason: "aborted", rounds: [
        { round: 1, frame: 5, winner: null, complete: false },
      ] },
    };
    expect((await sealReplay(multiRound) as MatchReplay).end).toMatchObject({ round: 2, frame: 3 });

    const empty: UnsignedMatchReplay = {
      ...matchPayload(),
      records: [],
      end: { round: 1, frame: 0, afterSeq: -1, status: "stopped", reason: "never started",
        finalStateDigest: "d".repeat(64) },
      summary: { scores: { a: 0, b: 0 }, winner: null, reason: "aborted", rounds: [] },
    };
    const decoded = await sealReplay(empty) as MatchReplay;
    expect(decoded.records).toEqual([]);
    expect(decoded.end.afterSeq).toBe(-1);
  });

  test("computes a canonical final state digest", async () => {
    const driver = new SoloDriver(soloInitial);
    driver.apply({ seq: 0, op: { type: "tick", atMs: 1000 } });
    const state = driver.state;
    const first = await computeFinalStateDigest(state, { mode: "local" });
    const second = await computeFinalStateDigest(JSON.parse(JSON.stringify(state)), { mode: "local" });
    expect(first).toBe(second);
    expect(await computeFinalStateDigest(state, { mode: "other" })).not.toBe(first);
  });
});

describe("replay compatibility", () => {
  test("rejects unsupported formats, identifiers, modes and algorithms", () => {
    const upgrades: [string, (value: Record<string, any>) => void][] = [
      ["format", value => { value.versions.format = 2; }],
      ["simulation", value => { value.versions.simulation = "other-sim"; }],
      ["previous simulation", value => { value.versions.simulation = "42tris-replay-sim-v1"; }],
      ["core state", value => { value.versions.coreState = GAME_STATE_VERSION - 1; }],
      ["core rules", value => { value.versions.coreRules = "other-rules"; }],
      ["mode", value => { value.mode.id = "42tris-unknown"; }],
      ["mode version", value => { value.mode.version = 2; }],
      ["integrity algorithm", value => { value.integrity.algorithm = "SHA-1"; }],
      ["zen mode", value => { value.mode.config.zen = true; }],
      ["kind", value => { value.kind = "other"; }],
    ];
    for (const [name, mutate] of upgrades) {
      const value = JSON.parse(JSON.stringify(withIntegrity(soloPayload())));
      mutate(value);
      expectCode(() => decodeReplay(value), "unsupported");
    }

    const matchCases: [string, (value: Record<string, any>) => void][] = [
      ["match state", value => { value.versions.matchState = MATCH_VERSION - 1; }],
      ["garbage", value => { value.versions.garbage = "other-garbage"; }],
      ["missing match identifiers", value => { delete value.versions.matchState; delete value.versions.garbage; }],
      ["practice", value => { value.initial.mode = "practice"; }],
      ["match mode", value => { value.mode.id = "42tris-practice"; }],
    ];
    for (const [name, mutate] of matchCases) {
      const value = JSON.parse(JSON.stringify(withIntegrity(matchPayload())));
      mutate(value);
      expectCode(() => decodeReplay(value), name === "missing match identifiers" ? "malformed" : "unsupported");
    }
  });

  test("rejects wrong scalar versions and current constants drift", () => {
    expect(CURRENT_REPLAY_VERSIONS.simulation).toBe(REPLAY_SIMULATION_VERSION);
    expect(CURRENT_REPLAY_VERSIONS.coreState).toBe(GAME_STATE_VERSION);
    expect(CURRENT_REPLAY_VERSIONS.coreRules).toBe(RULES_VERSION);
    expect(CURRENT_REPLAY_VERSIONS.matchState).toBe(MATCH_VERSION);
    expect(CURRENT_REPLAY_VERSIONS.garbage).toBe(GARBAGE_PROFILE);
  });
});

describe("replay structural validation", () => {
  test("rejects malformed solo envelopes and journals", () => {
    const mutations: [string, (value: Record<string, any>) => void, ReplayError["code"]][] = [
      ["missing kind", value => { delete value.kind; }, "malformed"],
      ["extra field", value => { value.extra = true; }, "malformed"],
      ["empty id", value => { value.id = ""; }, "malformed"],
      ["sequence gap", value => { value.records[2].seq = 5; }, "malformed"],
      ["first operation", value => { value.records[0].op = { type: "input", atMs: 1000, input: 1 }; }, "malformed"],
      ["backwards clock", value => { value.records[2].op.atMs = 900; }, "malformed"],
      ["handling observation", value => { value.records[3].op.observedAtMs = 1100; }, "malformed"],
      ["unknown operation", value => { value.records[2].op = { type: "undo", atMs: 1016.5 }; }, "malformed"],
      ["missing operation field", value => { delete value.records[4].op.atMs; }, "malformed"],
      ["end timestamp", value => { value.end.atMs = 1300; }, "malformed"],
      ["end cursor", value => { value.end.afterSeq = 3; }, "malformed"],
      ["status", value => { value.end.status = "done"; }, "malformed"],
      ["summary chain", value => { value.summary.stats.chainLength = 3; }, "malformed"],
      ["nonfinite clock", value => { value.records[4].op.atMs = Infinity; }, "malformed"],
      ["negative clock", value => { value.records[4].op.atMs = -1; }, "malformed"],
      ["oversized timestamp", value => { value.records[4].op.atMs = MAX_TIMESTAMP_MS + 1; }, "malformed"],
      ["zero gravity", value => { value.initial.gravityMs = 0; }, "malformed"],
      ["bad seed", value => { value.initial.seed = 2 ** 31; }, "malformed"],
      ["empty journal", value => { value.records = []; value.end.afterSeq = -1; }, "malformed"],
    ];
    for (const [name, mutate, code] of mutations) {
      const value = JSON.parse(JSON.stringify(withIntegrity(soloPayload())));
      mutate(value);
      expectCode(() => decodeReplay(value), code);
    }
  });

  test("rejects malformed match envelopes, boundaries and summaries", () => {
    const mutations: [string, (value: Record<string, any>) => void, ReplayError["code"]][] = [
      ["boundary", value => { value.records[1].before.frame = 1; }, "malformed"],
      ["first nextRound", value => { value.records = [{ seq: 0, before: { round: 1, frame: 0 }, op: { type: "nextRound", seed: 12 } }]; }, "malformed"],
      ["epoch", value => { value.records[0].op.input.epoch = 1; }, "malformed"],
      ["future input after advance", value => {
        value.records.push({ seq: 4, before: { round: 1, frame: 10 }, op: { type: "submit",
          input: { player: "b", frame: 0, subframe: 0, order: 0, input: Input.Hold, epoch: 0 } } });
        value.end.afterSeq = 4;
      }, "malformed"],
      ["advance target", value => { value.records[2].op.reachedFrame = 11; }, "malformed"],
      ["end position", value => { value.end.frame = 11; }, "malformed"],
      ["end cursor", value => { value.end.afterSeq = 2; }, "malformed"],
      ["summary scores", value => { value.summary.scores = { a: 0 }; }, "malformed"],
      ["summary winner", value => { value.summary.winner = "c"; }, "malformed"],
      ["summary reason", value => { value.summary.reason = "survivor"; }, "malformed"],
      ["aborted winner", value => { value.summary.reason = "aborted"; }, "malformed"],
      ["round gap", value => { value.summary.rounds[0].round = 2; }, "malformed"],
      ["unknown operation", value => { value.records[1].op = { type: "pause" }; }, "malformed"],
      ["bad subframe", value => { value.records[0].op.input.subframe = 1; }, "malformed"],
      ["unrepresentable subframe", value => { value.records[0].op.input.subframe = 1 - Number.EPSILON; }, "malformed"],
      ["bad input", value => { value.records[0].op.input.input = 99; }, "malformed"],
      ["bad order", value => { value.records[0].op.input.order = -1; }, "malformed"],
      ["empty complete set", value => {
        value.records = []; value.end = { round: 1, frame: 0, afterSeq: -1, status: "complete",
          reason: "complete", finalStateDigest: "e".repeat(64) };
        value.summary = { scores: { a: 0, b: 0 }, winner: "a", reason: "firstTo", rounds: [] };
      }, "malformed"],
    ];
    for (const [name, mutate, code] of mutations) {
      const value = JSON.parse(JSON.stringify(withIntegrity(matchPayload())));
      mutate(value);
      expectCode(() => decodeReplay(value), code);
    }
  });
});

describe("replay limits", () => {
  test("bounds bytes, operations, players, duration, frames and strings", async () => {
    await expectRejects(() => decodeReplayJson(" ".repeat(DEFAULT_REPLAY_LIMITS.maxBytes + 1)), "resource-limit");
    await expectRejects(() => decodeReplayJson("{}", { maxBytes: 1 }), "resource-limit");
    await expectRejects(() => decodeReplayJson("not json"), "malformed");

    const solo = withIntegrity(soloPayload());
    const tooMany = { ...solo, records: [...solo.records, ...solo.records] };
    expectCode(() => decodeReplay(tooMany, { maxOperations: 8 }), "resource-limit");
    expectCode(() => decodeReplay(solo, { maxDurationMs: 199 }), "resource-limit");
    expectCode(() => decodeReplay(solo, { maxStringLength: 3 }), "resource-limit");
    expectCode(() => decodeReplay(withIntegrity(matchPayload()), { maxPlayers: 1 }), "resource-limit");
    expectCode(() => decodeReplay(withIntegrity(matchPayload()), { maxMatchFrames: 5 }), "resource-limit");
    expectCode(() => decodeReplay(solo, { maxBytes: 0 }), "malformed");
  });

  test("rejects oversized work across multiple advances", () => {
    const payload = withIntegrity(matchPayload());
    payload.records = [
      { seq: 0, before: { round: 1, frame: 0 }, op: { type: "advance", toFrame: 5, reachedFrame: 5 } },
      { seq: 1, before: { round: 1, frame: 5 }, op: { type: "advance", toFrame: 10, reachedFrame: 10 } },
    ];
    payload.end = { round: 1, frame: 10, afterSeq: 1, status: "stopped", reason: "stopped",
      finalStateDigest: "f".repeat(64) };
    payload.summary = { scores: { a: 0, b: 0 }, winner: null, reason: "aborted", rounds: [] };
    expectCode(() => decodeReplay(payload, { maxMatchFrames: 8 }), "resource-limit");
  });
});
