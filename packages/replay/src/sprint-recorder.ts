import {
  DEFAULT_HANDLING,
  PRACTICE_LOCK,
  Singleplayer,
  type Game,
  type Handling,
  type InputId,
  type SingleplayerReplayState,
  type SprintResult,
} from "@42tris/core";
import { computeFinalStateDigest, decodeReplayJson, encodeReplay, sealReplay } from "./decode";
import { ReplayError } from "./errors";
import {
  CURRENT_REPLAY_VERSIONS,
  MAX_TIMESTAMP_MS,
  SPRINT_MODE_ID,
  SPRINT_MODE_VERSION,
  type SprintReplay,
  type UnsignedSprintReplay,
} from "./format";
import { resolveReplayLimits, type ReplayDecodeOptions, type ReplayLimits } from "./limits";
import type { SoloInitial, SoloOperation, SoloRecord } from "./solo-driver";
import {
  SPRINT_GRAVITY_MS,
  SPRINT_PREVIEW_COUNT,
  SPRINT_READY_MS,
  SPRINT_TARGET,
  SPRINT_WIDTH,
} from "./sprint-driver";
import { isSprintReplay, verifySprintReplayExecution } from "./verify";

export type SprintRecorderStatus = "recording" | "finalizing" | "complete" | "failed" | "abandoned";

export interface SprintRecorderOptions extends ReplayDecodeOptions {
  /** Stable replay identifier. Defaults to a seed/start-time identifier. */
  id?: string;
  abandonOnFinesseFault?: boolean;
}

const ENVELOPE_RESERVE = 4096;
const RECORD_BYTES: Readonly<Record<SoloOperation["type"], number>> = Object.freeze({
  tick: 48,
  input: 72,
  pause: 64,
  handling: 112,
});

function operationAt(op: SoloOperation): number {
  return op.type === "handling" ? op.observedAtMs : op.atMs;
}

function copyOperation(op: SoloOperation): SoloOperation {
  switch (op.type) {
    case "tick": return { type: "tick", atMs: op.atMs };
    case "input": return { type: "input", atMs: op.atMs, input: op.input };
    case "pause": return { type: "pause", atMs: op.atMs, paused: op.paused };
    case "handling": return {
      type: "handling",
      observedAtMs: op.observedAtMs,
      handling: {
        das: op.handling.das,
        arr: op.handling.arr,
        sddas: op.handling.sddas,
        sdarr: op.handling.sdarr,
      },
    };
  }
}

interface TerminalSnapshot {
  readonly result: SprintResult;
  readonly state: ReturnType<Game["saveState"]>;
  readonly modeState: SingleplayerReplayState;
  readonly atMs: number;
}

/**
 * Records a live Sprint attempt by delegating every operation to the shared
 * Singleplayer controller and appending the exact call that was observed. The
 * journal is sealed and verified against the same Sprint driver used by imports.
 */
export class SprintRecorder {
  readonly mode = "sprint" as const;
  readonly completion: Promise<SprintReplay | null>;

  private readonly controller: Singleplayer;
  private readonly initial: SoloInitial;
  private readonly id: string;
  private readonly limits: ReplayLimits;
  private readonly startedAt: number;
  private readonly abandonOnFinesseFault: boolean;
  private readonly records: SoloRecord[] = [];
  private readonly resolveCompletion: (replay: SprintReplay | null) => void;
  private statusValue: SprintRecorderStatus = "recording";
  private failure: ReplayError | null = null;
  private terminal: TerminalSnapshot | null = null;
  private finalization: Promise<SprintReplay | null> | null = null;
  private completed: SprintReplay | null = null;
  private completedJson: string | null = null;
  private estimatedBytes = 0;

  constructor(seed: number, now: number, handling: Handling = DEFAULT_HANDLING,
    options: SprintRecorderOptions = {}) {
    if (typeof now !== "number" || !Number.isFinite(now) || now < 0) {
      throw new RangeError("Sprint start time must be a finite non-negative number");
    }
    const normalizedSeed = seed | 0;
    this.limits = resolveReplayLimits(options);
    this.id = options.id ?? `sprint-${normalizedSeed}-${now}`;
    if (this.id.length === 0 || this.id.length > this.limits.maxStringLength) {
      throw new RangeError("Invalid replay identifier");
    }
    this.initial = {
      seed: normalizedSeed,
      gravityMs: SPRINT_GRAVITY_MS,
      previewCount: SPRINT_PREVIEW_COUNT,
      handling: { ...handling },
      readyMs: SPRINT_READY_MS,
      lockProfile: PRACTICE_LOCK,
      width: SPRINT_WIDTH,
      zen: false,
    };
    this.startedAt = now;
    this.abandonOnFinesseFault = options.abandonOnFinesseFault ?? false;
    this.controller = new Singleplayer("sprint", normalizedSeed, now, handling);
    let resolveCompletion!: (replay: SprintReplay | null) => void;
    this.completion = new Promise<SprintReplay | null>(resolve => { resolveCompletion = resolve; });
    this.resolveCompletion = resolveCompletion;
    this.record({ type: "tick", atMs: now });
    this.controller.tick(now);
  }

  get game(): Game { return this.controller.game; }
  get result(): SprintResult | null { return this.controller.result; }
  get started(): boolean { return this.controller.started; }
  get active(): boolean { return this.controller.active; }
  get paused(): boolean { return this.controller.paused; }
  get elapsedMs(): number { return this.controller.elapsedMs; }
  get undoCount(): number { return this.controller.undoCount; }
  get status(): SprintRecorderStatus { return this.statusValue; }
  get error(): ReplayError | null { return this.failure; }
  get replay(): SprintReplay | null { return this.completed; }
  get json(): string | null { return this.completedJson; }

