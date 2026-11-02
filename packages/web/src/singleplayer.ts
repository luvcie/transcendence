import { Game, Input, DEFAULT_HANDLING, finesseAccuracy, type Handling, type InputId, type ClearStats, type FinesseStats } from "@42tris/core";

export const SINGLEPLAYER_MODES = {
  zen: { name: "Zen", undo: true, target: null, firstInput: false, width: null, readyMs: 250 },
  sprint: { name: "Sprint 40L", undo: false, target: 40, firstInput: true, width: 10, readyMs: 0 },
} as const;
export type SingleplayerMode = keyof typeof SINGLEPLAYER_MODES;

export interface SprintResult {
  readonly outcome: "complete" | "failed";
  readonly elapsedMs: number;
  readonly stats: Readonly<ClearStats>;
  readonly finesse: Readonly<FinesseStats>;
}

const isRelease = (input: InputId) => input === Input.LeftUp || input === Input.RightUp || input === Input.SoftDropUp;

/** Owns one local attempt; all core timestamps are pause-free attempt-relative milliseconds. */
export class Singleplayer {
  private current: Game;
  private previousZen: Game | null = null;
  private lastWall: number;
  private anchorWall: number;
  private anchorElapsed = 0;
  private elapsed = 0;
  private running: boolean;
  private seed: number;
  private handling: Handling;
  result: SprintResult | null = null;
  paused = false;

  constructor(readonly mode: SingleplayerMode, seed: number, now: number,
    handling: Handling = DEFAULT_HANDLING, zenWidth = 10) {
    this.seed = seed;
    this.handling = { ...handling };
    this.lastWall = this.anchorWall = now;
    this.running = !SINGLEPLAYER_MODES[mode].firstInput;
    this.current = this.createGame(SINGLEPLAYER_MODES[mode].width ?? zenWidth);
  }

  get game(): Game { return this.current; }
  get elapsedMs(): number { return this.result?.elapsedMs ?? this.elapsed; }
  get started(): boolean { return this.running; }
  get undoCount(): number { return this.game.undoCount || this.previousZen?.undoCount || 0; }
  get active(): boolean { return !this.result && this.started; }

  private createGame(width: number): Game {
    const game = new Game(this.seed, 500, 5, this.handling, SINGLEPLAYER_MODES[this.mode].readyMs, null, undefined, width);
    game.setZen(SINGLEPLAYER_MODES[this.mode].undo);
    game.tick(this.elapsed);
    return game;
  }

  private advanceClock(now: number): number {
    if (!Number.isFinite(now) || now < this.lastWall) throw new RangeError("Local time must be finite and monotonic");
    const target = this.running && !this.paused && !this.result
      ? this.anchorElapsed + (now - this.anchorWall) : this.elapsed;
    this.lastWall = now;
    return target;
  }

  tick(now: number): void {
    const target = this.advanceClock(now);
    if (this.paused || this.result || !this.running) return;
    // Inspect each canonical deadline so a coarse render tick cannot play beyond the winning lock.
    while (this.game.nextStepAt <= target) {
      const at = this.game.nextStepAt;
      this.game.tick(at);
      if (this.inspect(at)) return;
    }
    this.game.tick(target);
    this.elapsed = target;
    this.inspect(target);
  }

  apply(input: InputId, now: number): void {
    this.tick(now);
    if (this.paused || this.result || this.game.starting) return;
    if (!this.running) {
      if (isRelease(input)) return;
      this.running = true;
      this.anchorWall = now;
      this.anchorElapsed = this.elapsed;
    }
    this.game.apply(input, this.elapsed);
    this.inspect(this.elapsed);
  }

  private inspect(at: number): boolean {
    const events = this.game.drainEvents();
    if (events.some(event => event.type === "lock")) this.previousZen = null;
    const target = SINGLEPLAYER_MODES[this.mode].target;
    const winning = target === null ? undefined : events.find(event => event.type === "lock" && event.stats.lines >= target);
    if (winning || this.game.topOut) {
      this.elapsed = winning?.atMs ?? at;
      if (target !== null) {
        this.result = Object.freeze({ outcome: winning ? "complete" : "failed", elapsedMs: this.elapsed,
          stats: Object.freeze({ ...this.game.stats }), finesse: Object.freeze({ ...this.game.finesse }) });
        return true;
      }
      // Keep the topped-out board's history until the new board has its own placement to undo.
      this.previousZen = this.game;
      this.seed = (this.seed + 0x9e3779b9) >>> 0;
      this.current = this.createGame(this.game.width);
      this.anchorElapsed = this.elapsed;
      this.anchorWall = this.lastWall;
      return true;
    }
    return false;
  }

  setPaused(paused: boolean, now: number): void {
    this.tick(now);
    if (this.mode === "sprint") return;
    if (this.result || paused === this.paused) return;
    this.paused = paused;
    this.anchorElapsed = this.elapsed;
    this.anchorWall = now;
    this.game.setPaused(paused, this.elapsed);
  }

  setHandling(handling: Handling, now: number): void {
    this.tick(now);
    this.handling = { ...handling };
    if (!this.result) this.game.setHandling(handling);
  }

  undo(now: number): boolean {
    if (!SINGLEPLAYER_MODES[this.mode].undo || this.paused || this.result) return false;
    this.tick(now);
    const game = this.game.undoCount ? this.game : this.previousZen ?? this.game;
    if (game !== this.current) game.setHandling(this.handling);
    if (!game.undo(this.elapsed)) return false;
    this.current = game;
    this.previousZen = null;
    this.game.drainEvents();
    return true;
  }
}

export function formatTime(ms: number): string {
  const total = Math.floor(ms + 1e-7);
  return `${Math.floor(total / 60000)}:${String(Math.floor(total / 1000) % 60).padStart(2, "0")}.${String(total % 1000).padStart(3, "0")}`;
}

export function finesseSummary(finesse: Readonly<FinesseStats>): string {
  const accuracy = finesseAccuracy(finesse);
  return `${accuracy === null ? "—" : `${accuracy.toFixed(1)}%`} · ${finesse.faults} faults`;
}
