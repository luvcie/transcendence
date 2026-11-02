import { Game, Input, validateBoardWidth, validateHandling, validateLockProfile,
  type GameEvent, type GameState, type Handling, type InputId, type LockProfile } from "@42tris/core";

export interface SoloInitial {
  seed: number;
  gravityMs: number;
  previewCount: number;
  handling: Handling;
  readyMs: number;
  lockProfile: LockProfile;
  width: number;
  zen: false;
}
export type SoloOperation =
  | { type: "tick"; atMs: number }
  | { type: "input"; atMs: number; input: InputId }
  | { type: "pause"; atMs: number; paused: boolean }
  | { type: "handling"; observedAtMs: number; handling: Handling };
export interface SoloRecord { seq: number; op: SoloOperation }

export const MAX_SOLO_DURATION_MS = 2 * 60 * 60 * 1000;
const inputs = new Set<number>(Object.values(Input));
function fields(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) throw new RangeError("Invalid fields");
}
function clock(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new RangeError("Invalid time");
}
function handling(value: unknown): asserts value is Handling {
  fields(value, ["das", "arr", "sddas", "sdarr"]); validateHandling(value as Handling);
}
export function validateSoloInitial(value: unknown): asserts value is SoloInitial {
  fields(value, ["seed", "gravityMs", "previewCount", "handling", "readyMs", "lockProfile", "width", "zen"]);
  if (!Number.isSafeInteger(value.seed) || (value.seed as number) < -0x80000000 || (value.seed as number) > 0x7fffffff) throw new RangeError("Invalid seed");
  clock(value.gravityMs); if (value.gravityMs === 0) throw new RangeError("Invalid gravity");
  if (!Number.isSafeInteger(value.previewCount) || (value.previewCount as number) < 1 || (value.previewCount as number) > 32) throw new RangeError("Invalid preview count");
  clock(value.readyMs); if (value.readyMs > MAX_SOLO_DURATION_MS) throw new RangeError("Invalid ready time");
  handling(value.handling); validateLockProfile(value.lockProfile);
  validateBoardWidth(value.width as number);
  if (value.zen !== false) throw new RangeError("Zen is unsupported");
}
export function validateSoloRecord(value: unknown): asserts value is SoloRecord {
  fields(value, ["seq", "op"]);
  if (!Number.isSafeInteger(value.seq) || (value.seq as number) < 0) throw new RangeError("Invalid sequence");
  const op = value.op;
  if (!op || typeof op !== "object" || Array.isArray(op)) throw new RangeError("Invalid operation");
  const type = (op as { type?: unknown }).type;
  switch (type) {
    case "tick": fields(op, ["type", "atMs"]); clock(op.atMs); break;
    case "input": fields(op, ["type", "atMs", "input"]); clock(op.atMs); if (typeof op.input !== "number" || !inputs.has(op.input)) throw new RangeError("Invalid input"); break;
    case "pause": fields(op, ["type", "atMs", "paused"]); clock(op.atMs); if (typeof op.paused !== "boolean") throw new RangeError("Invalid pause"); break;
    case "handling": fields(op, ["type", "observedAtMs", "handling"]); clock(op.observedAtMs); handling(op.handling); break;
    default: throw new RangeError("Unknown solo operation");
  }
}

/** Reconstructs raw Game calls; the Sprint controller has a separate clock and is not represented by this driver. */
export class SoloDriver {
  private game: Game;
  private cursor = 0;
  private start: number | null = null;
  constructor(initial: SoloInitial) {
    validateSoloInitial(initial);
    this.game = new Game(initial.seed, initial.gravityMs, initial.previewCount, initial.handling,
      initial.readyMs, null, initial.lockProfile, initial.width);
  }
  get afterSeq(): number { return this.cursor - 1; }
  get state(): GameState { return this.game.saveState(); }
  apply(record: SoloRecord): GameEvent[] {
    validateSoloRecord(record);
    if (record.seq !== this.cursor) throw new RangeError("Journal sequence mismatch");
    const op = record.op;
    if (this.start === null && op.type !== "tick") throw new RangeError("First operation must be a tick");
    const at = op.type === "handling" ? op.observedAtMs : op.atMs;
    const observed = this.game.saveState().state.observedNow;
    if (observed > at || (op.type === "handling" && at !== observed)) throw new RangeError("Observation mismatch");
    if (this.start !== null && at - this.start > MAX_SOLO_DURATION_MS) throw new RangeError("Duration limit exceeded");
    switch (op.type) {
      case "tick": this.game.tick(op.atMs); break;
      case "input": this.game.apply(op.input, op.atMs); break;
      case "pause": this.game.setPaused(op.paused, op.atMs); break;
      case "handling": this.game.setHandling(op.handling); break;
    }
    if (this.start === null) this.start = at;
    this.cursor++;
    return this.game.drainEvents();
  }
}
