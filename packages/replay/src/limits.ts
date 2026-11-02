import { ReplayError } from "./errors";

export interface ReplayDecodeOptions {
  maxBytes?: number;
  maxOperations?: number;
  maxPlayers?: number;
  maxDurationMs?: number;
  maxMatchFrames?: number;
  maxStringLength?: number;
}

export interface ReplayLimits {
  maxBytes: number;
  maxOperations: number;
  maxPlayers: number;
  maxDurationMs: number;
  maxMatchFrames: number;
  maxStringLength: number;
}

export const DEFAULT_REPLAY_LIMITS: Readonly<ReplayLimits> = Object.freeze({
  maxBytes: 32 * 1024 * 1024,
  maxOperations: 1_000_000,
  maxPlayers: 8,
  maxDurationMs: 2 * 60 * 60 * 1000,
  maxMatchFrames: 2 * 60 * 60 * 60,
  maxStringLength: 256,
});

function limit(value: unknown, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new ReplayError("malformed", `Invalid ${name} limit`);
  }
  return value as number;
}

export function resolveReplayLimits(options: ReplayDecodeOptions = {}): ReplayLimits {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new ReplayError("malformed", "Invalid decode options");
  }
  return {
    maxBytes: limit(options.maxBytes, DEFAULT_REPLAY_LIMITS.maxBytes, "byte"),
    maxOperations: limit(options.maxOperations, DEFAULT_REPLAY_LIMITS.maxOperations, "operation"),
    maxPlayers: limit(options.maxPlayers, DEFAULT_REPLAY_LIMITS.maxPlayers, "player"),
    maxDurationMs: limit(options.maxDurationMs, DEFAULT_REPLAY_LIMITS.maxDurationMs, "duration"),
    maxMatchFrames: limit(options.maxMatchFrames, DEFAULT_REPLAY_LIMITS.maxMatchFrames, "frame"),
    maxStringLength: limit(options.maxStringLength, DEFAULT_REPLAY_LIMITS.maxStringLength, "string"),
  };
}
