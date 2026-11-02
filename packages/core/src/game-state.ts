import { COLS, ROWS, validateBoardWidth } from "./board";
import type { GameEvent, LockResult } from "./game";
import { FRAME_MS, validateHandling, type Handling } from "./handling";
import { MINOS, type PieceId } from "./pieces";
import { RULES_VERSION } from "./rules";
import { LEAGUE_LOCK, lockDelay, validateLockProfile, type LockProfile } from "./lock-profile";

export const GAME_STATE_VERSION = 4;

export interface GameFields {
  piece: PieceId;
  rot: number;
  x: number;
  y: number;
  dealt: number;
  topOut: boolean;
  held: PieceId | null;
  holdUsed: boolean;
  lastWasRotation: boolean;
  lastKickIndex: number;
  lastNow: number;
  observedNow: number;
  fallAcc: number;
  lockElapsed: number;
  lockResets: number;
  rotationResets: number;
  lowestY: number;
  leagueOriginMs: number;
  leagueFrame: number;
  leaguePhase: number;
  leagueLockFrames: number;
  leftHeld: boolean;
  rightHeld: boolean;
  direction: number;
  moveAt: number | null;
  softHeld: boolean;
  softAt: number | null;
  readyMs: number;
  paused: boolean;
  sequence: number;
  finesseInputs: number;
  finesseInherited: boolean;
}

/** Exact continuation state. Zen undo history and controller functions are excluded. */
export interface GameState {
  version: typeof GAME_STATE_VERSION;
  rulesVersion: typeof RULES_VERSION;
  board: number[];
  previews: number[];
  bag: { rng: number; pieces: number[]; index: number };
  config: { width: number; gravityMs: number; handling: Handling; lockProfile: LockProfile };
  state: GameFields;
  lastResult: LockResult | null;
  events: GameEvent[];
  zenEnabled: boolean;
  settlementRequired: boolean;
}

const FIELD_KEYS = [
  "piece", "rot", "x", "y", "dealt", "topOut", "held", "holdUsed", "lastWasRotation", "lastKickIndex",
  "lastNow", "observedNow", "fallAcc", "lockElapsed", "leftHeld", "rightHeld", "direction", "moveAt",
  "softHeld", "softAt", "readyMs", "paused", "sequence",
  "lockResets", "rotationResets", "lowestY",
  "leagueOriginMs", "leagueFrame", "leaguePhase", "leagueLockFrames", "finesseInputs", "finesseInherited",
] as const;

function requireState(ok: boolean): asserts ok {
  if (!ok) throw new RangeError("Invalid GameState");
}

function record(value: unknown): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function number(value: unknown, min = 0, max = Number.MAX_VALUE): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): value is number {
  return number(value, min, max) && Number.isSafeInteger(value);
}

function cells(value: unknown, length: number, min: number, max: number): value is number[] {
  return Array.isArray(value) && value.length === length
    && Array.from(value).every(cell => integer(cell, min, max));
}

export function copyLock(result: LockResult): LockResult {
  return Object.freeze({
    type: "lock", sequence: result.sequence, atMs: result.atMs, piece: result.piece,
    rows: Object.freeze([...result.rows]), spin: result.spin, allClear: result.allClear,
    stats: Object.freeze({
      pieces: result.stats.pieces, lines: result.stats.lines, combo: result.stats.combo,
      chainLength: result.stats.chainLength, b2b: result.stats.b2b, surge: result.stats.surge,
      attack: result.stats.attack,
    }),
    finesse: Object.freeze({ ...result.finesse }),
    attacks: Object.freeze(result.attacks.map(attack => Object.freeze({ kind: attack.kind, lines: attack.lines }))),
  });
}

export function copyEvent(event: GameEvent): GameEvent {
  return event.type === "lock" ? copyLock(event)
    : Object.freeze({ type: "restored", sequence: event.sequence, atMs: event.atMs });
}

function validateEvent(event: GameEvent, sequence: number, observedNow: number): void {
  requireState(record(event) && integer(event.sequence, 1, sequence) && number(event.atMs, 0, observedNow));
  if (event.type === "restored") return;
  requireState(event.type === "lock" && integer(event.piece, 1, 7)
    && Array.isArray(event.rows) && event.rows.length <= 4
    && Array.from(event.rows).every((row, i) => integer(row, 0, 39) && (i === 0 || row > event.rows[i - 1]))
    && ["none", "mini", "full"].includes(event.spin) && typeof event.allClear === "boolean"
    && record(event.stats) && Array.isArray(event.attacks));
  requireState(record(event.finesse) && integer(event.finesse.evaluated) && integer(event.finesse.faults, 0, event.finesse.evaluated)
    && integer(event.finesse.points, 0, 5 * event.finesse.evaluated) && event.finesse.evaluated <= event.stats.pieces);
  const stats = event.stats;
  requireState(integer(stats.pieces, 1) && integer(stats.lines) && integer(stats.combo, -1)
    && integer(stats.chainLength) && integer(stats.b2b) && integer(stats.surge) && integer(stats.attack)
    && stats.b2b === Math.max(0, stats.chainLength - 1) && stats.surge === (stats.b2b >= 4 ? stats.b2b : 0));
  for (const attack of event.attacks) {
    requireState(record(attack) && ["normal", "surge", "allClear"].includes(attack.kind) && integer(attack.lines, 1));
  }
}

