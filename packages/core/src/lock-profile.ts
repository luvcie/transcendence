import { FRAME_MS } from "./handling";

export const PRACTICE_LOCK = "42tris-practice-lock-v1";
export const LEAGUE_LOCK = "42tris-league-lock-v2";
export type LockProfile = typeof PRACTICE_LOCK | typeof LEAGUE_LOCK;

export function validateLockProfile(value: unknown): asserts value is LockProfile {
  if (value !== PRACTICE_LOCK && value !== LEAGUE_LOCK) throw new RangeError("Invalid lock profile");
}

// League compares strictly against this threshold at Fall checkpoints.
export function lockDelay(profile: LockProfile): number {
  return profile === PRACTICE_LOCK ? 1000 : 30 * FRAME_MS;
}
