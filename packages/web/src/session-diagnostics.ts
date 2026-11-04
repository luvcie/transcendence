import type { OwnerPredictionState } from "@42tris/match";

/**
 * Opt-in, bounded client netplay instrumentation. Nothing here is part of
 * deterministic gameplay, checkpoint payloads, or replay journals.
 */
export type ReleaseReason =
  | "user"
  | "rejected-input"
  | "stale-input"
  | "sequence-expired"
  | "rate-limit"
  | "wrong-phase"
  | "sequence-gap"
  | "pending-overflow"
  | "stale-prediction"
  | "gap-recovery";

export type DiagnosticEvent =
  | { type: "connection"; at: number; connected: boolean }
  | { type: "checkpoint"; at: number; sequence: number; serverNow: number; frame: number; round: number;
      generation: number; gapMs: number; identityChanged: boolean }
  | { type: "staleCheckpoint"; at: number }
  | { type: "batch"; at: number; count: number; maxQueueMs: number; pending: number }
  | { type: "rejection"; at: number; code: string; seq: number | null }
  | { type: "release"; at: number; reason: ReleaseReason; generation: number }
  | { type: "correction"; at: number; atMs: number; piece: boolean; board: boolean; garbage: boolean;
      controls: boolean; sent: boolean }
  | { type: "frame"; at: number; gapMs: number }
  | { type: "staleRecovery"; at: number; retracted: number; reissued: number };

export interface CorrectionFlags {
  piece: boolean;
  board: boolean;
  garbage: boolean;
  controls: boolean;
  sent: boolean;
}

export interface SessionDiagnosticsSnapshot {
  events: DiagnosticEvent[];
  inputs: { queued: number; sent: number; batches: number; lastQueueMs: number | null; maxQueueMs: number | null;
    marginAtSendMs: { p5: number | null; p50: number | null } };
  checkpoints: { received: number; stale: number; lastGapMs: number | null; maxGapMs: number | null;
    ageMs: { last: number | null; p50: number | null; p95: number | null; max: number | null } };
  frames: { count: number; lastGapMs: number | null; maxGapMs: number | null };
  rtt: { samples: number; last: number | null; min: number | null; avg: number | null; max: number | null; jitter: number | null };
  transport: { bytesPerSec: number; messagesPerSec: number; maxMessageBytes: number;
    measurement: "received-application-payload"; windowMs: number; sampleMs: number };
  lead: { mode: "zero" | "fixed" | "adaptive"; requestedMs: number | null; appliedMs: number;
    proposedNextMs: number | null; wantedMs: number | null; ceilingMs: number | null; reason: string | null; capped: boolean };
  adaptive: { sampleCount: number; newestSampleAgeMs: number | null; rttMin: number | null; rttMedian: number | null;
    rttP95: number | null; effectiveTransitMedian: number | null; effectiveTransitP95: number | null; decreaseConfirmed: boolean;
    decisions: { at: number; roundOrdinal: number; previousMs: number; appliedMs: number; reason: string;
      wantedMs: number | null; ceilingMs: number | null; rttP95: number | null; effectiveTransitP95: number | null }[] };
  clock: { offsetSamples: number[]; driftMsPerMin: number | null;
    estimatedOffsetMs: number | null; bestRttMs: number | null; calibrated: boolean;
    effectiveOffsetMs: number | null; selectedSampleAgeMs: number | null; selectedSampleRttMs: number | null;
    quality: "unwarmed" | "fresh" | "stale" | "capped" };
  control: { blockedMs: number; blockedPct: number; eligibleMs: number };
  rejections: { total: number; byCode: Record<string, number> };
  releases: { total: number; byReason: Record<string, number> };
  staleRecovery: { count: number; retracted: number; reissued: number };
  corrections: { compared: number; skipped: number; total: number; piece: number; board: number;
    garbage: number; controls: number; sent: number };
}

const EVENT_CAPACITY = 128;
const RTT_SAMPLES = 16;

class Samples<T> {
  private readonly items: T[] = [];
  private next = 0;
  constructor(private readonly capacity: number) {}
  push(value: T): void {
    this.items[this.next] = value;
    this.next = (this.next + 1) % this.capacity;
  }
  clear(): void { this.items.length = 0; this.next = 0; }
  values(): T[] {
    return this.items.length < this.capacity ? [...this.items]
      : [...this.items.slice(this.next), ...this.items.slice(0, this.next)];
  }
}

