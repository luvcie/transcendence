import { Bag } from "./bag";
import { classifySpin, INITIAL_STATS, resolveClear, RULES_VERSION, type Attack, type ClearStats, type Spin } from "./rules";
import { canPlace, clearRows, createBoard, place } from "./board";
import { kicksFor } from "./kicks";
import { DEFAULT_HANDLING, FRAME_MS, validateHandling, type Handling } from "./handling";
import { SPAWN_Y, spawnX, type PieceId } from "./pieces";

// Key state events let the core own repeat timing.
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
}

export type GameEvent = LockResult | Readonly<{ type: "restored"; sequence: number; atMs: number }>;

export class Game {
  readonly rulesVersion = RULES_VERSION;
  private lastResult: LockResult | null = null;
  private events: GameEvent[] = [];
  private sequence = 0;
  private zenEnabled = false;
  private history: ReturnType<Game["capture"]>[] = [];
  private turn: ReturnType<Game["capture"]> | null = null;

  readonly board: Uint8Array = createBoard();
  // upcoming pieces in deal order, refilled from the bag as pieces spawn
  readonly previews: Uint8Array;
  // pieces dealt so far, current one included
  dealt = 0;
  piece: PieceId;
  rot = 0;
  x: number;
  y: number;
  topOut = false;
  held: PieceId | null = null;
  holdUsed = false;
  // Rotation eligibility survives failed actions. Kick 0 means no kick.
  lastWasRotation = false;
  lastKickIndex = 0;

  private bag: Bag;
  private gravityMs: number;
  private lastNow = -1;
  private observedNow = -1;
  private fallAcc = 0;
  private lockElapsed = 0;
  private handling: Handling;
  private leftHeld = false;
  private rightHeld = false;
  private direction = 0;
  private moveAt = Infinity;
  private softHeld = false;
  private softAt = Infinity;
  private readyMs: number;
  paused = false;

  constructor(seed: number, gravityMs = 500, previewCount = 5, handling: Handling = DEFAULT_HANDLING, readyMs = 0) {
    validateHandling(handling);
    this.handling = { ...handling };
    this.bag = new Bag(seed);
    this.gravityMs = gravityMs;
    this.readyMs = readyMs;
    this.previews = new Uint8Array(previewCount);
    for (let i = 0; i < previewCount; i++) this.previews[i] = this.bag.next();
    this.piece = this.starting ? this.previews[0] as PieceId : this.takeNext();
    this.x = spawnX(this.piece);
    this.y = SPAWN_Y;
  }

  get stats(): ClearStats { return this.lastResult?.stats ?? INITIAL_STATS; }
  get lastClear(): LockResult | null { return this.lastResult; }
  get zen(): boolean { return this.zenEnabled; }
  get undoCount(): number { return this.history.length; }

  drainEvents(): GameEvent[] {
    const events = this.events;
    this.events = [];
    return events;
  }

  setZen(enabled: boolean): void {
    if (enabled === this.zenEnabled) return;
    if (enabled && !this.starting && !this.topOut && this.observedNow >= 0) this.advanceTo(this.observedNow);
    this.zenEnabled = enabled;
    this.history = [];
    this.turn = enabled && !this.starting && !this.topOut ? this.capture() : null;
  }

