import { Rng } from "./rng";
import type { PieceId } from "./pieces";

export interface BagState {
  readonly rng: number;
  readonly pieces: Uint8Array;
  readonly index: number;
}

// 7 bag randomizer: every run of 7 pieces is a shuffle of all 7,
// so droughts are bounded (at most 12 pieces between two of a kind)
export class Bag {
  private rng: Rng;
  private pieces = new Uint8Array(7);
  private index = 7;

  constructor(seed: number) {
    this.rng = new Rng(seed);
  }

  save(): BagState {
    return { rng: this.rng.save(), pieces: this.pieces.slice(), index: this.index };
  }

  restore(state: BagState): void {
    this.rng.restore(state.rng);
    this.pieces.set(state.pieces);
    this.index = state.index;
  }

  next(): PieceId {
    if (this.index === 7) this.refill();
    return this.pieces[this.index++] as PieceId;
  }

  private refill() {
    for (let i = 0; i < 7; i++) this.pieces[i] = i + 1;
    // fisher yates shuffle: swap each slot with a random one at or
    // before it, every order comes out equally likely
    for (let i = 6; i > 0; i--) {
      const j = this.rng.nextBelow(i + 1);
      const t = this.pieces[i];
      this.pieces[i] = this.pieces[j];
      this.pieces[j] = t;
    }
    this.index = 0;
  }
}
