import {
  PRACTICE_LOCK,
  Singleplayer,
  type GameState,
  type SingleplayerReplayState,
  type SprintResult,
} from "@42tris/core";
import {
  MAX_SOLO_DURATION_MS,
  validateSoloInitial,
  validateSoloRecord,
  type SoloInitial,
  type SoloRecord,
} from "./solo-driver";

export const SPRINT_WIDTH = 10;
export const SPRINT_GRAVITY_MS = 500;
export const SPRINT_PREVIEW_COUNT = 5;
export const SPRINT_READY_MS = 0;
export const SPRINT_TARGET = 40;

export function validateSprintInitial(value: unknown): asserts value is SoloInitial {
  validateSoloInitial(value);
  if (value.width !== SPRINT_WIDTH) throw new RangeError("Sprint requires ten columns");
  if (value.gravityMs !== SPRINT_GRAVITY_MS) throw new RangeError("Invalid Sprint gravity");
  if (value.previewCount !== SPRINT_PREVIEW_COUNT) throw new RangeError("Invalid Sprint preview count");
  if (value.readyMs !== SPRINT_READY_MS) throw new RangeError("Invalid Sprint opening delay");
  if (value.lockProfile !== PRACTICE_LOCK) throw new RangeError("Invalid Sprint lock profile");
}

/**
 * Reconstructs the live Sprint controller rather than approximating its rules.
 * Record timestamps are controller observations, so the first gameplay press starts
 * the attempt clock and every later timestamp maps through the same pause-free timeline.
 */
export class SprintDriver {
  private readonly initial: SoloInitial;
  private controller: Singleplayer | null = null;
  private start: number | null = null;
  private lastAt = -1;
  private cursor = 0;
  private terminal = false;

  constructor(initial: SoloInitial) {
    validateSprintInitial(initial);
    this.initial = { ...initial, handling: { ...initial.handling } };
  }

  get afterSeq(): number { return this.cursor - 1; }
  get started(): boolean { return this.controller !== null; }
  get result(): SprintResult | null { return this.controller?.result ?? null; }

  get state(): GameState {
    if (!this.controller) throw new Error("Sprint has not started");
    return this.controller.game.saveState();
  }

  get modeState(): SingleplayerReplayState {
    if (!this.controller) throw new Error("Sprint has not started");
    return this.controller.replayState();
  }

  apply(record: SoloRecord): SprintResult | null {
    validateSoloRecord(record);
    if (record.seq !== this.cursor) throw new RangeError("Journal sequence mismatch");
    if (this.terminal) throw new RangeError("Sprint journal continues after the terminal result");

    const op = record.op;
    if (this.start === null) {
      if (op.type !== "tick") throw new RangeError("First operation must be a tick");
      this.start = op.atMs;
      this.controller = new Singleplayer("sprint", this.initial.seed, op.atMs,
        this.initial.handling, this.initial.width);
    }

    const at = op.type === "handling" ? op.observedAtMs : op.atMs;
    if (this.lastAt >= 0 && at < this.lastAt) throw new RangeError("Sprint clock moved backwards");
    if (at - this.start! > MAX_SOLO_DURATION_MS) throw new RangeError("Duration limit exceeded");

    switch (op.type) {
      case "tick": this.controller!.tick(op.atMs); break;
      case "input": this.controller!.apply(op.input, op.atMs); break;
      case "handling": this.controller!.setHandling(op.handling, op.observedAtMs); break;
      case "pause": throw new RangeError("Sprint does not support pause operations");
    }

    this.lastAt = at;
    this.cursor++;
    if (this.controller!.result) this.terminal = true;
    return this.controller!.result;
  }
}
