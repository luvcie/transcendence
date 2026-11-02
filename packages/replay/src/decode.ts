import { FRAME_MS, GAME_STATE_VERSION, LEAGUE_LOCK, RULES_VERSION, type ClearStats, type FinesseStats } from "@42tris/core";
import { GARBAGE_PROFILE, MATCH_VERSION } from "@42tris/match";
import { canonicalJson, sha256 } from "./canonical";
import { ReplayError } from "./errors";
import {
  CURRENT_REPLAY_VERSIONS,
  MATCH_MODE_ID,
  MATCH_MODE_VERSION,
  MATCH_ROUND_REASONS,
  MATCH_SUMMARY_REASONS,
  MAX_TIMESTAMP_MS,
  REPLAY_FORMAT_VERSION,
  REPLAY_STATUSES,
  SHA256_ALGORITHM,
  SOLO_MODE_ID,
  SOLO_MODE_VERSION,
  SPRINT_MODE_ID,
  SPRINT_MODE_VERSION,
  type MatchReplay,
  type MatchReplayEnd,
  type MatchReplaySummary,
  type MatchRoundReason,
  type MatchRoundSummary,
  type Replay,
  type ReplayIntegrity,
  type ReplayStatus,
  type ReplayVersions,
  type SoloReplay,
  type SoloReplayEnd,
  type SoloReplayMode,
  type SprintReplay,
  type SprintReplaySummary,
  type UnsignedMatchReplay,
  type UnsignedReplay,
  type UnsignedSoloReplay,
} from "./format";
import {
  DEFAULT_REPLAY_LIMITS,
  resolveReplayLimits,
  type ReplayDecodeOptions,
  type ReplayLimits,
} from "./limits";
import {
  validateMatchInitial,
  validateMatchRecord,
  type MatchInitial,
  type MatchOperation,
  type MatchRecord,
} from "./match-driver";
import {
  validateSoloInitial,
  validateSoloRecord,
  type SoloInitial,
  type SoloOperation,
  type SoloRecord,
} from "./solo-driver";
import { SPRINT_TARGET, validateSprintInitial } from "./sprint-driver";

type ObjectValue = Record<string, unknown>;

const INTEGRITY_DIGEST = /^[0-9a-f]{64}$/;
const STATUSES = new Set<string>(REPLAY_STATUSES);
const MATCH_REASONS = new Set<string>(MATCH_SUMMARY_REASONS);
const MATCH_ROUND_REASON_SET = new Set<string>(MATCH_ROUND_REASONS);

function malformed(message: string): never {
  throw new ReplayError("malformed", message);
}

function unsupported(message: string): never {
  throw new ReplayError("unsupported", message);
}

function resourceLimit(message: string): never {
  throw new ReplayError("resource-limit", message);
}

function isObject(value: unknown): value is ObjectValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function object(value: unknown, required: readonly string[], optional: readonly string[] = []): asserts value is ObjectValue {
  if (!isObject(value)) malformed("Expected an object");
  const keys = Object.keys(value);
  if (required.some(key => !Object.hasOwn(value, key))
    || keys.some(key => !required.includes(key) && !optional.includes(key))) {
    malformed("Invalid fields");
  }
}

function array(value: unknown, maxLength: number, name: string): asserts value is unknown[] {
  if (!Array.isArray(value)) malformed(`Expected ${name} array`);
  if (value.length > maxLength) resourceLimit(`${name} limit exceeded`);
}

function integer(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    malformed("Invalid integer");
  }
}

function clock(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > MAX_TIMESTAMP_MS) {
    malformed("Invalid timestamp");
  }
}

function text(value: unknown, maxLength: number, name: string, allowEmpty = false): asserts value is string {
  if (typeof value !== "string") malformed(`Invalid ${name}`);
  if ((!allowEmpty && value.length === 0) || value.length > maxLength) {
    if (value.length > maxLength) resourceLimit(`${name} limit exceeded`);
    malformed(`Invalid ${name}`);
  }
}

