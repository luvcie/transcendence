import { FRAME_MS } from "./handling";

// Bumping these strings invalidates old snapshots and replays that assumed the
// previous lock rules. Keep them in sync with core RULES.md.
export const PRACTICE_LOCK = "42tris-practice-lock-v2";
export const LEAGUE_LOCK = "42tris-league-lock-v3";
export type LockProfile = typeof PRACTICE_LOCK | typeof LEAGUE_LOCK;

export function validateLockProfile(value: unknown): asserts value is LockProfile {
  if (value !== PRACTICE_LOCK && value !== LEAGUE_LOCK) throw new RangeError("Invalid lock profile");
}

// Normal lock delay in milliseconds. Practice keeps its one-second local
// delay; league keeps the 30-frame (500ms) checkpoint delay.
export const PRACTICE_LOCK_DELAY_MS = 1000;
export const LEAGUE_LOCK_DELAY_FRAMES = 30;

// Successful lateral moves and rotations after first ground contact may restart
// the lock timer this many times per active piece. The sixteenth and later
// post-contact actions do not restart it. Pre-contact and failed actions never
// count.
export const LOCK_RESET_LIMIT = 15;

// Wall-clock limit from the piece's first ground contact. Once it expires the
// piece locks at its next grounded simulation point, never in midair.
export const MAX_GROUNDED_MS = 3000;

// League compares strictly against this threshold at Fall checkpoints.
export function lockDelay(profile: LockProfile): number {
  return profile === PRACTICE_LOCK ? PRACTICE_LOCK_DELAY_MS : LEAGUE_LOCK_DELAY_FRAMES * FRAME_MS;
}
