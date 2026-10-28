import { Bag } from "./bag";
import { canPlace, createBoard, place } from "./board";
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

export class Game {
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
  // spin detection at lock will need these: was the last successful
  // action a rotation, and which kick made it fit (0 = no kick)
  lastWasRotation = false;
  lastKickIndex = 0;

  private bag: Bag;
  private gravityMs: number;
  private lastNow = -1;
  private fallAcc = 0;
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

  get starting(): boolean {
    return this.readyMs > 0;
  }

  private takeNext(): PieceId {
    const next = this.previews[0] as PieceId;
    // shift left in place, no allocation
    this.previews.copyWithin(0, 1);
    this.previews[this.previews.length - 1] = this.bag.next();
    this.dealt++;
    return next;
  }

  apply(input: InputId, nowMs: number): void {
    if (this.paused || this.topOut) return;
    this.tick(nowMs);
    if (this.topOut || this.starting) return;
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
    place(this.board, this.piece, this.rot, this.x, this.y);
    this.spawn();
  }

  private tryMove(dx: number): boolean {
    if (canPlace(this.board, this.piece, this.rot, this.x + dx, this.y)) {
      this.x += dx;
      this.lastWasRotation = false;
      this.instantSoftDrop();
      return true;
    }
    return false;
  }

  private repeatMove(nowMs: number): void {
    if (!this.direction || nowMs < this.moveAt) return;
    if (this.handling.arr === 0) {
      while (this.tryMove(this.direction)) { /* move to the wall */ }
      this.moveAt = Infinity;
    } else {
      const moved = this.tryMove(this.direction);
      // Blocked repeats stay charged, retrying on the next logical frame.
      this.moveAt = nowMs + (moved ? this.handling.arr : 1) * FRAME_MS;
    }
  }

  private fallOne(): boolean {
    if (!canPlace(this.board, this.piece, this.rot, this.x, this.y + 1)) return false;
    this.y++;
    this.lastWasRotation = false;
    return true;
  }

  private dropToSurface(): void {
    while (this.fallOne()) { /* soft drop never locks */ }
  }

  private instantSoftDrop(): void {
    if (!this.topOut && this.softHeld && this.handling.sdarr === 0 && this.lastNow >= this.softAt) {
      this.dropToSurface();
    }
  }

  setHandling(handling: Handling): void {
    validateHandling(handling);
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
    if (paused) this.tick(nowMs);
    this.paused = paused;
    this.lastNow = nowMs;
    this.releaseInputs();
  }

  private rotate(turns: number): void {
    const to = (this.rot + turns) & 3;
    // natural rotation first, then the kick table in order, first fit wins
    if (canPlace(this.board, this.piece, to, this.x, this.y)) {
      this.rot = to;
      this.lastKickIndex = 0;
      this.lastWasRotation = true;
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
        return;
      }
    }
  }

  // time always comes in from outside, the core never reads a clock
  tick(nowMs: number): void {
    if (this.topOut || this.paused) return;
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
    }
    // Advance to input/gravity deadlines, independent of render frame rate.
    while (this.lastNow < nowMs && !this.topOut) {
      this.instantSoftDrop();
      const airborne = canPlace(this.board, this.piece, this.rot, this.x, this.y + 1);
      const soft = this.softHeld && this.lastNow >= this.softAt && this.handling.sdarr > 0;
      // Techmino adds soft-drop speed to gravity; interpolate it for fractional F.
      const speed = soft && airborne ? 1 + this.gravityMs / (this.handling.sdarr * FRAME_MS) : 1;
      const gravityAt = this.lastNow + (this.gravityMs - this.fallAcc) / speed;
      const next = Math.min(nowMs, this.moveAt, this.softAt > this.lastNow ? this.softAt : Infinity, gravityAt);
      this.fallAcc += (next - this.lastNow) * speed;
      this.lastNow = next;
      this.repeatMove(next);
      this.instantSoftDrop();
      if (next >= gravityAt) {
        this.fallAcc = 0;
        this.stepDown();
      }
      // Zero ARR remains charged after reaching a wall, including across spawns.
      if (this.direction && this.handling.arr === 0 && this.moveAt === Infinity) {
        while (this.tryMove(this.direction)) { /* keep charged */ }
      }
    }
  }

  private stepDown(): void {
    if (this.fallOne()) return;
    // no lock delay yet, the piece locks the moment it touches down
    place(this.board, this.piece, this.rot, this.x, this.y);
    this.spawn();
  }

  private spawn(piece = this.takeNext()): void {
    this.piece = piece;
    this.holdUsed = false;
    this.rot = 0;
    this.x = spawnX(this.piece);
    this.y = SPAWN_Y;
    this.lastWasRotation = false;
    this.lastKickIndex = 0;
    // a fresh piece starts its fall timer from zero, otherwise a big
    // frame gap would slam it several rows down the moment it spawns
    this.fallAcc = 0;
    if (!canPlace(this.board, this.piece, this.rot, this.x, this.y)) {
      this.topOut = true;
    }
  }
}