function status(value: unknown): asserts value is ReplayStatus {
  if (typeof value !== "string" || !STATUSES.has(value)) malformed("Invalid replay status");
}

function digest(value: unknown): asserts value is string {
  if (typeof value !== "string" || !INTEGRITY_DIGEST.test(value)) malformed("Invalid digest");
}

function copyHandling(value: { das: number; arr: number; sddas: number; sdarr: number }) {
  return { das: value.das, arr: value.arr, sddas: value.sddas, sdarr: value.sdarr };
}

function copyVersions(value: unknown, kind: "solo" | "match"): ReplayVersions {
  object(value, ["format", "simulation", "coreState", "coreRules"], ["matchState", "garbage"]);
  if (typeof value.format !== "number" || !Number.isSafeInteger(value.format)) malformed("Invalid format version");
  if (value.format !== REPLAY_FORMAT_VERSION) unsupported("Unsupported replay format version");
  if (typeof value.simulation !== "string") malformed("Invalid simulation version");
  if (value.simulation !== CURRENT_REPLAY_VERSIONS.simulation) unsupported("Unsupported simulation version");
  if (typeof value.coreState !== "number" || !Number.isSafeInteger(value.coreState)) malformed("Invalid core state version");
  if (value.coreState !== GAME_STATE_VERSION) unsupported("Unsupported core state version");
  if (typeof value.coreRules !== "string") malformed("Invalid core rules version");
  if (value.coreRules !== RULES_VERSION) unsupported("Unsupported core rules version");
  if (kind === "match" && (!Object.hasOwn(value, "matchState") || !Object.hasOwn(value, "garbage"))) {
    malformed("Match replays require match compatibility identifiers");
  }
  if (Object.hasOwn(value, "matchState")) {
    if (typeof value.matchState !== "number" || !Number.isSafeInteger(value.matchState)) malformed("Invalid match state version");
    if (value.matchState !== MATCH_VERSION) unsupported("Unsupported match state version");
  }
  if (Object.hasOwn(value, "garbage")) {
    if (typeof value.garbage !== "string") malformed("Invalid garbage profile");
    if (value.garbage !== GARBAGE_PROFILE) unsupported("Unsupported garbage profile");
  }
  return {
    format: REPLAY_FORMAT_VERSION,
    simulation: value.simulation,
    coreState: value.coreState,
    coreRules: value.coreRules,
    ...(Object.hasOwn(value, "matchState") ? { matchState: value.matchState as number } : {}),
    ...(Object.hasOwn(value, "garbage") ? { garbage: value.garbage as string } : {}),
  };
}

function copySoloMode(value: unknown): SoloReplayMode {
  object(value, ["id", "version", "config"]);
  if (typeof value.id !== "string") malformed("Invalid mode identifier");
  if (value.id === SOLO_MODE_ID) {
    integer(value.version, 0);
    if (value.version !== SOLO_MODE_VERSION) unsupported("Unsupported solo mode version");
    object(value.config, ["zen"]);
    if (value.config.zen === true) unsupported("Zen replay is unsupported");
    if (value.config.zen !== false) malformed("Invalid solo mode configuration");
    return { id: SOLO_MODE_ID, version: SOLO_MODE_VERSION, config: { zen: false as const } };
  }
  if (value.id === SPRINT_MODE_ID) {
    integer(value.version, 0);
    if (value.version !== SPRINT_MODE_VERSION) unsupported("Unsupported sprint mode version");
    object(value.config, ["target"]);
    integer(value.config.target, 1);
    if (value.config.target !== SPRINT_TARGET) malformed("Invalid Sprint target");
    return { id: SPRINT_MODE_ID, version: SPRINT_MODE_VERSION, config: { target: SPRINT_TARGET } };
  }
  return unsupported("Unsupported solo mode");
}

