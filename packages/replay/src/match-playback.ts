import { FRAME_MS } from "@42tris/core";
import type { MatchEvent, MatchState } from "@42tris/match";
import { decodeReplay, decodeReplayJson } from "./decode";
import { ReplayError } from "./errors";
import type { MatchReplay } from "./format";
import type { ReplayDecodeOptions } from "./limits";
import { MatchDriver } from "./match-driver";
import { isMatchReplay, verifyMatchReplayExecution } from "./verify";

export const MATCH_PLAYBACK_SPEEDS = [0.5, 1, 2, 4] as const;
export type MatchPlaybackSpeed = (typeof MATCH_PLAYBACK_SPEEDS)[number];

export interface MatchPlaybackOptions extends ReplayDecodeOptions {
  speed?: MatchPlaybackSpeed;
  paused?: boolean;
}

/** One cumulative frame timeline across all rounds of a verified competitive set. */
export class MatchPlayback {
  private driver: MatchDriver;
  private cursor = 0;
  private frame = 0;
  private fraction = 0;
  private playingValue: boolean;
  private speedValue: MatchPlaybackSpeed;
  private readonly initialEventsValue: MatchEvent[];
  readonly durationFrames: number;

  private constructor(private readonly replay: MatchReplay, options: MatchPlaybackOptions) {
    this.speedValue = 1;
    this.setSpeed(options.speed ?? 1);
    this.driver = new MatchDriver(replay.initial);
    this.durationFrames = replay.records.reduce((total, record) => total +
      (record.op.type === "advance" ? record.op.reachedFrame - record.before.frame : 0), 0);
    this.initialEventsValue = this.runTo(0);
    this.playingValue = !options.paused && !this.complete;
  }

  static async create(input: unknown, options: MatchPlaybackOptions = {}): Promise<MatchPlayback> {
    if (options === null || typeof options !== "object" || Array.isArray(options)) {
      throw new ReplayError("malformed", "Invalid playback options");
    }
    // Decode first to bound the structure, then enforce the JSON byte limit and
    // validate the detached values again before checking integrity.
    const detached = decodeReplay(decodeReplay(input, options), options);
    let json: string;
    try {
      json = JSON.stringify(detached);
    } catch {
      throw new ReplayError("malformed", "Invalid replay value");
    }
    const replay = await decodeReplayJson(json, options);
    if (!isMatchReplay(replay)) throw new ReplayError("unsupported", "Only competitive Match replays can be watched");
    const verified = await verifyMatchReplayExecution(replay);
    if (!verified.complete) throw new ReplayError("unsupported", "Only completed matches can be watched");
    return new MatchPlayback(replay, options);
  }

  get id(): string { return this.replay.id; }
  get state(): MatchState { return this.driver.state; }
  get positionFrames(): number { return this.frame; }
  get speed(): MatchPlaybackSpeed { return this.speedValue; }
  get playing(): boolean { return this.playingValue; }
  get complete(): boolean { return this.cursor === this.replay.records.length && !this.driver.hasPendingAdvance; }
  get initialEvents(): MatchEvent[] { return structuredClone(this.initialEventsValue); }

  play(): void { if (!this.complete) this.playingValue = true; }
  pause(): void { this.playingValue = false; }
  setSpeed(speed: number): void {
    if (!MATCH_PLAYBACK_SPEEDS.includes(speed as MatchPlaybackSpeed)) throw new RangeError("Unsupported playback speed");
    this.speedValue = speed as MatchPlaybackSpeed;
  }

  /** Advances by elapsed presentation milliseconds; returns newly generated events in journal order. */
  advance(elapsedMs: number): MatchEvent[] {
    if (!Number.isFinite(elapsedMs) || elapsedMs < 0) throw new RangeError("Invalid elapsed time");
    if (!this.playingValue) return [];
    const frames = this.fraction + elapsedMs * this.speedValue / FRAME_MS;
    const whole = Math.floor(frames + 1e-10);
    this.fraction = Math.max(0, frames - whole);
    const events = this.runTo(Math.min(this.durationFrames, this.frame + whole));
    if (this.complete) { this.playingValue = false; this.fraction = 0; }
    return events;
  }

  /** Seeks to a cumulative integer frame. Backward reconstruction does not emit historical events. */
  seek(frame: number): MatchEvent[] {
    if (!Number.isSafeInteger(frame) || frame < 0 || frame > this.durationFrames) throw new RangeError("Invalid playback frame");
    this.fraction = 0;
    if (frame < this.frame) {
      this.reset();
      this.runTo(frame);
      return [];
    }
    const events = this.runTo(frame);
    if (this.complete) this.playingValue = false;
    return events;
  }

  /** Rebuilds the beginning and starts playback, returning events at frame zero. */
  restart(): MatchEvent[] {
    this.reset();
    const events = this.runTo(0);
    this.playingValue = !this.complete;
    return events;
  }

  private reset(): void {
    this.driver = new MatchDriver(this.replay.initial);
    this.cursor = 0;
    this.frame = 0;
    this.fraction = 0;
  }

  private runTo(target: number): MatchEvent[] {
    const events: MatchEvent[] = [];
    while (this.cursor < this.replay.records.length) {
      const record = this.replay.records[this.cursor]!;
      if (record.op.type !== "advance") {
        events.push(...this.driver.apply(record));
        this.cursor++;
        continue;
      }
      const remaining = record.op.reachedFrame - this.driver.state.frame;
      const available = target - this.frame;
      if (remaining > 0 && available === 0) break;
      const before = this.driver.state.frame;
      const chunk = Math.max(1, Math.min(remaining, available));
      const generated = this.driver.hasPendingAdvance ? this.driver.advance(chunk) : this.driver.apply(record, chunk);
      for (const event of generated) events.push(event);
      this.frame += this.driver.state.frame - before;
      if (!this.driver.hasPendingAdvance) this.cursor++;
    }
    return events;
  }
}
