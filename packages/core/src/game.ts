import { Bag } from "./bag";
import { addFinesse, finessePlacement, INITIAL_FINESSE, type FinesseStats } from "./finesse";
import { classifySpin, INITIAL_STATS, resolveClear, RULES_VERSION, type Attack, type ClearStats, type Spin } from "./rules";
import { canPlace, clearRows, COLS, createBoard, place, validateBoardWidth } from "./board";
import { copyEvent, copyLock, GAME_STATE_VERSION, readGameState, type GameState } from "./game-state";
import { kicksFor } from "./kicks";
import { DEFAULT_HANDLING, FRAME_MS, validateHandling, type Handling } from "./handling";
import { GARBAGE, SPAWN_Y, spawnX, type PieceId } from "./pieces";
import { LEAGUE_LOCK, PRACTICE_LOCK, lockDelay, validateLockProfile, type LockProfile } from "./lock-profile";

export const Input = {
  LeftDown: 0,
  LeftUp: 1,
  RightDown: 2,
  RightUp: 3,
  RotateCw: 4,
  RotateCcw: 5,
  Rotate180: 6,
  HardDrop: 7,
  SoftDropDown: 8,
  SoftDropUp: 9,
  Hold: 10,
} as const;
export type InputId = (typeof Input)[keyof typeof Input];
export const LOCK_DELAY_MS = 1000;

export const UNDO_LIMIT = 1000;

export interface LockResult {
  readonly type: "lock";
  readonly sequence: number;
  readonly atMs: number;
  readonly piece: PieceId;
  readonly rows: readonly number[];
  readonly spin: Spin;
  readonly allClear: boolean;
  readonly stats: ClearStats;
  readonly attacks: readonly Attack[];
  readonly finesse: FinesseStats;
}

export type GameEvent = LockResult | Readonly<{ type: "restored"; sequence: number; atMs: number }>;

export interface PlacementSettlement {
  readonly result: LockResult;
  readonly x: number;
  readonly y: number;
  readonly rot: number;
}

/** Return incoming holes in insertion order, oldest row first. */
export type SettlePlacement = (placement: PlacementSettlement) => readonly number[];

export class Game {
  readonly rulesVersion = RULES_VERSION;
  private lastResult: LockResult | null = null;
  private events: GameEvent[] = [];
  private sequence = 0;
  private finesseInputs = 0;
  private finesseInherited = false;
  private zenEnabled = false;
  private history: ReturnType<Game["capture"]>[] = [];
  private turn: ReturnType<Game["capture"]> | null = null;

  readonly board: Uint8Array;
  readonly width: number;
  // upcoming pieces in deal order, refilled from the bag as pieces spawn
  readonly previews: Uint8Array;
  dealt = 0;
  piece: PieceId;
  rot = 0;
  x: number;
  y: number;
  topOut = false;
  held: PieceId | null = null;
  holdUsed = false;
  // Rotation eligibility survives failed actions.
  lastWasRotation = false;
  lastKickIndex = 0;

  private bag: Bag;
  private gravityMs: number;
  private lastNow = -1;
  private observedNow = -1;
  private fallAcc = 0;
  private lockElapsed = 0;
  private lockResets = 0;
  private rotationResets = 0;
  private lowestY = SPAWN_Y;
  private leagueOriginMs = 0;
  private leagueFrame = 1;
  private leaguePhase = 0;
  private leagueLockFrames = 0;
  private lockProfile: LockProfile;
  private handling: Handling;
  private leftHeld = false;
  private rightHeld = false;
  private direction = 0;
  private moveAt = Infinity;
  private softHeld = false;
  private softAt = Infinity;
  private readyMs: number;
  paused = false;
  private settlement: SettlePlacement | null;
  private inSettlement = false;