function copyMatchMode(value: unknown) {
  object(value, ["id", "version", "config"]);
  if (typeof value.id !== "string") malformed("Invalid mode identifier");
  if (value.id !== MATCH_MODE_ID) unsupported("Unsupported match mode");
  integer(value.version, 0);
  if (value.version !== MATCH_MODE_VERSION) unsupported("Unsupported match mode version");
  object(value.config, ["attacksEnabled", "lockProfile"]);
  if (typeof value.config.attacksEnabled !== "boolean") malformed("Invalid attacks configuration");
  if (value.config.attacksEnabled !== true) unsupported("Competitive replay requires attacks");
  if (typeof value.config.lockProfile !== "string") malformed("Invalid lock profile");
  if (value.config.lockProfile !== LEAGUE_LOCK) unsupported("Unsupported lock profile");
  return {
    id: MATCH_MODE_ID,
    version: MATCH_MODE_VERSION,
    config: { attacksEnabled: true as const, lockProfile: LEAGUE_LOCK as typeof LEAGUE_LOCK },
  };
}

function copyIntegrity(value: unknown): ReplayIntegrity {
  object(value, ["algorithm", "digest"]);
  if (typeof value.algorithm !== "string") malformed("Invalid integrity algorithm");
  if (value.algorithm !== SHA256_ALGORITHM) unsupported("Unsupported integrity algorithm");
  digest(value.digest);
  return { algorithm: SHA256_ALGORITHM, digest: value.digest };
}

function copySoloInitial(value: unknown): SoloInitial {
  if (isObject(value) && value.zen === true) unsupported("Zen replay is unsupported");
  try {
    validateSoloInitial(value);
  } catch {
    malformed("Invalid solo initial state");
  }
  if (value.gravityMs > MAX_TIMESTAMP_MS) malformed("Invalid gravity");
  return {
    seed: value.seed,
    gravityMs: value.gravityMs,
    previewCount: value.previewCount,
    handling: copyHandling(value.handling),
    readyMs: value.readyMs,
    lockProfile: value.lockProfile,
    width: value.width,
    zen: false,
  };
}

function copyMatchInitial(value: unknown, limits: ReplayLimits): MatchInitial {
  if (isObject(value) && value.mode === "practice") unsupported("Practice replay is unsupported");
  try {
    validateMatchInitial(value);
  } catch {
    malformed("Invalid match initial state");
  }
  if (value.players.length > limits.maxPlayers) resourceLimit("Player limit exceeded");
  for (const player of value.players) {
    if (player.length > limits.maxStringLength) resourceLimit("Player identifier limit exceeded");
  }
  return {
    players: [...value.players],
    width: value.width,
    seed: value.seed,
    firstTo: value.firstTo,
    handlingByPlayer: Object.fromEntries(value.players.map(player => [player, copyHandling(value.handlingByPlayer[player])])),
    mode: "competitive",
    attacksEnabled: true,
    lockProfile: LEAGUE_LOCK,
  };
}

function copySoloOperation(value: SoloOperation): SoloOperation {
  switch (value.type) {
    case "tick": return { type: "tick", atMs: value.atMs };
    case "input": return { type: "input", atMs: value.atMs, input: value.input };
    case "pause": return { type: "pause", atMs: value.atMs, paused: value.paused };
    case "handling": return { type: "handling", observedAtMs: value.observedAtMs, handling: copyHandling(value.handling) };
  }
}

function copyMatchOperation(value: MatchOperation): MatchOperation {
  switch (value.type) {
    case "submit": return {
      type: "submit",
      input: {
        player: value.input.player,
        frame: value.input.frame,
        subframe: value.input.subframe,
        order: value.input.order,
        input: value.input.input,
        epoch: value.input.epoch,
      },
    };
    case "advance": return { type: "advance", toFrame: value.toFrame, reachedFrame: value.reachedFrame };
    case "release": return value.player === undefined ? { type: "release" } : { type: "release", player: value.player };
    case "forfeit": return { type: "forfeit", player: value.player };
    case "nextRound": return { type: "nextRound", seed: value.seed };
  }
}

