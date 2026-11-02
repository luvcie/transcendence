import { FRAME_MS, Rng, type Attack } from "@42tris/core";

export const GARBAGE_PROFILE = "42tris-league-garbage-v1";
export const GARBAGE_DELAY_MS = 20 * FRAME_MS;
export const GARBAGE_CAP = 8;

export interface Packet {
  id: number;
  from: string;
  to: string;
  lines: number;
  kind: Attack["kind"];
  atMs: number;
  eligibleAtMs: number;
}

export type QueueRecord =
  | { type: "cancel"; packet: number; lines: number }
  | { type: "insert"; packet: number; holes: number[] };

export interface GarbageState {
  packets: Packet[];
  rng: number;
  hole: number | null;
}

/** Recipient-owned hole progression, including fully cancelled packets. */
export class GarbageQueue {
  readonly packets: Packet[] = [];
  private rng: Rng;
  private hole: number | null = null;

  constructor(seed: number, private readonly width = 10) { this.rng = new Rng(seed); }

  get pending(): number { return this.packets.reduce((n, p) => n + p.lines, 0); }

  cancel(lines: number, bonus: number, records: QueueRecord[]): number {
    while (this.packets.length && lines + bonus > 0) {
      const packet = this.packets[0];
      const spent = Math.min(packet.lines, lines + bonus);
      const normal = Math.min(spent, lines);
      lines -= normal;
      bonus -= spent - normal;
      packet.lines -= spent;
      records.push({ type: "cancel", packet: packet.id, lines: spent });
      if (!packet.lines) this.finishPacket();
    }
    return lines;
  }

  insert(atMs: number, records: QueueRecord[]): number[] {
    const holes: number[] = [];
    while (holes.length < GARBAGE_CAP && this.packets.length) {
      const packet = this.packets[0];
      // Two frame-to-ms conversions and a delay addition can disagree by a few ULPs.
      const clockError = 4 * Number.EPSILON * Math.max(Math.abs(atMs), Math.abs(packet.eligibleAtMs), GARBAGE_DELAY_MS);
      if (packet.eligibleAtMs - atMs > clockError) break;
      if (this.hole === null) this.hole = this.rng.nextBelow(this.width);
      const count = Math.min(packet.lines, GARBAGE_CAP - holes.length);
      const rows = Array<number>(count).fill(this.hole);
      holes.push(...rows);
      records.push({ type: "insert", packet: packet.id, holes: rows });
      packet.lines -= count;
      if (!packet.lines) this.finishPacket();
    }
    return holes;
  }

  private finishPacket(): void {
    this.packets.shift();
    this.hole = this.rng.nextBelow(this.width);
  }

  saveState(): GarbageState {
    return { packets: this.packets.map(p => ({ ...p })), rng: this.rng.save(), hole: this.hole };
  }

  static fromState(state: GarbageState, width = 10): GarbageQueue {
    const queue = new GarbageQueue(state.rng, width);
    queue.hole = state.hole;
    queue.packets.push(...state.packets.map(p => ({ ...p })));
    return queue;
  }
}