  constructor(seed: number, gravityMs = 500, previewCount = 5, handling: Handling = DEFAULT_HANDLING, readyMs = 0,
    settlement: SettlePlacement | null = null, lockProfile: LockProfile = PRACTICE_LOCK, width = COLS) {
    validateBoardWidth(width);
    this.width = width;
    this.board = createBoard(width);
    validateLockProfile(lockProfile);
    this.lockProfile = lockProfile;
    validateHandling(handling);
    if (!Number.isFinite(gravityMs) || gravityMs <= 0 || !Number.isSafeInteger(previewCount) || previewCount < 1
      || !Number.isFinite(readyMs) || readyMs < 0) throw new RangeError("Invalid game configuration");
    if (settlement !== null && typeof settlement !== "function") throw new TypeError("Invalid settlement callback");
    this.settlement = settlement;
    this.handling = { ...handling };
    this.bag = new Bag(seed);
    this.gravityMs = gravityMs;
    this.readyMs = readyMs;
    this.previews = new Uint8Array(previewCount);
    for (let i = 0; i < previewCount; i++) this.previews[i] = this.bag.next();
    this.piece = this.starting ? this.previews[0] as PieceId : this.takeNext();
    this.x = spawnX(this.piece, this.width);
    this.y = SPAWN_Y;
  }

  get stats(): ClearStats { return this.lastResult?.stats ?? INITIAL_STATS; }
  get finesse(): FinesseStats { return this.lastResult?.finesse ?? INITIAL_FINESSE; }
  get lastClear(): LockResult | null { return this.lastResult; }
  get zen(): boolean { return this.zenEnabled; }
  get undoCount(): number { return this.history.length; }

  saveState(): GameState {
    this.requireOutsideSettlement();
    const bag = this.bag.save();
    return {
      version: GAME_STATE_VERSION, rulesVersion: RULES_VERSION,
      board: [...this.board], previews: [...this.previews],
      bag: { rng: bag.rng, pieces: [...bag.pieces], index: bag.index },
      config: { width: this.width, gravityMs: this.gravityMs, lockProfile: this.lockProfile, handling: {
        das: this.handling.das, arr: this.handling.arr, sddas: this.handling.sddas, sdarr: this.handling.sdarr,
      } },
      state: {
        piece: this.piece, rot: this.rot, x: this.x, y: this.y, dealt: this.dealt,
        topOut: this.topOut, held: this.held, holdUsed: this.holdUsed,
        lastWasRotation: this.lastWasRotation, lastKickIndex: this.lastKickIndex,
        lastNow: this.lastNow, observedNow: this.observedNow, fallAcc: this.fallAcc, lockElapsed: this.lockElapsed,
        lockResets: this.lockResets, rotationResets: this.rotationResets, lowestY: this.lowestY,
        leagueOriginMs: this.leagueOriginMs, leagueFrame: this.leagueFrame,
        leaguePhase: this.leaguePhase, leagueLockFrames: this.leagueLockFrames,
        leftHeld: this.leftHeld, rightHeld: this.rightHeld, direction: this.direction,
        moveAt: this.moveAt === Infinity ? null : this.moveAt, softHeld: this.softHeld,
        softAt: this.softAt === Infinity ? null : this.softAt, readyMs: this.readyMs, paused: this.paused,
        sequence: this.sequence, finesseInputs: this.finesseInputs, finesseInherited: this.finesseInherited,
      },
      lastResult: this.lastResult === null ? null : copyLock(this.lastResult), events: this.events.map(copyEvent),
      zenEnabled: this.zenEnabled, settlementRequired: this.settlement !== null,
    };
  }

  static fromState(value: unknown, settlement: SettlePlacement | null): Game {
    const state = readGameState(value);
    const game = new Game(0, state.config.gravityMs, state.previews.length, state.config.handling, 0, null, state.config.lockProfile, state.config.width);
    game.restoreState(state, settlement);
    return game;
  }