  undo(nowMs: number): boolean {
    if (!this.zenEnabled || !this.history.length) return false;
    const checkpoint = this.history.pop()!;
    this.board.set(checkpoint.board);
    this.previews.set(checkpoint.previews);
    this.bag.restore(checkpoint.bag);
    Object.assign(this, checkpoint.state);
    this.lastNow = this.observedNow = nowMs;
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
        lastResult: this.lastResult,
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
    if (this.paused || this.topOut) return;
    this.tick(nowMs);
    if (this.topOut || this.starting) return;
    this.advanceTo(nowMs);
    if (input === Input.LeftDown || input === Input.RightDown) {
      const left = input === Input.LeftDown;
      if (left ? this.leftHeld : this.rightHeld) return;
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
    else if (input === Input.RotateCw) this.rotate(1);
    else if (input === Input.RotateCcw) this.rotate(3);
    else if (input === Input.Rotate180) this.rotate(2);
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
    if (this.turn) {
      if (this.history.length === UNDO_LIMIT) this.history.shift();
      this.history.push(this.turn);
    }
    const spin = classifySpin(this.board, this.piece, this.rot, this.x, this.y, this.lastWasRotation, this.lastKickIndex);
    place(this.board, this.piece, this.rot, this.x, this.y);
    const { rows, garbage } = clearRows(this.board);
    const allClear = rows.length > 0 && this.board.every(cell => cell === 0);
    const { stats, attacks } = resolveClear(this.stats, { lines: rows.length, spin, allClear, garbage });
    const result: LockResult = Object.freeze({
      type: "lock", sequence: ++this.sequence, atMs: this.lastNow, piece: this.piece,
      rows: Object.freeze(rows), spin, allClear, stats, attacks,
    });
    this.lastResult = result;
    this.events.push(result);
    this.spawn();
    this.beginTurn();
  }

  private tryMove(dx: number): boolean {
    if (canPlace(this.board, this.piece, this.rot, this.x + dx, this.y)) {
      this.x += dx;
      this.lastWasRotation = false;
      this.refreshLock();
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
    if (this.direction && this.handling.arr === 0 && this.moveAt === Infinity) {
      while (this.tryMove(this.direction)) { /* keep charged across spawns */ }
    }
  }

  private fallOne(): boolean {
    if (!canPlace(this.board, this.piece, this.rot, this.x, this.y + 1)) return false;
    this.y++;
    this.lastWasRotation = false;
    this.refreshLock();
    return true;
  }

  private refreshLock(): void {
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
    validateHandling(handling);
    if (this.observedNow >= 0 && !this.starting && !this.topOut) this.advanceTo(this.observedNow);
    this.handling = { ...handling };
    this.releaseInputs();
  }

  private releaseInputs(): void {
    this.leftHeld = this.rightHeld = this.softHeld = false;
    this.direction = 0;
    this.moveAt = this.softAt = Infinity;
  }

  setPaused(paused: boolean, nowMs: number): void {
    if (paused === this.paused) return;
    if (paused) {
      this.tick(nowMs);
      if (!this.starting && !this.topOut) this.advanceTo(nowMs);
    }
    this.paused = paused;
    this.lastNow = this.observedNow = nowMs;
    this.releaseInputs();
  }

  private rotate(turns: number): void {
    const to = (this.rot + turns) & 3;
    if (canPlace(this.board, this.piece, to, this.x, this.y)) {
      this.rot = to;
      this.lastKickIndex = 0;
      this.lastWasRotation = true;
      this.refreshLock();
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
        this.refreshLock();
        return;
      }
    }
  }

  private fallSpeed(): number {
    return this.softHeld && this.lastNow >= this.softAt && this.handling.sdarr > 0
      ? 1 + this.gravityMs / (this.handling.sdarr * FRAME_MS) : 1;
  }

  private advanceTo(nowMs: number): void {
    if (canPlace(this.board, this.piece, this.rot, this.x, this.y + 1)) {
      this.fallAcc += (nowMs - this.lastNow) * this.fallSpeed();
    } else {
      this.lockElapsed += nowMs - this.lastNow;
    }
    this.lastNow = nowMs;
  }

  tick(nowMs: number): void {
    if (this.topOut || this.paused) return;
    this.observedNow = nowMs;
    if (this.lastNow < 0) {
      this.lastNow = nowMs;
      return;
    }
    if (nowMs <= this.lastNow) return;
    if (this.starting) {
      const elapsed = Math.min(nowMs - this.lastNow, this.readyMs);
      this.readyMs -= elapsed;
      this.lastNow += elapsed;
      if (this.starting) return;
      this.spawn();
      this.beginTurn();
    }
    while (this.lastNow < nowMs && !this.topOut) {
      this.instantSoftDrop();
      this.repeatChargedMove();
      const airborne = canPlace(this.board, this.piece, this.rot, this.x, this.y + 1);
      const speed = this.fallSpeed();
      const gravityAt = airborne ? this.lastNow + (this.gravityMs - this.fallAcc) / speed : Infinity;
      const lockAt = airborne ? Infinity : this.lastNow + LOCK_DELAY_MS - this.lockElapsed;
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
      if (this.lockElapsed >= LOCK_DELAY_MS && !canPlace(this.board, this.piece, this.rot, this.x, this.y + 1)) this.lock();
      this.repeatChargedMove();
    }
  }

  private spawn(piece = this.takeNext()): void {
    this.piece = piece;
    this.holdUsed = false;
    this.rot = 0;
    this.x = spawnX(this.piece);
    this.y = SPAWN_Y;
    this.lastWasRotation = false;
    this.lastKickIndex = 0;
    this.fallAcc = 0;
    this.lockElapsed = 0;
    if (!canPlace(this.board, this.piece, this.rot, this.x, this.y)) {
      this.topOut = true;
    }
  }
}