function copySoloRecords(value: unknown[], limits: ReplayLimits, sprint: boolean): { records: SoloRecord[]; lastAt: number } {
  if (value.length === 0) malformed("Solo replay requires an initialization tick");
  const records: SoloRecord[] = [];
  let firstAt = -1;
  let lastAt = -1;
  for (let index = 0; index < value.length; index++) {
    const raw = value[index];
    try {
      validateSoloRecord(raw);
    } catch {
      malformed("Invalid solo record");
    }
    if (raw.seq !== index) malformed("Non-contiguous solo record sequence");
    const op = raw.op;
    if (index === 0) {
      if (op.type !== "tick") malformed("First solo operation must be a tick");
      clock(op.atMs);
      firstAt = op.atMs;
      lastAt = op.atMs;
    } else if (op.type === "handling") {
      clock(op.observedAtMs);
      if (sprint) {
        if (op.observedAtMs < lastAt) malformed("Sprint clock moved backwards");
        lastAt = op.observedAtMs;
      } else if (op.observedAtMs !== lastAt) {
        malformed("Handling observation does not match the current clock");
      }
    } else {
      clock(op.atMs);
      if (op.atMs < lastAt) malformed("Solo clock moved backwards");
      lastAt = op.atMs;
      if (sprint && op.type === "pause") malformed("Sprint does not support pause operations");
    }
    if (lastAt - firstAt > limits.maxDurationMs) resourceLimit(`${sprint ? "Sprint" : "Solo"} duration limit exceeded`);
    records.push({ seq: index, op: copySoloOperation(op) });
  }
  return { records, lastAt };
}

function copyMatchRecords(
  value: unknown[],
  initial: MatchInitial,
  limits: ReplayLimits,
): { records: MatchRecord[]; round: number; frame: number } {
  const records: MatchRecord[] = [];
  const withdrawn = new Set<string>();
  let round = 1;
  let frame = 0;
  let advancedFrames = 0;
  let ended: "active" | "ended" | "unknown" = "active";

  for (let index = 0; index < value.length; index++) {
    const raw = value[index];
    try {
      validateMatchRecord(raw, initial.players);
    } catch {
      malformed("Invalid match record");
    }
    if (raw.seq !== index) malformed("Non-contiguous match record sequence");
    if (raw.before.round !== round || raw.before.frame !== frame) {
      malformed("Match record boundary does not match the recorded position");
    }
    if (raw.before.frame > limits.maxMatchFrames) resourceLimit("Match frame limit exceeded");

    const op = raw.op;
    switch (op.type) {
      case "submit":
        if (ended === "ended") malformed("Input submitted after the round ended");
        if (withdrawn.has(op.input.player)) malformed("Input submitted for a withdrawn player");
        if (op.input.frame < frame) malformed("Input submitted for an elapsed frame");
        if (op.input.frame > limits.maxMatchFrames) resourceLimit("Match frame limit exceeded");
        if (op.input.epoch !== round - 1) malformed("Invalid input epoch");
        {
          const at = (op.input.frame + op.input.subframe) * FRAME_MS;
          if (!Number.isSafeInteger(op.input.frame + 1) || !Number.isFinite(at)
            || at < op.input.frame * FRAME_MS || at >= (op.input.frame + 1) * FRAME_MS) {
            malformed("Unrepresentable input timestamp");
          }
        }
        break;
      case "advance": {
        if (op.toFrame > limits.maxMatchFrames || op.reachedFrame > limits.maxMatchFrames) {
          resourceLimit("Match frame limit exceeded");
        }
        if (op.toFrame < frame || op.reachedFrame < frame || op.reachedFrame > op.toFrame) {
          malformed("Invalid advance boundaries");
        }
        if (op.reachedFrame - frame > limits.maxMatchFrames - advancedFrames) resourceLimit("Match frame budget exceeded");
        advancedFrames += op.reachedFrame - frame;
        if (op.toFrame > frame) ended = op.reachedFrame < op.toFrame ? "ended" : "unknown";
        frame = op.reachedFrame;
        break;
      }
      case "release":
        break;
      case "forfeit":
        if (!withdrawn.has(op.player)) {
          withdrawn.add(op.player);
          if (ended !== "ended") {
            ended = withdrawn.size >= initial.players.length - 1 ? "ended" : "unknown";
          }
        }
        break;
      case "nextRound":
        if (ended === "active") malformed("Next round started before the current round ended");
        round++;
        frame = 0;
        ended = "active";
        break;
    }
    records.push({
      seq: index,
      before: { round: raw.before.round, frame: raw.before.frame },
      op: copyMatchOperation(op),
    });
  }
  return { records, round, frame };
}

