// splitmix32, deterministic and integer only, state is one number
// so replays can serialize it
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed | 0;
  }

  next(): number {
    this.state = (this.state + 0x9e3779b9) | 0;
    let z = this.state;
    z ^= z >>> 16;
    z = Math.imul(z, 0x21f0aaad);
    z ^= z >>> 15;
    z = Math.imul(z, 0x735a2d97);
    z ^= z >>> 15;
    return z >>> 0;
  }

  // modulo bias is negligible at bag sizes
  nextBelow(n: number): number {
    return this.next() % n;
  }
}
