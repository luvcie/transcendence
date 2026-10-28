import { Bag } from "./bag";
import { canPlace, createBoard, place } from "./board";
import { kicksFor } from "./kicks";
import { SPAWN_Y, spawnX, type PieceId } from "./pieces";

// key state events, not move commands, so das/arr can be simulated
// inside the core later without changing this api
export const Input = {
  LeftDown: 0,
  LeftUp: 1,
  RightDown: 2,
  RightUp: 3,
  RotateCw: 4,
  RotateCcw: 5,
  Rotate180: 6,
  HardDrop: 7,
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
  // spin detection at lock will need these: was the last successful
  // action a rotation, and which kick made it fit (0 = no kick)
  lastWasRotation = false;
  lastKickIndex = 0;

  private bag: Bag;
  private gravityMs: number;
  private lastNow = -1;
  private fallAcc = 0;

  constructor(seed: number, gravityMs = 500, previewCount = 5) {
    this.bag = new Bag(seed);
    this.gravityMs = gravityMs;
    this.previews = new Uint8Array(previewCount);
    for (let i = 0; i < previewCount; i++) this.previews[i] = this.bag.next();
    this.piece = this.takeNext();
    this.x = spawnX(this.piece);
    this.y = SPAWN_Y;
  }

  private takeNext(): PieceId {
    const next = this.previews[0] as PieceId;
    // shift left in place, no allocation
    this.previews.copyWithin(0, 1);
    this.previews[this.previews.length - 1] = this.bag.next();
    this.dealt++;
    return next;
  }

  // the timestamp is unused until das/arr, it's part of the api on purpose
  apply(input: InputId, _nowMs: number): void {
    if (this.topOut) return;
    if (input === Input.LeftDown) this.tryMove(-1);
    else if (input === Input.RightDown) this.tryMove(1);
    else if (input === Input.RotateCw) this.rotate(1);
    else if (input === Input.RotateCcw) this.rotate(3);
    else if (input === Input.Rotate180) this.rotate(2);
    else if (input === Input.HardDrop) this.hardDrop();
  }

  private hardDrop(): void {
    while (canPlace(this.board, this.piece, this.rot, this.x, this.y + 1)) {
      this.y++;
      this.lastWasRotation = false;
    }
    place(this.board, this.piece, this.rot, this.x, this.y);
    this.spawn();
  }

  private tryMove(dx: number): void {
    if (canPlace(this.board, this.piece, this.rot, this.x + dx, this.y)) {
      this.x += dx;
      this.lastWasRotation = false;
    }
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
    if (this.topOut) return;
    if (this.lastNow < 0) {
      this.lastNow = nowMs;
      return;
    }
    const dt = nowMs - this.lastNow;
    if (dt <= 0) return;
    this.lastNow = nowMs;
    this.fallAcc += dt;
    while (this.fallAcc >= this.gravityMs) {
      this.fallAcc -= this.gravityMs;
      this.stepDown();
      if (this.topOut) return;
    }
  }

  private stepDown(): void {
    if (canPlace(this.board, this.piece, this.rot, this.x, this.y + 1)) {
      this.y++;
      this.lastWasRotation = false;
      return;
    }
    // no lock delay yet, the piece locks the moment it touches down
    place(this.board, this.piece, this.rot, this.x, this.y);
    this.spawn();
  }

  private spawn(): void {
    this.piece = this.takeNext();
    this.rot = 0;
    this.x = spawnX(this.piece);
    this.y = SPAWN_Y;
    // a fresh piece starts its fall timer from zero, otherwise a big
    // frame gap would slam it several rows down the moment it spawns
    this.fallAcc = 0;
    if (!canPlace(this.board, this.piece, this.rot, this.x, this.y)) {
      this.topOut = true;
    }
  }
}
