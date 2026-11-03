import type { GameState, SprintResult } from "@42tris/core";
import {
  ReplayError,
  SprintDriver,
  isSprintReplay,
  verifySprintReplayExecution,
  type SoloRecord,
  type SprintReplay,
} from "@42tris/replay";

export const PLAYBACK_SPEEDS = [0.5, 1, 2, 4] as const;
export type PlaybackSpeed = (typeof PLAYBACK_SPEEDS)[number];

export interface SprintPlaybackOptions {
  /** Presentation rate relative to the recorded timeline. Defaults to 1x. */
  speed?: number;
  /** Start frozen at the beginning instead of playing. Defaults to false. */
  paused?: boolean;
}

function recordAt(record: SoloRecord): number {
  return record.op.type === "handling" ? record.op.observedAtMs : record.op.atMs;
}

function checkSpeed(value: number): PlaybackSpeed {
  if (!PLAYBACK_SPEEDS.includes(value as PlaybackSpeed)) {
    throw new RangeError(`Unsupported playback speed: ${String(value)}`);
  }
  return value as PlaybackSpeed;
}

/**
 * Streams a verified Sprint journal into the same Singleplayer controller the live
 * game uses. The playback position is recorded-timeline milliseconds from the first
 * journal tick. Browser frame time only moves that cursor, so reconstructed states
 * never depend on framerate or playback speed.
 */
export class SprintPlayback {
  readonly replay: SprintReplay;
  private readonly records: readonly SoloRecord[];
  private readonly originMs: number;
  private readonly lengthMs: number;
  private driver: SprintDriver;
  private cursor = 0;
  private position = 0;
  private speedValue: PlaybackSpeed = 1;
  private playingValue = true;
  private disposedValue = false;

  private constructor(replay: SprintReplay, options: SprintPlaybackOptions) {
    if (options === null || typeof options !== "object" || Array.isArray(options)) {
      throw new ReplayError("malformed", "Invalid playback options");
    }
    this.replay = replay;
    this.records = replay.records;
    this.originMs = recordAt(this.records[0]!);
    this.lengthMs = Math.max(0, recordAt(this.records[this.records.length - 1]!) - this.originMs);
    this.speedValue = options.speed === undefined ? 1 : checkSpeed(options.speed);
    this.driver = new SprintDriver(replay.initial);
    this.applyThrough(0);
    this.playingValue = options.paused !== true && !this.complete;
  }

  /** Verifies the journal once, up front, and never re-runs verification while rendering. */
  static async create(replay: SprintReplay, options: SprintPlaybackOptions = {}): Promise<SprintPlayback> {
    if (replay === null || typeof replay !== "object" || !isSprintReplay(replay)) {
      throw new ReplayError("unsupported", "Only Sprint replays can be watched");
    }
    if (!Array.isArray(replay.records) || replay.records.length === 0) {
      throw new ReplayError("malformed", "Sprint replay has no journal");
    }
    if (replay.records[0]!.op.type !== "tick" || replay.end.afterSeq !== replay.records.length - 1) {
      throw new ReplayError("malformed", "Sprint replay journal does not match its terminal record");
    }
    await verifySprintReplayExecution(replay);
    return new SprintPlayback(replay, options);
  }

  get id(): string { return this.replay.id; }
  get speed(): PlaybackSpeed { return this.speedValue; }
  get positionMs(): number { return this.position; }
  get durationMs(): number { return this.lengthMs; }
  get playing(): boolean { return this.playingValue; }
  /** True once every journal operation has been applied and playback stopped. */
  get complete(): boolean { return this.cursor >= this.records.length; }
  get disposed(): boolean { return this.disposedValue; }
  /** Reconstructed Sprint timer: pause-free attempt time, zero before the first input. */
  get elapsedMs(): number { return this.driver.modeState.elapsed; }
  get started(): boolean { return this.driver.modeState.running; }
  get state(): GameState { return this.driver.state; }
  get result(): SprintResult | null { return this.driver.result; }
  get outcome(): "complete" | "failed" { return this.replay.summary.outcome; }

  /**
   * Converts browser frame time into recorded timeline progress. Journal operations
   * are applied in seq order as their timestamps are crossed, including several at
   * the same timestamp, and the terminal record forces the verified final state.
   */
  advance(realMs: number): void {
    if (typeof realMs !== "number" || !Number.isFinite(realMs) || realMs < 0) {
      throw new RangeError("Playback frame time must be a finite non-negative number");
    }
    if (this.disposedValue || !this.playingValue || this.complete) return;
    const next = Math.min(this.lengthMs, this.position + realMs * this.speedValue);
    this.position = next;
    this.applyThrough(next);
    if (next >= this.lengthMs) this.applyRemaining();
  }

  play(): void {
    if (this.disposedValue || this.complete) return;
    this.playingValue = true;
  }

  pause(): void {
    if (this.disposedValue) return;
    this.playingValue = false;
  }

  toggle(): void {
    if (this.playingValue) this.pause();
    else this.play();
  }

  /** Seeks in recorded-timeline milliseconds, preserving pause/play unless the end is reached. */
  seek(positionMs: number): void {
    if (!Number.isFinite(positionMs) || positionMs < 0 || positionMs > this.lengthMs) {
      throw new RangeError("Invalid playback position");
    }
    if (this.disposedValue) return;
    if (positionMs < this.position && recordAt(this.records[this.cursor - 1]!) - this.originMs > positionMs) {
      this.driver = new SprintDriver(this.replay.initial);
      this.cursor = 0;
    }
    this.position = positionMs;
    this.applyThrough(positionMs);
    if (positionMs === this.lengthMs) this.applyRemaining();
  }

  /** Returns to the initial journal state and plays from the beginning. */
  restart(): void {
    if (this.disposedValue) return;
    this.driver = new SprintDriver(this.replay.initial);
    this.cursor = 0;
    this.position = 0;
    this.applyThrough(0);
    this.playingValue = !this.complete;
  }

  setSpeed(speed: number): void {
    this.speedValue = checkSpeed(speed);
  }

  /** Stops playback; later calls cannot move the cursor or advance the simulation. */
  dispose(): void {
    this.disposedValue = true;
    this.playingValue = false;
  }

  private applyThrough(positionMs: number): void {
    while (this.cursor < this.records.length) {
      const record = this.records[this.cursor]!;
      if (recordAt(record) - this.originMs > positionMs) return;
      this.driver.apply(record);
      this.cursor++;
    }
  }

  private applyRemaining(): void {
    while (this.cursor < this.records.length) {
      this.driver.apply(this.records[this.cursor]!);
      this.cursor++;
    }
    this.playingValue = false;
  }
}