  restoreState(value: unknown, settlement: SettlePlacement | null): void {
    this.requireOutsideSettlement();
    const s = readGameState(value);
    if (settlement !== null && typeof settlement !== "function"
      || s.settlementRequired && typeof settlement !== "function") {
      throw new TypeError("Restore requires an explicit settlement callback (or null for an unconnected game)");
    }
    if (s.config.width !== this.width) throw new RangeError("Board width differs from GameState");
    if (s.previews.length !== this.previews.length) throw new RangeError("Preview count differs from GameState");
    this.board.set(s.board);
    this.previews.set(s.previews);
    this.bag.restore({ ...s.bag, pieces: new Uint8Array(s.bag.pieces) });
    Object.assign(this, s.state);
    this.moveAt = s.state.moveAt ?? Infinity;
    this.softAt = s.state.softAt ?? Infinity;
    this.gravityMs = s.config.gravityMs;
    this.lockProfile = s.config.lockProfile;
    this.handling = s.config.handling;
    this.lastResult = s.lastResult;
    this.events = s.events;
    this.settlement = settlement;
    this.zenEnabled = s.zenEnabled;
    this.history = [];
    this.turn = this.zenEnabled && !this.starting && !this.topOut ? this.capture() : null;
  }

  drainEvents(): GameEvent[] {
    this.requireOutsideSettlement();
    const events = this.events;
    this.events = [];
    return events;
  }

  setZen(enabled: boolean): void {
    this.requireOutsideSettlement();
    if (enabled === this.zenEnabled) return;
    if (enabled && this.observedNow >= 0) {
      this.tick(this.observedNow);
      if (!this.paused && !this.starting && !this.topOut) this.advanceTo(this.observedNow);
    }
    this.zenEnabled = enabled;
    this.history = [];
    this.turn = enabled && !this.starting && !this.topOut ? this.capture() : null;
  }

  undo(nowMs: number): boolean {
    this.requireOutsideSettlement();
    this.observe(nowMs);
    if (!this.zenEnabled || !this.history.length) return false;
    const checkpoint = this.history.pop()!;
    this.board.set(checkpoint.board);
    this.previews.set(checkpoint.previews);
    this.bag.restore(checkpoint.bag);
    Object.assign(this, checkpoint.state);
    this.lastNow = this.observedNow = nowMs;
    this.rebaseLeagueClock(nowMs);
    this.releaseInputs();
    this.turn = checkpoint;
    this.events = [Object.freeze({ type: "restored", sequence: ++this.sequence, atMs: nowMs })];
    return true;
  }

  private capture() {
    return {
      board: this.board.slice(), previews: this.previews.slice(), bag: this.bag.save(),
      state: {
        piece: this.piece, rot: this.rot, x: this.x, y: this.y, dealt: this.dealt,
        held: this.held, holdUsed: this.holdUsed, topOut: this.topOut,
        lastWasRotation: this.lastWasRotation, lastKickIndex: this.lastKickIndex,
        fallAcc: this.fallAcc, lockElapsed: this.lockElapsed, readyMs: this.readyMs,
        lockResets: this.lockResets, rotationResets: this.rotationResets, lowestY: this.lowestY,
        leagueLockFrames: this.leagueLockFrames,
        lastResult: this.lastResult, finesseInputs: this.finesseInputs, finesseInherited: this.finesseInherited,
      },
    };
  }

  private beginTurn(): void {
    this.turn = this.zenEnabled && !this.topOut ? this.capture() : null;
  }

  get starting(): boolean {
    return this.readyMs > 0;
  }

  private takeNext(): PieceId {
    const next = this.previews[0] as PieceId;
    this.previews.copyWithin(0, 1);
    this.previews[this.previews.length - 1] = this.bag.next();
    this.dealt++;
    return next;
  }