/** Validate unknown JSON and copy only the supported fields before any Game mutation. */
export function readGameState(value: unknown): GameState {
  requireState(record(value));
  const s = value as GameState;
  requireState(record(s.config));
  const width = s.config.width === undefined ? COLS : s.config.width;
  validateBoardWidth(width);
  requireState(s.version === GAME_STATE_VERSION && s.rulesVersion === RULES_VERSION
    && cells(s.board, width * ROWS, 0, 8) && Array.isArray(s.previews) && s.previews.length > 0
    && cells(s.previews, s.previews.length, 1, 7) && record(s.bag)
    && integer(s.bag.rng, -0x80000000, 0x7fffffff) && cells(s.bag.pieces, 7, 1, 7)
    && new Set(s.bag.pieces).size === 7 && integer(s.bag.index, 0, 7)
    && record(s.config) && number(s.config.gravityMs, Number.MIN_VALUE) && record(s.config.handling)
    && record(s.state) && typeof s.zenEnabled === "boolean" && typeof s.settlementRequired === "boolean");
  validateHandling(s.config.handling);
  validateLockProfile(s.config.lockProfile);
  const f = s.state;
  // A terminal timed lock can retain a few clock-scale rounding bits above 1000ms.
  const delay = lockDelay(s.config.lockProfile);
  const lockLimit = delay + (f.topOut ? 4 * Number.EPSILON * Math.max(delay, f.lastNow) : 0);
  for (const key of ["topOut", "holdUsed", "lastWasRotation", "leftHeld", "rightHeld", "softHeld", "paused", "finesseInherited"] as const) {
    requireState(typeof f[key] === "boolean");
  }
  requireState(integer(f.finesseInputs) && integer(f.piece, 1, 7) && integer(f.rot, 0, 3) && integer(f.x, -3, 9) && integer(f.y, -3, 39)
    && integer(f.lockResets, 0, 31) && integer(f.rotationResets, 0, 63) && integer(f.lowestY, -3, 39)
    && number(f.leagueOriginMs) && integer(f.leagueFrame, 1) && number(f.leaguePhase, 0, f.leagueFrame)
    && number(f.leagueLockFrames, 0, f.topOut ? Number.MAX_VALUE : 30)
    && integer(f.dealt) && (f.held === null || integer(f.held, 1, 7)) && integer(f.lastKickIndex, 0, 5)
    && (f.lastNow === -1 || number(f.lastNow)) && (f.observedNow === -1 || number(f.observedNow))
    && f.lastNow <= f.observedNow && number(f.fallAcc, 0, s.config.gravityMs) && number(f.lockElapsed, 0, lockLimit)
    && integer(f.direction, -1, 1) && (f.moveAt === null || number(f.moveAt, Math.max(0, f.lastNow)))
    && (f.softAt === null || number(f.softAt)) && number(f.readyMs) && integer(f.sequence)
    && (f.direction !== -1 || f.leftHeld) && (f.direction !== 1 || f.rightHeld)
    && (f.direction !== 0 || (f.moveAt === null && !f.leftHeld && !f.rightHeld))
    && (f.direction === 0 || f.moveAt !== null || s.config.handling.arr === 0)
    && (!(f.leftHeld || f.rightHeld || f.softHeld) || f.lastNow >= 0)
    && (f.softHeld ? f.softAt !== null : f.softAt === null));
  requireState(f.leaguePhase < f.leagueFrame);
  if (s.config.lockProfile === LEAGUE_LOCK && f.lastNow >= 0 && !f.readyMs) {
    requireState(f.leagueOriginMs <= f.lastNow
      && f.leagueOriginMs + f.leagueFrame * FRAME_MS > f.lastNow);
  }
  const minos = MINOS[f.piece][f.rot];
  for (let i = 0; i < minos.length; i += 2) {
    requireState(integer(f.x + minos[i], 0, width - 1) && integer(f.y + minos[i + 1], 0, 39));
  }
  requireState(Array.isArray(s.events));
  if (s.lastResult !== null) {
    validateEvent(s.lastResult, f.sequence, f.observedNow);
    requireState(s.lastResult.type === "lock");
  }
  let previous = 0;
  for (const event of s.events) {
    validateEvent(event, f.sequence, f.observedNow);
    requireState(event.sequence > previous);
    previous = event.sequence;
  }
  const state = {} as GameFields;
  for (const key of FIELD_KEYS) Object.assign(state, { [key]: f[key] });
  return {
    version: GAME_STATE_VERSION, rulesVersion: RULES_VERSION,
    board: [...s.board], previews: [...s.previews], bag: { rng: s.bag.rng, pieces: [...s.bag.pieces], index: s.bag.index },
    config: { width, gravityMs: s.config.gravityMs, lockProfile: s.config.lockProfile, handling: {
      das: s.config.handling.das, arr: s.config.handling.arr, sddas: s.config.handling.sddas, sdarr: s.config.handling.sdarr,
    } },
    state, lastResult: s.lastResult === null ? null : copyLock(s.lastResult), events: s.events.map(copyEvent),
    zenEnabled: s.zenEnabled, settlementRequired: s.settlementRequired,
  };
}