function copySoloEnd(value: unknown, records: readonly SoloRecord[], lastAt: number, limits: ReplayLimits): SoloReplayEnd {
  object(value, ["atMs", "afterSeq", "status", "reason", "finalStateDigest"]);
  clock(value.atMs);
  integer(value.afterSeq, -1);
  if (value.afterSeq !== records.length - 1) malformed("Solo end cursor does not match the record count");
  if (value.atMs !== lastAt) malformed("Solo end timestamp does not match the final observation");
  status(value.status);
  text(value.reason, limits.maxStringLength, "end reason");
  digest(value.finalStateDigest);
  return {
    atMs: value.atMs,
    afterSeq: value.afterSeq,
    status: value.status,
    reason: value.reason,
    finalStateDigest: value.finalStateDigest,
  };
}

function copyClearStats(value: unknown): ClearStats {
  object(value, ["pieces", "lines", "combo", "chainLength", "b2b", "surge", "attack"]);
  integer(value.pieces, 0);
  integer(value.lines, 0);
  integer(value.combo, -1);
  integer(value.chainLength, 0);
  integer(value.b2b, 0);
  integer(value.surge, 0);
  integer(value.attack, 0);
  if (value.b2b !== Math.max(0, value.chainLength - 1)) malformed("Invalid summary chain state");
  if (value.surge !== (value.b2b >= 4 ? value.b2b : 0)) malformed("Invalid summary surge state");
  return {
    pieces: value.pieces,
    lines: value.lines,
    combo: value.combo,
    chainLength: value.chainLength,
    b2b: value.b2b,
    surge: value.surge,
    attack: value.attack,
  };
}

function copyFinesse(value: unknown): FinesseStats {
  object(value, ["evaluated", "faults", "points"]);
  integer(value.evaluated, 0);
  integer(value.faults, 0, value.evaluated);
  integer(value.points, 0, 5 * value.evaluated);
  return { evaluated: value.evaluated, faults: value.faults, points: value.points };
}

function copySoloSummary(value: unknown) {
  object(value, ["stats", "topOut"]);
  const stats = copyClearStats(value.stats);
  if (typeof value.topOut !== "boolean") malformed("Invalid top-out flag");
  return { stats, topOut: value.topOut };
}

function copySprintSummary(value: unknown, limits: ReplayLimits): SprintReplaySummary {
  object(value, ["outcome", "elapsedMs", "stats", "finesse", "topOut"]);
  if (value.outcome !== "complete" && value.outcome !== "failed") malformed("Invalid Sprint outcome");
  clock(value.elapsedMs);
  if (value.elapsedMs > limits.maxDurationMs) resourceLimit("Sprint duration limit exceeded");
  const stats = copyClearStats(value.stats);
  const finesse = copyFinesse(value.finesse);
  if (typeof value.topOut !== "boolean") malformed("Invalid top-out flag");
  if (value.outcome === "failed" && !value.topOut) malformed("Failed Sprint attempt requires top-out");
  return { outcome: value.outcome, elapsedMs: value.elapsedMs, stats, finesse, topOut: value.topOut };
}