  apply(input: InputId, nowMs: number): void {
    this.requireOutsideSettlement();
    this.observe(nowMs);
    if (this.paused || this.topOut) return;
    this.tick(nowMs);
    if (this.topOut || this.starting) return;
    this.advanceTo(nowMs);
    if (this.topOut) return;
    if (input === Input.LeftDown || input === Input.RightDown) {
      const left = input === Input.LeftDown;
      if (left ? this.leftHeld : this.rightHeld) return;
      this.finesseInputs++;
      if (left) this.leftHeld = true;
      else this.rightHeld = true;
      this.direction = left ? -1 : 1;
      // Techmino charges DAS immediately if the manual move hits a wall.
      this.moveAt = nowMs + (this.tryMove(this.direction) ? this.handling.das * FRAME_MS : 0);
      this.repeatMove(nowMs);
    } else if (input === Input.LeftUp || input === Input.RightUp) {
      const left = input === Input.LeftUp;
      if (left) this.leftHeld = false;
      else this.rightHeld = false;
      if (this.direction === (left ? -1 : 1)) {
        this.direction = this.leftHeld ? -1 : this.rightHeld ? 1 : 0;
        this.moveAt = this.direction ? nowMs + this.handling.das * FRAME_MS : Infinity;
      }
    } else if (input === Input.SoftDropDown) {
      if (this.softHeld) return;
      this.finesseInherited = true;
      this.softHeld = true;
      this.softAt = nowMs + this.handling.sddas * FRAME_MS;
      // Techmino takes two steps on press when SD DAS is zero.
      this.fallOne();
      if (this.handling.sddas === 0) {
        if (this.handling.sdarr === 0) this.dropToSurface();
        else this.fallOne();
      }
    } else if (input === Input.SoftDropUp) {
      this.softHeld = false;
      this.softAt = Infinity;
    }
    else if (input === Input.RotateCw || input === Input.RotateCcw || input === Input.Rotate180) {
      this.finesseInputs++;
      this.rotate(input === Input.RotateCw ? 1 : input === Input.RotateCcw ? 3 : 2);
    }
    else if (input === Input.HardDrop) this.hardDrop();
    else if (input === Input.Hold) this.hold();
    this.instantSoftDrop();
  }

  private hold(): void {
    if (this.holdUsed) return;
    const next = this.held;
    this.held = this.piece;
    this.spawn(next ?? this.takeNext());
    this.holdUsed = true;
  }

  private hardDrop(): void {
    this.dropToSurface();
    this.lock();
  }

  private lock(): void {
    const spin = classifySpin(this.board, this.piece, this.rot, this.x, this.y, this.lastWasRotation, this.lastKickIndex);
    const board = this.board.slice();
    place(board, this.piece, this.rot, this.x, this.y);
    const { rows, garbage } = clearRows(board);
    const allClear = rows.length > 0 && board.every(cell => cell === 0);
    const { stats, attacks } = resolveClear(this.stats, { lines: rows.length, spin, allClear, garbage });
    const result: LockResult = Object.freeze({
      type: "lock", sequence: this.sequence + 1, atMs: this.lastNow, piece: this.piece,
      rows: Object.freeze(rows), spin, allClear, stats, attacks,
      finesse: addFinesse(this.finesse, finessePlacement(this.board, this.piece, this.rot, this.x, this.y,
        this.finesseInputs, this.finesseInherited || this.handling.das === 0, spin !== "none", this.handling.arr === 0)),
    });
    let holes: number[];
    this.inSettlement = true;
    try {
      const incoming = this.settlement ? this.settlement(Object.freeze({ result, x: this.x, y: this.y, rot: this.rot })) : [];
      if (!Array.isArray(incoming)) throw new RangeError("Settlement must return an array of hole columns");
      holes = Array.from(incoming);
      if (!holes.every(hole => Number.isInteger(hole) && hole >= 0 && hole < this.width)) {
        throw new RangeError("Settlement must return hole columns within the board");
      }
    } catch (error) {
      // A controller may already have sent attacks. Stop rather than retrying that side effect.
      this.topOut = true;
      this.releaseInputs();
      throw error;
    } finally {
      this.inSettlement = false;
    }
    let overflow = false;
    for (const hole of holes) {
      overflow ||= board.subarray(0, this.width).some(cell => cell !== 0);
      board.copyWithin(0, this.width);
      board.fill(GARBAGE, board.length - this.width);
      board[board.length - this.width + hole] = 0;
    }
    if (this.turn) {
      if (this.history.length === UNDO_LIMIT) this.history.shift();
      this.history.push(this.turn);
    }
    this.board.set(board);
    this.sequence++;
    this.lastResult = result;
    this.events.push(result);
    if (overflow) this.topOut = true;
    else this.spawn();
    this.beginTurn();
  }