  replayState(): SingleplayerReplayState { return this.controller.replayState(); }

  tick(now: number): void {
    this.controller.tick(now);
    this.record({ type: "tick", atMs: now });
    this.observeTerminal();
  }

  apply(input: InputId, now: number): void {
    this.controller.apply(input, now);
    this.record({ type: "input", atMs: now, input });
    this.observeTerminal();
  }

  setHandling(handling: Handling, now: number): void {
    this.controller.setHandling(handling, now);
    this.record({ type: "handling", observedAtMs: now, handling });
    this.observeTerminal();
  }

  setPaused(paused: boolean, now: number): void {
    this.controller.setPaused(paused, now);
    // Sprint ignores the pause flag but still observes the controller clock.
    this.record({ type: "tick", atMs: now });
    this.observeTerminal();
  }

  undo(now: number): boolean {
    return this.controller.undo(now);
  }

  /** Discards an unfinished attempt. A terminal recording is never discarded. */
  abandon(): void {
    if (this.statusValue !== "recording") return;
    this.statusValue = "abandoned";
    this.records.length = 0;
    this.resolveCompletion(null);
  }

  /**
   * Resolves with the sealed, decoded replay after terminal verification. Returns
   * null for unfinished, abandoned, failed or over-limit attempts. Idempotent.
   */
  finish(): Promise<SprintReplay | null> {
    if (this.finalization) return this.finalization;
    return Promise.resolve(this.completed);
  }

  private record(op: SoloOperation): void {
    if (this.statusValue !== "recording") return;
    const at = operationAt(op);
    if (!Number.isFinite(at) || at < 0 || at > MAX_TIMESTAMP_MS) {
      this.fail(new ReplayError("malformed", "Invalid Sprint recording timestamp"));
      return;
    }
    if (this.records.length + 1 > this.limits.maxOperations) {
      this.fail(new ReplayError("resource-limit", "Sprint recording operation limit exceeded"));
      return;
    }
    if (at - this.startedAt > this.limits.maxDurationMs) {
      this.fail(new ReplayError("resource-limit", "Sprint recording duration limit exceeded"));
      return;
    }
    const nextBytes = this.estimatedBytes + RECORD_BYTES[op.type];
    const reserve = Math.min(ENVELOPE_RESERVE, Math.max(0, Math.floor(this.limits.maxBytes / 4)));
    if (nextBytes > this.limits.maxBytes - reserve) {
      this.fail(new ReplayError("resource-limit", "Sprint recording byte limit exceeded"));
      return;
    }
    this.estimatedBytes = nextBytes;
    this.records.push({ seq: this.records.length, op: copyOperation(op) });
  }

  private observeTerminal(): void {
    if (this.abandonOnFinesseFault && this.controller.game.finesse.faults > 0) {
      this.abandon();
      return;
    }
    if (this.statusValue !== "recording" || !this.controller.result) return;
    const last = this.records[this.records.length - 1];
    if (!last) {
      this.fail(new ReplayError("malformed", "Sprint recording has no initialization tick"));
      return;
    }
    this.terminal = {
      result: this.controller.result,
      state: this.controller.game.saveState(),
      modeState: this.controller.replayState(),
      atMs: operationAt(last.op),
    };
    this.statusValue = "finalizing";
    this.finalization = this.seal();
  }

  private fail(error: ReplayError): void {
    if (this.statusValue === "failed" || this.statusValue === "abandoned" || this.statusValue === "complete") return;
    this.statusValue = "failed";
    this.failure = error;
    this.records.length = 0;
    this.resolveCompletion(null);
  }

  private async seal(): Promise<SprintReplay | null> {
    const terminal = this.terminal!;
    try {
      const finalStateDigest = await computeFinalStateDigest(terminal.state, terminal.modeState);
      const payload: UnsignedSprintReplay = {
        versions: CURRENT_REPLAY_VERSIONS,
        id: this.id,
        kind: "solo",
        mode: { id: SPRINT_MODE_ID, version: SPRINT_MODE_VERSION, config: { target: SPRINT_TARGET } },
        initial: { ...this.initial, handling: { ...this.initial.handling } },
        records: this.records.map(record => ({ seq: record.seq, op: copyOperation(record.op) })),
        end: {
          atMs: terminal.atMs,
          afterSeq: this.records.length - 1,
          status: terminal.result.outcome === "complete" ? "complete" : "stopped",
          reason: terminal.result.outcome === "complete" ? "completed" : "top-out",
          finalStateDigest,
        },
        summary: {
          outcome: terminal.result.outcome,
          elapsedMs: terminal.result.elapsedMs,
          stats: { ...terminal.result.stats },
          finesse: { ...terminal.result.finesse },
          topOut: terminal.state.state.topOut,
        },
      };
      const sealed = await sealReplay(payload);
      const json = encodeReplay(sealed);
      if (new TextEncoder().encode(json).length > this.limits.maxBytes) {
        throw new ReplayError("resource-limit", "Sprint replay byte limit exceeded");
      }
      const decoded = await decodeReplayJson(json, this.limits);
      if (!isSprintReplay(decoded)) throw new ReplayError("malformed", "Recorded journal is not a Sprint replay");
      await verifySprintReplayExecution(decoded);
      this.completed = decoded;
      this.completedJson = json;
      this.statusValue = "complete";
      this.records.length = 0;
      this.resolveCompletion(decoded);
      return decoded;
    } catch (error) {
      const replayError = error instanceof ReplayError ? error : new ReplayError(
        "simulation-mismatch",
        error instanceof Error ? error.message : "Sprint replay finalization failed",
      );
      this.statusValue = "failed";
      this.failure = replayError;
      this.records.length = 0;
      this.resolveCompletion(null);
      return null;
    }
  }
}
