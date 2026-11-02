import { GAME_STATE_VERSION, LEAGUE_LOCK, RULES_VERSION, type ClearStats, type FinesseStats } from "@42tris/core";
import { GARBAGE_PROFILE, MATCH_VERSION } from "@42tris/match";
import type { MatchInitial, MatchRecord } from "./match-driver";
import type { SoloInitial, SoloRecord } from "./solo-driver";
import { SPRINT_TARGET } from "./sprint-driver";

export const REPLAY_FORMAT_VERSION = 1 as const;
export const REPLAY_SIMULATION_VERSION = "42tris-replay-sim-v2" as const;
export const SOLO_MODE_ID = "42tris-local" as const;
export const SOLO_MODE_VERSION = 1 as const;
export const SPRINT_MODE_ID = "42tris-sprint" as const;
export const SPRINT_MODE_VERSION = 1 as const;
export const MATCH_MODE_ID = "42tris-competitive" as const;
export const MATCH_MODE_VERSION = 1 as const;
export const MAX_TIMESTAMP_MS = Number.MAX_SAFE_INTEGER;
export const SHA256_ALGORITHM = "SHA-256" as const;

export const REPLAY_STATUSES = ["complete", "stopped", "incomplete"] as const;
export type ReplayStatus = (typeof REPLAY_STATUSES)[number];

export const MATCH_SUMMARY_REASONS = ["firstTo", "forfeit", "aborted"] as const;
export type MatchSummaryReason = (typeof MATCH_SUMMARY_REASONS)[number];
export const MATCH_ROUND_REASONS = ["survivor", "draw", "forfeit"] as const;
export type MatchRoundReason = (typeof MATCH_ROUND_REASONS)[number];

export interface ReplayVersions {
  format: typeof REPLAY_FORMAT_VERSION;
  simulation: string;
  coreState: number;
  coreRules: string;
  matchState?: number;
  garbage?: string;
}

export const CURRENT_REPLAY_VERSIONS: Readonly<ReplayVersions> = Object.freeze({
  format: REPLAY_FORMAT_VERSION,
  simulation: REPLAY_SIMULATION_VERSION,
  coreState: GAME_STATE_VERSION,
  coreRules: RULES_VERSION,
  matchState: MATCH_VERSION,
  garbage: GARBAGE_PROFILE,
});

export interface ReplayIntegrity {
  algorithm: typeof SHA256_ALGORITHM;
  digest: string;
}

export interface ReplayMode<Id extends string, Version extends number, Config> {
  id: Id;
  version: Version;
  config: Config;
}

export interface SoloModeConfig {
  zen: false;
}

export interface SprintModeConfig {
  target: typeof SPRINT_TARGET;
}

export interface MatchModeConfig {
  attacksEnabled: true;
  lockProfile: typeof LEAGUE_LOCK;
}

export type LocalSoloReplayMode = ReplayMode<typeof SOLO_MODE_ID, typeof SOLO_MODE_VERSION, SoloModeConfig>;
export type SprintSoloReplayMode = ReplayMode<typeof SPRINT_MODE_ID, typeof SPRINT_MODE_VERSION, SprintModeConfig>;
export type SoloReplayMode = LocalSoloReplayMode | SprintSoloReplayMode;
export type MatchReplayMode = ReplayMode<typeof MATCH_MODE_ID, typeof MATCH_MODE_VERSION, MatchModeConfig>;

export interface LocalReplaySummary {
  stats: ClearStats;
  topOut: boolean;
}

export interface SprintReplaySummary {
  outcome: "complete" | "failed";
  elapsedMs: number;
  stats: ClearStats;
  finesse: FinesseStats;
  topOut: boolean;
}

export type SoloReplaySummary = LocalReplaySummary | SprintReplaySummary;

export interface SoloReplayEnd {
  atMs: number;
  afterSeq: number;
  status: ReplayStatus;
  reason: string;
  finalStateDigest: string;
}

export interface MatchRoundSummary {
  round: number;
  frame: number;
  winner: string | null;
  complete: boolean;
  /** Optional assertion of the authored roundEnd reason; verified when present. */
  reason?: MatchRoundReason;
}

export interface MatchReplaySummary {
  scores: Record<string, number>;
  winner: string | null;
  reason: MatchSummaryReason;
  rounds: MatchRoundSummary[];
}

export interface MatchReplayEnd {
  round: number;
  frame: number;
  afterSeq: number;
  status: ReplayStatus;
  reason: string;
  finalStateDigest: string;
}

interface ReplayBase<Kind extends "solo" | "match", Mode, Initial, Record, Summary, End> {
  versions: ReplayVersions;
  id: string;
  kind: Kind;
  mode: Mode;
  initial: Initial;
  records: Record[];
  end: End;
  summary: Summary;
  integrity: ReplayIntegrity;
}

export interface LocalSoloReplay extends ReplayBase<"solo", LocalSoloReplayMode, SoloInitial, SoloRecord, LocalReplaySummary, SoloReplayEnd> {}
export interface SprintReplay extends ReplayBase<"solo", SprintSoloReplayMode, SoloInitial, SoloRecord, SprintReplaySummary, SoloReplayEnd> {}
export interface MatchReplay extends ReplayBase<"match", MatchReplayMode, MatchInitial, MatchRecord, MatchReplaySummary, MatchReplayEnd> {}

export type SoloReplay = LocalSoloReplay | SprintReplay;
export type Replay = SoloReplay | MatchReplay;
export type UnsignedLocalSoloReplay = Omit<LocalSoloReplay, "integrity">;
export type UnsignedSprintReplay = Omit<SprintReplay, "integrity">;
export type UnsignedSoloReplay = UnsignedLocalSoloReplay | UnsignedSprintReplay;
export type UnsignedMatchReplay = Omit<MatchReplay, "integrity">;
export type UnsignedReplay = UnsignedSoloReplay | UnsignedMatchReplay;