  private tryMove(dx: number): boolean {
    if (canPlace(this.board, this.piece, this.rot, this.x + dx, this.y)) {
      this.x += dx;
      this.lastWasRotation = false;
      this.refreshLock("move");
      this.instantSoftDrop();
      return true;
    }
    return false;
  }

  private repeatMove(nowMs: number): void {
    if (!this.direction || nowMs < this.moveAt) return;
    if (this.handling.arr === 0) {
      while (this.tryMove(this.direction)) {}
      this.moveAt = Infinity;
    } else {
      const moved = this.tryMove(this.direction);
      // Blocked repeats stay charged, retrying on the next logical frame.
      this.moveAt = nowMs + (moved ? this.handling.arr : 1) * FRAME_MS;
    }
  }

  private repeatChargedMove(): void {
    if (!this.topOut && this.direction && this.handling.arr === 0 && this.moveAt === Infinity) {
      while (this.tryMove(this.direction)) { /* keep charged across spawns */ }
    }
  }

  private fallOne(): boolean {
    if (!canPlace(this.board, this.piece, this.rot, this.x, this.y + 1)) return false;
    this.y++;
    this.lastWasRotation = false;
    this.refreshLock("fall");
    return true;
  }

  private refreshLock(action: "move" | "rotate" | "fall"): void {
    if (this.lockProfile === LEAGUE_LOCK) {
      if (action === "fall") {
        const depth = this.y + this.fallAcc / this.gravityMs;
        if (depth > this.lowestY) {
          this.lowestY = Math.ceil(depth);
          this.lockResets = this.rotationResets = 0;
        }
      } else {
        this.lockResets = Math.min(31, this.lockResets + 1);
        if (action === "rotate") this.rotationResets = Math.min(63, this.rotationResets + 1);
        if (this.lockResets < 15) this.lockElapsed = this.leagueLockFrames = 0;
      }
      return;
    }
    // Techmino's easyFresh restores both timers after a successful action.
    if (this.lockElapsed > 0) {
      this.lockElapsed = 0;
      this.fallAcc = 0;
    }
  }

  private dropToSurface(): void {
    while (this.fallOne()) {}
  }

  private instantSoftDrop(): void {
    if (!this.topOut && this.softHeld && this.handling.sdarr === 0 && this.lastNow >= this.softAt) {
      this.dropToSurface();
    }
  }

  setHandling(handling: Handling): void {
    this.requireOutsideSettlement();
    validateHandling(handling);
    if (this.observedNow >= 0) {
      this.tick(this.observedNow);
      if (!this.paused && !this.starting && !this.topOut) this.advanceTo(this.observedNow);
    }
    if (this.leftHeld || this.rightHeld || this.softHeld || this.handling.das !== handling.das
      || this.handling.arr !== handling.arr || this.handling.sddas !== handling.sddas
      || this.handling.sdarr !== handling.sdarr) this.finesseInherited = true;
    this.handling = { ...handling };
    this.releaseInputs();
  }

  private releaseInputs(): void {
    this.leftHeld = this.rightHeld = this.softHeld = false;
    this.direction = 0;
    this.moveAt = this.softAt = Infinity;
  }

  setPaused(paused: boolean, nowMs: number): void {
    this.requireOutsideSettlement();
    this.observe(nowMs);
    if (paused === this.paused) return;
    if (paused) {
      this.tick(nowMs);
      if (!this.starting && !this.topOut) this.advanceTo(nowMs);
    }
    this.paused = paused;
    this.lastNow = this.observedNow = nowMs;
    this.rebaseLeagueClock(nowMs);
    this.releaseInputs();
  }

