import type { Room } from "./rooms";

export type Admission = "accepted" | "late" | "future" | "pending-full" | "other";
interface SeatMetrics {
  seat: number;
  accepted: number;
  rejectedLate: number;
  rejectedFuture: number;
  rejectedPendingFull: number;
  rejectedOther: number;
  lateMs: [number, number, number, number, number];
}
interface RoomMetrics {
  room: number;
  nextSeat: number;
  seats: WeakMap<object, SeatMetrics>;
  checkpointsSent: number;
  checkpointsSkipped: number;
  bytesSent: number;
}
export interface NetplayMetricsOptions {
  log?(line: string): void;
  cpuUsage?(): { user: number; system: number };
}
const ADMISSION_FIELD = {
  accepted: "accepted", late: "rejectedLate", future: "rejectedFuture",
  "pending-full": "rejectedPendingFull", other: "rejectedOther",
} as const;
const increment = (value: number, by = 1) => Math.min(Number.MAX_SAFE_INTEGER, value + by);

/** [0,10], (10,25], (25,50], (50,100], (100,+∞), in simulation milliseconds. */
export function latenessBucket(ms: number): number {
  return ms <= 10 ? 0 : ms <= 25 ? 1 : ms <= 50 ? 2 : ms <= 100 ? 3 : 4;
}

/** Constructed only when opted in. No timers, payloads, names or credentials retained. */
export class NetplayMetrics {
  private readonly rooms = new WeakMap<Room, RoomMetrics>();
  private roomNumber = 0;
  private sample = 0;
  private at: number;
  private cpu: { user: number; system: number };
  private readonly readCpu: () => { user: number; system: number };
  private readonly log: (line: string) => void;

  constructor(now: number, options: NetplayMetricsOptions = {}) {
    this.at = now;
    this.readCpu = options.cpuUsage ?? (() => process.cpuUsage());
    this.log = options.log ?? (line => console.log(line));
    this.cpu = this.readCpu();
  }

  private room(room: Room): RoomMetrics {
    let metrics = this.rooms.get(room);
    if (!metrics) {
      metrics = { room: ++this.roomNumber, nextSeat: 0, seats: new WeakMap(),
        checkpointsSent: 0, checkpointsSkipped: 0, bytesSent: 0 };
      this.rooms.set(room, metrics);
    }
    return metrics;
  }

  private seat(metrics: RoomMetrics, seat: object): SeatMetrics {
    let counts = metrics.seats.get(seat);
    if (!counts) {
      counts = { seat: metrics.nextSeat++, accepted: 0, rejectedLate: 0, rejectedFuture: 0,
        rejectedPendingFull: 0, rejectedOther: 0, lateMs: [0, 0, 0, 0, 0] };
      metrics.seats.set(seat, counts);
    }
    return counts;
  }

  admission(room: Room, seat: object, result: Admission, lateMs = 0): void {
    const counts = this.seat(this.room(room), seat);
    const field = ADMISSION_FIELD[result];
    counts[field] = increment(counts[field]);
    if (result === "late") {
      const bucket = latenessBucket(lateMs);
      counts.lateMs[bucket] = increment(counts.lateMs[bucket]);
    }
  }

  transmission(room: Room, bytes: number, checkpoint: boolean, skipped: boolean): void {
    const counts = this.room(room);
    if (checkpoint) {
      if (skipped) counts.checkpointsSkipped = increment(counts.checkpointsSkipped);
      else counts.checkpointsSent = increment(counts.checkpointsSent);
    }
    if (!skipped) counts.bytesSent = increment(counts.bytesSent, bytes);
  }

  private resetSeat(counts: SeatMetrics): void {
    counts.accepted = counts.rejectedLate = counts.rejectedFuture = counts.rejectedPendingFull = counts.rejectedOther = 0;
    counts.lateMs.fill(0);
  }

  /** One process CPU delta per batch, attached only to its first room record. */
  report(rooms: Iterable<Room>, now: number): void {
    // A slightly early interval callback must not defer the next report for another ten seconds.
    if (now - this.at < 9950) return;
    const currentCpu = this.readCpu();
    let processCpu: { scope: "process"; userUs: number; systemUs: number } | null = {
      scope: "process", userUs: currentCpu.user - this.cpu.user, systemUs: currentCpu.system - this.cpu.system,
    };
    const windowMs = now - this.at;
    const sample = ++this.sample;
    this.at = now;
    this.cpu = currentCpu;
    for (const room of rooms) {
      if (!room.match || room.phase === "waiting" || room.phase === "setResult") {
        const metrics = this.rooms.get(room);
        if (metrics) {
          metrics.checkpointsSent = metrics.checkpointsSkipped = metrics.bytesSent = 0;
          for (const seat of room.seats) {
            const counts = metrics.seats.get(seat);
            if (counts) this.resetSeat(counts);
          }
        }
        continue;
      }
      const metrics = this.room(room);
      const seats = room.seats.map(seat => {
        const counts = this.seat(metrics, seat);
        const snapshot = { ...counts, lateMs: [...counts.lateMs] };
        this.resetSeat(counts);
        return snapshot;
      });
      this.log(JSON.stringify({ type: "netplay-metrics", room: metrics.room, sample, windowMs, seats,
        lateBucketsMs: ["[0,10]", "(10,25]", "(25,50]", "(50,100]", ">100"],
        transmission: { checkpointsSent: metrics.checkpointsSent, checkpointsSkipped: metrics.checkpointsSkipped,
          bytesSent: metrics.bytesSent, measurement: "serialized-utf8-payload-offered-to-send" }, processCpu }));
      processCpu = null;
      metrics.checkpointsSent = metrics.checkpointsSkipped = metrics.bytesSent = 0;
    }
  }
}