function copyMatchEnd(
  value: unknown,
  records: readonly MatchRecord[],
  round: number,
  frame: number,
  limits: ReplayLimits,
): MatchReplayEnd {
  object(value, ["round", "frame", "afterSeq", "status", "reason", "finalStateDigest"]);
  integer(value.round, 1);
  integer(value.frame, 0, limits.maxMatchFrames);
  integer(value.afterSeq, -1);
  if (value.round !== round || value.frame !== frame) malformed("Match end position does not match the record journal");
  if (value.afterSeq !== records.length - 1) malformed("Match end cursor does not match the record count");
  status(value.status);
  if (value.status === "complete" && records.length === 0) malformed("Complete match replay requires records");
  text(value.reason, limits.maxStringLength, "end reason");
  digest(value.finalStateDigest);
  return {
    round: value.round,
    frame: value.frame,
    afterSeq: value.afterSeq,
    status: value.status,
    reason: value.reason,
    finalStateDigest: value.finalStateDigest,
  };
}

function copyMatchSummary(
  value: unknown,
  initial: MatchInitial,
  limits: ReplayLimits,
): MatchReplaySummary {
  object(value, ["scores", "winner", "reason", "rounds"]);
  object(value.scores, initial.players);
  const scores: Record<string, number> = {};
  for (const player of initial.players) {
    integer(value.scores[player], 0);
    scores[player] = value.scores[player] as number;
  }
  if (value.winner !== null && (typeof value.winner !== "string" || !initial.players.includes(value.winner))) {
    malformed("Invalid summary winner");
  }
  if (typeof value.reason !== "string" || !MATCH_REASONS.has(value.reason)) malformed("Invalid summary reason");
  if (value.reason === "aborted" && value.winner !== null) malformed("Aborted match cannot have a winner");
  if (value.reason !== "aborted" && value.winner === null) malformed("Completed match requires a winner");
  array(value.rounds, limits.maxOperations, "round summary");
  const rounds: MatchRoundSummary[] = [];
  for (const [index, item] of value.rounds.entries()) {
    object(item, ["round", "frame", "winner", "complete"], ["reason"]);
    integer(item.round, 1);
    integer(item.frame, 0, limits.maxMatchFrames);
    if (item.round !== index + 1) malformed("Round summaries must be contiguous");
    if (item.winner !== null && (typeof item.winner !== "string" || !initial.players.includes(item.winner))) {
      malformed("Invalid round winner");
    }
    if (typeof item.complete !== "boolean") malformed("Invalid round completion flag");
    let reason: MatchRoundReason | undefined;
    if (Object.hasOwn(item, "reason")) {
      if (typeof item.reason !== "string" || !MATCH_ROUND_REASON_SET.has(item.reason)) {
        malformed("Invalid round reason");
      }
      reason = item.reason as MatchRoundReason;
    }
    rounds.push({
      round: item.round,
      frame: item.frame,
      winner: item.winner,
      complete: item.complete,
      ...(reason === undefined ? {} : { reason }),
    });
  }
  return {
    scores,
    winner: value.winner,
    reason: value.reason as MatchReplaySummary["reason"],
    rounds,
  };
}

