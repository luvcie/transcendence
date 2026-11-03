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
  | { type: "frame"; at: number; gapMs: number };

export interface CorrectionFlags {
  piece: boolean;
  board: boolean;
  garbage: boolean;
  controls: boolean;
  sent: boolean;
}

export interface SessionDiagnosticsSnapshot {
  events: DiagnosticEvent[];
  inputs: { queued: number; sent: number; batches: number; lastQueueMs: number | null; maxQueueMs: number | null };
  checkpoints: { received: number; stale: number; lastGapMs: number | null; maxGapMs: number | null };
  frames: { count: number; lastGapMs: number | null; maxGapMs: number | null };
  rtt: { samples: number; last: number | null; min: number | null; avg: number | null; max: number | null; jitter: number | null };
  rejections: { total: number; byCode: Record<string, number> };
  releases: { total: number; byReason: Record<string, number> };
  corrections: { compared: number; skipped: number; total: number; piece: number; board: number;
    garbage: number; controls: number; sent: number };
}

const EVENT_CAPACITY = 128;
const RTT_SAMPLES = 16;

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
    this.push({ type: "connection", at, connected });
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
    generation: number; identityChanged: boolean }): void {
    // A new round, match, or generation reuses sequences; old dedupe keys would
    // otherwise hide the first rejection of the new identity.
    if (info.identityChanged) this.seenRejections.clear();
    const gapMs = this.lastCheckpointAt === null ? 0 : at - this.lastCheckpointAt;
    this.lastCheckpointAt = at;
    this.counts.checkpoints++;
    this.counts.lastGapMs = gapMs;
    this.counts.maxGapMs = Math.max(this.counts.maxGapMs ?? 0, gapMs);
    this.push({ type: "checkpoint", at, sequence: info.sequence, serverNow: info.serverNow, frame: info.frame,
      round: info.round, generation: info.generation, gapMs, identityChanged: info.identityChanged });
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

  release(reason: ReleaseReason, at: number, generation: number): void {
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
        lastQueueMs: this.counts.lastQueueMs, maxQueueMs: this.counts.maxQueueMs },
      checkpoints: { received: this.counts.checkpoints, stale: this.counts.staleCheckpoints,
        lastGapMs: this.counts.lastGapMs, maxGapMs: this.counts.maxGapMs },
      frames: { count: this.counts.frames, lastGapMs: this.counts.lastFrameGapMs, maxGapMs: this.counts.maxFrameGapMs },
      rtt: { samples: this.rttSamples.length, last: this.rttSamples.at(-1) ?? null,
        min: this.rttSamples.length ? Math.min(...this.rttSamples) : null,
        avg, max: this.rttSamples.length ? Math.max(...this.rttSamples) : null, jitter },
      rejections: { total: this.counts.rejectionTotal, byCode: { ...this.rejectionCodes } },
      releases: { total: this.counts.releaseTotal, byReason: { ...this.releaseReasons } },
      corrections: { compared: this.counts.compared, skipped: this.counts.skipped, total: this.counts.corrections,
        ...this.correctionCounts },
    };
  }
}