  private rotate(turns: number): void {
    const to = (this.rot + turns) & 3;
    if (canPlace(this.board, this.piece, to, this.x, this.y)) {
      this.rot = to;
      this.lastKickIndex = 0;
      this.lastWasRotation = true;
      this.refreshLock("rotate");
      return;
    }
    const table = kicksFor(this.piece, this.rot, to);
    for (let i = 0; i < table.length; i += 2) {
      const nx = this.x + table[i];
      const ny = this.y + table[i + 1];
      if (canPlace(this.board, this.piece, to, nx, ny)) {
        this.rot = to;
        this.x = nx;
        this.y = ny;
        this.lastKickIndex = i / 2 + 1;
        this.lastWasRotation = true;
        this.refreshLock("rotate");
        return;
      }
    }
  }

  private fallSpeed(): number {
    return (this.softHeld && this.lastNow >= this.softAt && this.handling.sdarr > 0
      ? 1 + this.gravityMs / (this.handling.sdarr * FRAME_MS) : 1);
  }

  private lockRemaining(): number {
    const remaining = Math.max(0, lockDelay(this.lockProfile) - this.lockElapsed);
    return remaining;
  }

  private lockDeadline(): number {
    return this.lockProfile === PRACTICE_LOCK
      ? this.lastNow + LOCK_DELAY_MS - this.lockElapsed : this.lastNow + this.lockRemaining();
  }

  /** Next internal deadline, for controllers interleaving several games. */
  get nextStepAt(): number {
    this.requireOutsideSettlement();
    if (this.topOut || this.paused || this.lastNow < 0) return Infinity;
    if (this.starting) return this.lastNow + this.readyMs;
    if (this.lockProfile === LEAGUE_LOCK) return Math.min(
      this.leagueOriginMs + this.leagueFrame * FRAME_MS,
      this.moveAt, this.softAt > this.lastNow ? this.softAt : Infinity,
    );
    const airborne = canPlace(this.board, this.piece, this.rot, this.x, this.y + 1);
    return Math.min(this.moveAt, this.softAt > this.lastNow ? this.softAt : Infinity,
      airborne ? this.lastNow + (this.gravityMs - this.fallAcc) / this.fallSpeed()
        : this.lockDeadline());
  }

  private advanceTo(nowMs: number): void {
    if (this.lockProfile === LEAGUE_LOCK) {
      this.leagueCheckpoint(nowMs);
      return;
    }
    if (canPlace(this.board, this.piece, this.rot, this.x, this.y + 1)) {
      this.fallAcc += (nowMs - this.lastNow) * this.fallSpeed();
    } else {
      this.lockElapsed += nowMs - this.lastNow;
    }
    this.lastNow = nowMs;
  }

  tick(nowMs: number): void {
    this.requireOutsideSettlement();
    this.observe(nowMs);
    if (this.topOut || this.paused) return;
    if (this.lastNow < 0) {
      this.lastNow = nowMs;
      this.rebaseLeagueClock(nowMs);
      return;
    }
    if (nowMs < this.lastNow) return;
    if (this.starting) {
      const elapsed = Math.min(nowMs - this.lastNow, this.readyMs);
      this.readyMs -= elapsed;
      this.lastNow += elapsed;
      if (this.starting) return;
      this.spawn();
      this.rebaseLeagueClock(this.lastNow);
      this.beginTurn();
    }
    if (this.lockProfile === LEAGUE_LOCK) {
      while (!this.topOut && this.nextStepAt <= nowMs) this.leagueCheckpoint(this.nextStepAt);
      return;
    }
    while ((this.lastNow < nowMs || this.nextStepAt <= nowMs) && !this.topOut) {
      this.instantSoftDrop();
      this.repeatChargedMove();
      const airborne = canPlace(this.board, this.piece, this.rot, this.x, this.y + 1);
      const speed = this.fallSpeed();
      const gravityAt = airborne ? this.lastNow + (this.gravityMs - this.fallAcc) / speed : Infinity;
      const lockAt = airborne ? Infinity : this.lockDeadline();
      const next = Math.min(this.moveAt, this.softAt > this.lastNow ? this.softAt : Infinity, gravityAt, lockAt);
      // Render-only ticks must not accumulate rounding error in the simulation clock.
      if (next > nowMs) return;
      this.advanceTo(next);
      this.repeatMove(next);
      this.instantSoftDrop();
      if (next >= gravityAt) {
        this.fallAcc = 0;
        this.fallOne();
      }
      if (this.lockRemaining() === 0 && !canPlace(this.board, this.piece, this.rot, this.x, this.y + 1)) this.lock();
      this.repeatChargedMove();
    }
  }

