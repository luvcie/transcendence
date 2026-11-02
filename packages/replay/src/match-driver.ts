import { Input, LEAGUE_LOCK, validateBoardWidth, validateHandling, type Handling } from "@42tris/core";
import { Match, type MatchEvent, type MatchInput, type MatchState } from "@42tris/match";

export type MatchOperation =
  | { type: "submit"; input: Required<MatchInput> }
  | { type: "advance"; toFrame: number; reachedFrame: number }
  | { type: "release"; player?: string }
  | { type: "forfeit"; player: string }
  | { type: "nextRound"; seed: number };

export interface MatchRecord {
  seq: number;
  before: { round: number; frame: number };
  op: MatchOperation;
}

export interface MatchInitial {
  players: string[];
  width: number;
  seed: number;
  firstTo: number;
  handlingByPlayer: Record<string, Handling>;
  mode: "competitive";
  attacksEnabled: true;
  lockProfile: typeof LEAGUE_LOCK;
}

export const MAX_MATCH_FRAMES = 2 * 60 * 60 * 60;
const MAX_PLAYERS = 8;
const MAX_ID_LENGTH = 128;
const INPUTS = new Set<number>(Object.values(Input));

function object(value: unknown, required: readonly string[], optional: readonly string[] = []): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new RangeError("Expected object");
  const keys = Object.keys(value);
  if (required.some(key => !Object.hasOwn(value, key)) || keys.some(key => !required.includes(key) && !optional.includes(key))) {
    throw new RangeError("Invalid fields");
  }
}
function integer(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new RangeError("Invalid integer");
}
function seed(value: unknown): asserts value is number { integer(value, -0x80000000, 0x7fffffff); }
function id(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_ID_LENGTH) throw new RangeError("Invalid player ID");
}
function handling(value: unknown): asserts value is Handling {
  object(value, ["das", "arr", "sddas", "sdarr"]);
  validateHandling(value as Handling);
}

export function validateMatchInitial(value: unknown): asserts value is MatchInitial {
  object(value, ["players", "width", "seed", "firstTo", "handlingByPlayer", "mode", "attacksEnabled", "lockProfile"]);
  if (!Array.isArray(value.players) || value.players.length < 2 || value.players.length > MAX_PLAYERS) throw new RangeError("Invalid roster");
  value.players.forEach(id);
  if (new Set(value.players).size !== value.players.length || value.players.some((p, i, a) => i > 0 && a[i - 1] >= p)) throw new RangeError("Roster must be sorted and unique");
  integer(value.width, 4, 12); validateBoardWidth(value.width);
  seed(value.seed); integer(value.firstTo, 1, 100);
  if (value.mode !== "competitive" || value.attacksEnabled !== true || value.lockProfile !== LEAGUE_LOCK) throw new RangeError("Only competitive matches are supported");
  object(value.handlingByPlayer, value.players);
  for (const player of value.players) handling(value.handlingByPlayer[player]);
}

export function validateMatchRecord(value: unknown, roster: readonly string[]): asserts value is MatchRecord {
  object(value, ["seq", "before", "op"]);
  integer(value.seq, 0); object(value.before, ["round", "frame"]);
  integer(value.before.round, 1); integer(value.before.frame, 0, MAX_MATCH_FRAMES);
  const op = value.op;
  object(op, ["type"], ["input", "toFrame", "reachedFrame", "player", "seed"]);
  const player = (p: unknown): void => { id(p); if (!roster.includes(p)) throw new RangeError("Unknown player"); };
  switch (op.type) {
    case "submit": {
      object(op, ["type", "input"]); const input = op.input;
      object(input, ["player", "frame", "subframe", "order", "input", "epoch"]);
      player(input.player); integer(input.frame, 0, MAX_MATCH_FRAMES); integer(input.order, 0); integer(input.epoch, 0);
      if (typeof input.subframe !== "number" || !Number.isFinite(input.subframe) || input.subframe < 0 || input.subframe >= 1
        || typeof input.input !== "number" || !INPUTS.has(input.input)) throw new RangeError("Invalid input");
      break;
    }
    case "advance":
      object(op, ["type", "toFrame", "reachedFrame"]); integer(op.toFrame, 0, MAX_MATCH_FRAMES); integer(op.reachedFrame, 0, MAX_MATCH_FRAMES); break;
    case "release": object(op, ["type"], ["player"]); if (Object.hasOwn(op, "player")) player(op.player); break;
    case "forfeit": object(op, ["type", "player"]); player(op.player); break;
    case "nextRound": object(op, ["type", "seed"]); seed(op.seed); break;
    default: throw new RangeError("Unknown match operation");
  }
}

/** Executes completed journal entries only. Imported checkpoints are never accepted here. */
export class MatchDriver {
  private match: Match;
  private frames = 0;
  private cursor = 0;
  private pending: MatchRecord | null = null;
  constructor(initial: MatchInitial) {
    validateMatchInitial(initial);
    this.match = new Match({ ...initial });
  }
  get afterSeq(): number { return this.cursor - 1; }
  get state(): MatchState { return this.match.saveState(); }
  get hasPendingAdvance(): boolean { return this.pending !== null; }

  apply(record: MatchRecord, maxFrames = MAX_MATCH_FRAMES): MatchEvent[] {
    if (this.pending) throw new Error("An advance is pending");
    validateMatchRecord(record, this.match.roster);
    integer(maxFrames, 1, MAX_MATCH_FRAMES);
    if (record.seq !== this.cursor || record.before.round !== this.match.round || record.before.frame !== this.match.frame) throw new RangeError("Journal boundary mismatch");
    const op = record.op;
    if (op.type === "advance") {
      if (op.toFrame < this.match.frame || op.reachedFrame < this.match.frame || op.reachedFrame > op.toFrame
        || this.frames + op.toFrame - this.match.frame > MAX_MATCH_FRAMES) throw new RangeError("Invalid advance or frame budget exceeded");
      this.pending = structuredClone(record);
      return this.advance(maxFrames);
    }
    switch (op.type) {
      case "submit": this.match.submit(op.input); break;
      case "release": this.match.releaseControls(op.player); break;
      case "forfeit": this.match.forfeit(op.player); break;
      case "nextRound": this.match.nextRound(op.seed); break;
    }
    this.cursor++;
    return this.match.drainEvents();
  }

  advance(maxFrames = MAX_MATCH_FRAMES): MatchEvent[] {
    integer(maxFrames, 1, MAX_MATCH_FRAMES);
    if (!this.pending || this.pending.op.type !== "advance") throw new Error("No advance is pending");
    const op = this.pending.op;
    const before = this.match.frame;
    this.match.advanceToFrame(Math.min(op.toFrame, before + maxFrames));
    this.frames += this.match.frame - before;
    const events = this.match.drainEvents();
    if (this.match.ended || this.match.frame === op.toFrame) {
      if (this.match.frame !== op.reachedFrame) throw new RangeError("Reached frame mismatch");
      this.pending = null;
      this.cursor++;
    } else if (this.match.frame >= op.reachedFrame) {
      throw new RangeError("Reached frame mismatch");
    }
    return events;
  }
}
