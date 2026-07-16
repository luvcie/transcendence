import { Bag } from "./bag";
import { canPlace, createBoard, place } from "./board";
import { SPAWN_Y, spawnX, type PieceId } from "./pieces";

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