  private rebaseLeagueClock(nowMs: number): void {
    this.leagueOriginMs = nowMs;
    this.leagueFrame = 1;
    this.leaguePhase = 0;
  }

  private leagueCheckpoint(nowMs: number): void {
    if (nowMs <= this.lastNow || this.topOut) return;
    const boundary = this.leagueOriginMs + this.leagueFrame * FRAME_MS;
    let phase = nowMs === boundary ? this.leagueFrame : (nowMs - this.leagueOriginMs) / FRAME_MS;
    if (nowMs < boundary && phase >= this.leagueFrame) {
      // Division can round up while the millisecond boundary is still pending.
      // For a positive integer frame, this is its preceding representable double.
      phase = this.leagueFrame - Number.EPSILON * this.leagueFrame / 2;
    }
    const duration = phase - this.leaguePhase;
    const speed = this.fallSpeed();
    this.lastNow = nowMs;
    this.leaguePhase = phase;
    if (nowMs === boundary) this.leagueFrame++;
    // Shift precedes Fall, including the remaining segment before a key event.
    this.repeatMove(nowMs);
    this.repeatChargedMove();
    this.instantSoftDrop();
    let cells = duration * FRAME_MS / this.gravityMs * speed;
    if (this.lockResets >= 15 && !canPlace(this.board, this.piece, this.rot, this.x, this.y + 1)) cells = 20;
    cells += 0.5 * duration * Math.max(0, this.rotationResets - 30);
    // Compute the whole Fall distance before depth renewal changes rotresets.
    while (cells > 0) {
      const step = Math.min(1, cells);
      if (!canPlace(this.board, this.piece, this.rot, this.x, this.y + 1)) {
        this.leagueLockFrames += duration;
        // Subtracting fractional phases can put an exact 30 just above 30.
        // Normalize only the threshold's clock-scale rounding neighborhood.
        const lockRounding = 8 * Number.EPSILON * Math.max(30, phase);
        if (this.leagueLockFrames > 30 && this.leagueLockFrames - 30 <= lockRounding) {
          this.leagueLockFrames = 30;
        }
        if (this.leagueLockFrames > 30 || this.lockResets >= 15) this.lock();
        return;
      }
      let progress = this.fallAcc / this.gravityMs + step;
      const nearest = Math.round(progress);
      if (Math.abs(progress - nearest) <= 8 * Number.EPSILON) progress = nearest;
      const rows = Math.floor(progress);
      this.fallAcc = (progress - rows) * this.gravityMs;
      if (rows > 0) {
        this.y += rows;
        this.lastWasRotation = false;
      }
      this.refreshLock("fall");
      cells -= step;
    }
  }

  private requireOutsideSettlement(): void {
    if (this.inSettlement) throw new Error("Game operations are not allowed during settlement");
  }

  private observe(nowMs: number): void {
    if (!Number.isFinite(nowMs) || nowMs < 0 || nowMs < this.observedNow) {
      throw new RangeError("Timestamp must be finite, nonnegative and not precede observedNow");
    }
    this.observedNow = nowMs;
  }

  private spawn(piece = this.takeNext()): void {
    this.piece = piece;
    this.finesseInputs = 0;
    this.finesseInherited = this.leftHeld || this.rightHeld || this.softHeld;
    this.holdUsed = false;
    this.rot = 0;
    this.x = spawnX(this.piece, this.width);
    this.y = SPAWN_Y;
    this.lastWasRotation = false;
    this.lastKickIndex = 0;
    this.fallAcc = 0;
    this.lockElapsed = 0;
    this.leagueLockFrames = 0;
    this.lockResets = this.rotationResets = 0;
    this.lowestY = SPAWN_Y;
    if (!canPlace(this.board, this.piece, this.rot, this.x, this.y)) {
      this.topOut = true;
    }
  }
}