function decodeWithLimits(input: unknown, limits: ReplayLimits): Replay {
  object(input, ["versions", "id", "kind", "mode", "initial", "records", "end", "summary", "integrity"]);
  text(input.id, limits.maxStringLength, "replay identifier");
  if (typeof input.kind !== "string") malformed("Invalid replay kind");
  if (input.kind !== "solo" && input.kind !== "match") unsupported("Unsupported replay kind");
  const versions = copyVersions(input.versions, input.kind);
  array(input.records, limits.maxOperations, "operation");
  const integrity = copyIntegrity(input.integrity);

  if (input.kind === "solo") {
    const initial = copySoloInitial(input.initial);
    const mode = copySoloMode(input.mode);
    if (mode.id === SPRINT_MODE_ID) {
      try {
        validateSprintInitial(initial);
      } catch {
        malformed("Invalid Sprint initial state");
      }
    }
    const { records, lastAt } = copySoloRecords(input.records, limits, mode.id === SPRINT_MODE_ID);
    const end = copySoloEnd(input.end, records, lastAt, limits);
    if (mode.id === SPRINT_MODE_ID) {
      const summary = copySprintSummary(input.summary, limits);
      const replay: SprintReplay = { versions, id: input.id, kind: "solo", mode, initial, records, end, summary, integrity };
      return replay;
    }
    const summary = copySoloSummary(input.summary);
    return { versions, id: input.id, kind: "solo", mode, initial, records, end, summary, integrity };
  }

  const initial = copyMatchInitial(input.initial, limits);
  const mode = copyMatchMode(input.mode);
  const { records, round, frame } = copyMatchRecords(input.records, initial, limits);
  const end = copyMatchEnd(input.end, records, round, frame, limits);
  const summary = copyMatchSummary(input.summary, initial, limits);
  return { versions, id: input.id, kind: "match", mode, initial, records, end, summary, integrity };
}

export function decodeReplay(input: unknown, options: ReplayDecodeOptions = {}): Replay {
  const limits = resolveReplayLimits(options);
  try {
    return decodeWithLimits(input, limits);
  } catch (error) {
    if (error instanceof ReplayError) throw error;
    malformed(error instanceof Error ? error.message : "Invalid replay");
  }
}

export async function verifyReplayIntegrity(replay: Replay): Promise<void> {
  const digest = await computeReplayDigest(replay);
  if (digest !== replay.integrity.digest) {
    throw new ReplayError("integrity", "Replay digest mismatch");
  }
}

export async function decodeReplayWithIntegrity(input: unknown, options: ReplayDecodeOptions = {}): Promise<Replay> {
  const replay = decodeReplay(input, options);
  await verifyReplayIntegrity(replay);
  return replay;
}

export async function decodeReplayJson(text: string, options: ReplayDecodeOptions = {}): Promise<Replay> {
  const limits = resolveReplayLimits(options);
  if (typeof text !== "string") malformed("Replay JSON must be a string");
  if (text.length > limits.maxBytes) resourceLimit("Replay byte limit exceeded");
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > limits.maxBytes) resourceLimit("Replay byte limit exceeded");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    malformed("Invalid replay JSON");
  }
  const replay = decodeReplay(parsed, limits);
  await verifyReplayIntegrity(replay);
  return replay;
}

export async function computeReplayDigest(replay: Replay): Promise<string> {
  const { integrity: _integrity, ...payload } = replay;
  return sha256(payload);
}

export function encodeReplay(replay: Replay): string {
  return canonicalJson(decodeReplay(replay));
}

export async function sealReplay(payload: UnsignedSoloReplay): Promise<SoloReplay>;
export async function sealReplay(payload: UnsignedMatchReplay): Promise<MatchReplay>;
export async function sealReplay(payload: UnsignedReplay): Promise<Replay>;
export async function sealReplay(payload: UnsignedReplay): Promise<Replay> {
  let digest: string;
  try {
    digest = await sha256(payload);
  } catch {
    malformed("Invalid replay payload");
  }
  return decodeReplay({ ...payload, integrity: { algorithm: SHA256_ALGORITHM, digest } });
}

export function finalStatePayload(state: unknown, modeState: unknown = null): { state: unknown; modeState: unknown } {
  return { state, modeState };
}

export async function computeFinalStateDigest(state: unknown, modeState: unknown = null): Promise<string> {
  return sha256(finalStatePayload(state, modeState));
}

export { DEFAULT_REPLAY_LIMITS, type ReplayDecodeOptions, type ReplayLimits };