function percentile(sorted: number[], p: number): number | null {
  return sorted.length ? sorted[Math.round((sorted.length - 1) * p)] : null;
}

/** Decoded application payload bytes, excluding framing/compression/TLS/TCP. */
export function messagePayloadBytes(data: string | Blob | ArrayBuffer | ArrayBufferView): number {
  if (typeof data === "string") return new TextEncoder().encode(data).byteLength;
  return data instanceof Blob ? data.size : data.byteLength;
}

interface ControlObservation {
  eligible: boolean;
  playable: boolean;
  expiresAt: number;
}

function sameBoard(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function sameGarbage(a: OwnerPredictionState["garbage"], b: OwnerPredictionState["garbage"]): boolean {
  if (a.hole !== b.hole || a.rng !== b.rng || a.packets.length !== b.packets.length) return false;
  for (let i = 0; i < a.packets.length; i++) {
    const x = a.packets[i], y = b.packets[i];
    if (x.id !== y.id || x.from !== y.from || x.to !== y.to || x.lines !== y.lines
      || x.kind !== y.kind || x.atMs !== y.atMs || x.eligibleAtMs !== y.eligibleAtMs) return false;
  }
  return true;
}

/** Classify a correction only after both states were evaluated at the same simulation time. */
export function classifyCorrection(before: OwnerPredictionState, after: OwnerPredictionState): CorrectionFlags | null {
  if (before.atMs !== after.atMs) return null;
  const a = before.game.state, b = after.game.state;
  const flags = {
    piece: a.piece !== b.piece || a.rot !== b.rot || a.x !== b.x || a.y !== b.y
      || a.held !== b.held || a.holdUsed !== b.holdUsed,
    board: !sameBoard(before.game.board, after.game.board),
    garbage: !sameGarbage(before.garbage, after.garbage),
    controls: a.leftHeld !== b.leftHeld || a.rightHeld !== b.rightHeld || a.softHeld !== b.softHeld
      || a.direction !== b.direction || a.moveAt !== b.moveAt || a.softAt !== b.softAt,
    sent: before.sent !== after.sent,
  };
  return flags.piece || flags.board || flags.garbage || flags.controls || flags.sent ? flags : null;
}

export class SessionDiagnostics {
  private now: () => number = () => performance.now();
  private readControl?: () => ControlObservation;
  private readTiming?: () => {
    lead: SessionDiagnosticsSnapshot["lead"];
    adaptive: SessionDiagnosticsSnapshot["adaptive"];
    clock: Omit<SessionDiagnosticsSnapshot["clock"], "offsetSamples" | "driftMsPerMin">;
  };
  private controlAt: number | null = null;
  private controlState?: ControlObservation;
  private eligibleMs = 0;
  private blockedMs = 0;
  private userReleased = false;
  private readonly ages = new Samples<number>(256);
  private readonly margins = new Samples<number>(256);
  private readonly offsets = new Samples<{ at: number; offset: number }>(16);
  private readonly traffic: { tick: number; bytes: number; messages: number }[] = [];
  private transportAt: number | null = null;
  private maxMessageBytes = 0;

  private events: DiagnosticEvent[] = [];
  private queued = new Map<number, number>();
  private seenRejections = new Set<string>();
  private rttSamples: number[] = [];
  private lastCheckpointAt: number | null = null;
  private lastFrameAt: number | null = null;
  private lastConnected: boolean | null = null;
  private counts = {
    queued: 0, sent: 0, batches: 0, lastQueueMs: null as number | null, maxQueueMs: null as number | null,
    checkpoints: 0, staleCheckpoints: 0, lastGapMs: null as number | null, maxGapMs: null as number | null,
    frames: 0, lastFrameGapMs: null as number | null, maxFrameGapMs: null as number | null,
    rejectionTotal: 0, releaseTotal: 0,
    compared: 0, skipped: 0, corrections: 0,
  };
  private recoveries = { count: 0, retracted: 0, reissued: 0 };
  private rejectionCodes: Record<string, number> = Object.create(null);
  private releaseReasons: Record<string, number> = Object.create(null);
  private correctionCounts = { piece: 0, board: 0, garbage: 0, controls: 0, sent: 0 };

  private push(event: DiagnosticEvent): void {
    if (this.events.length >= EVENT_CAPACITY) this.events.shift();
    this.events.push(event);
  }

  connection(at: number, connected: boolean): void {
    if (this.lastConnected === connected) return;
    this.lastConnected = connected;
    this.ages.clear();
    this.offsets.clear();
    this.margins.clear();
    this.lastCheckpointAt = null;
    if (connected) {
      this.transportAt = at;
      this.traffic.length = 0;
      this.maxMessageBytes = 0;
    }
    this.push({ type: "connection", at, connected });
  }

  /** Session supplies only scalar state; snapshots can include an open blocked interval. */
  attach(now: () => number, readControl: () => ControlObservation, readTiming?: SessionDiagnostics["readTiming"]): void {
    this.now = now;
    this.readControl = readControl;
    this.readTiming = readTiming;
    this.updateControl();
  }

  updateControl(): void {
    const at = this.now();
    const previous = this.controlState;
    if (previous?.eligible && this.controlAt !== null && at >= this.controlAt) {
      const elapsed = at - this.controlAt;
      this.eligibleMs += elapsed;
      this.blockedMs += previous.playable
        ? Math.max(0, at - Math.max(this.controlAt, previous.expiresAt)) : elapsed;
    }
    this.controlAt = at;
    const current = this.readControl?.();
    this.controlState = current && { ...current, eligible: current.eligible && !this.userReleased };
  }

  receivedMessage(at: number, data: string | Blob | ArrayBuffer | ArrayBufferView): void {
    const bytes = messagePayloadBytes(data);
    this.transportAt ??= at;
    const tick = Math.floor(at / 100);
    const index = ((tick % 101) + 101) % 101;
    let bucket = this.traffic[index];
    if (!bucket || bucket.tick !== tick) this.traffic[index] = bucket = { tick, bytes: 0, messages: 0 };
    bucket.bytes += bytes;
    bucket.messages++;
    this.maxMessageBytes = Math.max(this.maxMessageBytes, bytes);
  }

  clockOffset(at: number, offset: number): void {
    if (Number.isFinite(at) && Number.isFinite(offset)) this.offsets.push({ at, offset });
  }

  inputMargin(stamp: number, committedEstimate: number): void {
    const margin = stamp - committedEstimate;
    if (Number.isFinite(margin)) this.margins.push(margin);
  }

  queuedInput(seq: number, at: number): void {
    this.counts.queued++;
    this.queued.set(seq, at);
    if (this.queued.size > 256) this.queued.delete(this.queued.keys().next().value!);
  }

  sentBatch(at: number, seqs: number[], pending: number): void {
    let maxQueueMs = -1;
    for (const seq of seqs) {
      const queuedAt = this.queued.get(seq);
      this.queued.delete(seq);
      if (queuedAt !== undefined) maxQueueMs = Math.max(maxQueueMs, at - queuedAt);
    }
    this.counts.batches++;
    this.counts.sent += seqs.length;
    if (maxQueueMs >= 0) {
      this.counts.lastQueueMs = maxQueueMs;
      this.counts.maxQueueMs = Math.max(this.counts.maxQueueMs ?? 0, maxQueueMs);
      // Counters cover every batch; the ring only keeps batches that crossed the
      // 34 ms throttle boundary, so routine sends cannot evict stall evidence.
      if (maxQueueMs >= 34) this.push({ type: "batch", at, count: seqs.length, maxQueueMs, pending });
    }
  }

  clearQueue(): void {
    this.queued.clear();
  }

  checkpoint(at: number, info: { sequence: number; serverNow: number; frame: number; round: number;
    generation: number; identityChanged: boolean; estimatedOffset?: number }): void {
    // A new round, match, or generation reuses sequences; old dedupe keys would
    // otherwise hide the first rejection of the new identity.
    if (info.identityChanged) this.identityChanged();
    if (info.estimatedOffset !== undefined) {
      const age = at + info.estimatedOffset - info.serverNow;
      if (Number.isFinite(age)) this.ages.push(age);
    }
    const gapMs = this.lastCheckpointAt === null ? 0 : at - this.lastCheckpointAt;
    this.lastCheckpointAt = at;
    this.counts.checkpoints++;
    this.counts.lastGapMs = gapMs;
    this.counts.maxGapMs = Math.max(this.counts.maxGapMs ?? 0, gapMs);
    this.push({ type: "checkpoint", at, sequence: info.sequence, serverNow: info.serverNow, frame: info.frame,
      round: info.round, generation: info.generation, gapMs, identityChanged: info.identityChanged });
  }

  identityChanged(): void {
    this.seenRejections.clear();
    this.ages.clear();
    this.margins.clear();
    this.userReleased = false;
  }

  staleCheckpoint(at: number): void {
    this.counts.staleCheckpoints++;
    this.push({ type: "staleCheckpoint", at });
  }

  frame(at: number): void {
    this.counts.frames++;
    if (this.lastFrameAt !== null) {
      const gapMs = at - this.lastFrameAt;
      this.counts.lastFrameGapMs = gapMs;
      this.counts.maxFrameGapMs = Math.max(this.counts.maxFrameGapMs ?? 0, gapMs);
      if (gapMs >= 32) this.push({ type: "frame", at, gapMs });
    }
    this.lastFrameAt = at;
  }

  rtt(value: number): void {
    if (this.rttSamples.length >= RTT_SAMPLES) this.rttSamples.shift();
    this.rttSamples.push(value);
  }

  rejection(at: number, code: string, seq: number | null): void {
    this.counts.rejectionTotal++;
    this.rejectionCodes[code] = (this.rejectionCodes[code] ?? 0) + 1;
    this.push({ type: "rejection", at, code, seq });
  }

  rejections(at: number, list: readonly { seq: number; code: string }[], generation: number): void {
    for (const rejection of list) {
      const key = `${generation}:${rejection.seq}:${rejection.code}`;
      if (this.seenRejections.has(key)) continue;
      if (this.seenRejections.size >= 256) this.seenRejections.clear();
      this.seenRejections.add(key);
      this.rejection(at, rejection.code, rejection.seq);
    }
  }

  /** Keep queue timing attached to inputs whose local sequence number changed. */
  renumber(seqs: Map<number, number>, retracted: readonly number[]): void {
    for (const seq of retracted) this.queued.delete(seq);
    for (const [from, to] of seqs) {
      const queuedAt = this.queued.get(from);
      if (queuedAt === undefined) continue;
      this.queued.delete(from);
      this.queued.set(to, queuedAt);
    }
  }

  recovered(at: number, retracted: number, reissued: number): void {
    this.recoveries.count++;
    this.recoveries.retracted += retracted;
    this.recoveries.reissued += reissued;
    this.push({ type: "staleRecovery", at, retracted, reissued });
  }

  release(reason: ReleaseReason, at: number, generation: number): void {
    this.userReleased = reason === "user";
    this.counts.releaseTotal++;
    this.releaseReasons[reason] = (this.releaseReasons[reason] ?? 0) + 1;
    this.push({ type: "release", at, reason, generation });
  }

  correction(at: number, atMs: number, before: OwnerPredictionState, after: OwnerPredictionState): void {
    this.counts.compared++;
    if (before.atMs !== atMs || after.atMs !== atMs) {
      // Different timestamps would report phantom divergence; never classify one.
      this.counts.skipped++;
      return;
    }
    const flags = classifyCorrection(before, after);
    if (!flags) return;
    this.counts.corrections++;
    for (const key of ["piece", "board", "garbage", "controls", "sent"] as const) if (flags[key]) this.correctionCounts[key]++;
    this.push({ type: "correction", at, atMs, ...flags });
  }

  /** Plain JSON-serializable summary. Contains no tokens, identities, names, or boards. */
  snapshot(): SessionDiagnosticsSnapshot {
    this.updateControl();
    const at = this.now();
    const ages = this.ages.values();
    const sortedAges = [...ages].sort((a, b) => a - b);
    const margins = this.margins.values().sort((a, b) => a - b);
    const offsets = this.offsets.values();
    const timing = this.readTiming?.();
    let drift: number | null = null;
    if (offsets.length >= 3 && offsets.at(-1)!.at - offsets[0].at >= 1000) {
      // Centre both coordinates before fitting to avoid cancellation at large clock values.
      const origin = offsets[0].at;
      const meanTime = offsets.reduce((sum, s) => sum + (s.at - origin), 0) / offsets.length;
      const meanOffset = offsets.reduce((sum, s) => sum + s.offset, 0) / offsets.length;
      let numerator = 0, denominator = 0;
      for (const sample of offsets) {
        const time = sample.at - origin - meanTime;
        numerator += time * (sample.offset - meanOffset);
        denominator += time * time;
      }
      if (denominator > 0) drift = numerator / denominator * 60_000;
    }
    let bytes = 0, messages = 0;
    const tick = Math.floor(at / 100);
    for (const bucket of this.traffic) {
      if (bucket && bucket.tick >= tick - 100 && bucket.tick <= tick) {
        bytes += bucket.bytes;
        messages += bucket.messages;
      }
    }
    const sampleMs = this.transportAt === null ? 0 : Math.min(10_000, Math.max(0, at - this.transportAt));
    const avg = this.rttSamples.length
      ? this.rttSamples.reduce((sum, value) => sum + value, 0) / this.rttSamples.length : null;
    let jitter: number | null = null;
    if (this.rttSamples.length > 1) {
      let total = 0;
      for (let i = 1; i < this.rttSamples.length; i++) total += Math.abs(this.rttSamples[i] - this.rttSamples[i - 1]);
      jitter = total / (this.rttSamples.length - 1);
    }
    return {
      events: this.events.map(event => ({ ...event })),
      inputs: { queued: this.counts.queued, sent: this.counts.sent, batches: this.counts.batches,
        lastQueueMs: this.counts.lastQueueMs, maxQueueMs: this.counts.maxQueueMs,
        marginAtSendMs: { p5: percentile(margins, 0.05), p50: percentile(margins, 0.5) } },
      checkpoints: { received: this.counts.checkpoints, stale: this.counts.staleCheckpoints,
        lastGapMs: this.counts.lastGapMs, maxGapMs: this.counts.maxGapMs,
        ageMs: { last: ages.at(-1) ?? null, p50: percentile(sortedAges, 0.5), p95: percentile(sortedAges, 0.95),
          max: sortedAges.at(-1) ?? null } },
      frames: { count: this.counts.frames, lastGapMs: this.counts.lastFrameGapMs, maxGapMs: this.counts.maxFrameGapMs },
      rtt: { samples: this.rttSamples.length, last: this.rttSamples.at(-1) ?? null,
        min: this.rttSamples.length ? Math.min(...this.rttSamples) : null,
        avg, max: this.rttSamples.length ? Math.max(...this.rttSamples) : null, jitter },
      transport: { bytesPerSec: sampleMs > 0 ? bytes * 1000 / sampleMs : 0,
        messagesPerSec: sampleMs > 0 ? messages * 1000 / sampleMs : 0, maxMessageBytes: this.maxMessageBytes,
        measurement: "received-application-payload", windowMs: 10_000, sampleMs },
      lead: timing?.lead ?? { mode: "zero", requestedMs: 0, appliedMs: 0, proposedNextMs: null,
        wantedMs: null, ceilingMs: null, reason: null, capped: false },
      adaptive: timing?.adaptive ?? { sampleCount: 0, newestSampleAgeMs: null, rttMin: null, rttMedian: null, rttP95: null,
        effectiveTransitMedian: null, effectiveTransitP95: null, decreaseConfirmed: false, decisions: [] },
      clock: { offsetSamples: offsets.map(s => s.offset), driftMsPerMin: drift,
        ...(timing?.clock ?? { estimatedOffsetMs: null, bestRttMs: null, calibrated: false, effectiveOffsetMs: null, selectedSampleAgeMs: null, selectedSampleRttMs: null, quality: "unwarmed" }) },
      control: { blockedMs: this.blockedMs, blockedPct: this.eligibleMs > 0 ? this.blockedMs / this.eligibleMs * 100 : 0,
        eligibleMs: this.eligibleMs },
      rejections: { total: this.counts.rejectionTotal, byCode: { ...this.rejectionCodes } },
      releases: { total: this.counts.releaseTotal, byReason: { ...this.releaseReasons } },
      staleRecovery: { ...this.recoveries },
      corrections: { compared: this.counts.compared, skipped: this.counts.skipped, total: this.counts.corrections,
        ...this.correctionCounts },
    };
  }
}
