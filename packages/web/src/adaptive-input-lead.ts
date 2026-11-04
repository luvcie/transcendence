import { FRAME_MS } from "@42tris/core";
import { MAX_INPUT_LEAD_MS } from "@42tris/protocol";

export const THROTTLE_MS = 34;
export const SAFETY_MS = 20;
export const AUTO_MAX_MS = 160;
export const DECREASE_HYSTERESIS_MS = 17;
const SAMPLE_MAX_AGE_MS = 32_000;
const FUTURE_FRAMES = Math.ceil(MAX_INPUT_LEAD_MS / FRAME_MS) + 2;

export interface AdaptivePongSample {
  connectionEpoch: number;
  sentAtClientMs: number;
  receivedAtClientMs: number;
  serverPongMs: number;
  rttMs: number;
  impliedOffsetMs: number;
}

export interface AdaptiveProposal {
  selected: AdaptivePongSample;
  offsetMs: number;
  rttMin: number;
  rttMedian: number;
  rttP95: number;
  effectiveTransitMedian: number;
  effectiveTransitP95: number;
  wantedMs: number;
  ceilingMs: number;
  candidateMs: number;
  capped: boolean;
}

export interface AdaptiveDecision {
  at: number;
  roundOrdinal: number;
  previousMs: number;
  appliedMs: number;
  offsetMs: number | null;
  reason: "selected" | "capped" | "decrease-held" | "ceiling-decrease" | "fallback-unwarmed" | "fallback-stale";
  proposal: AdaptiveProposal | null;
}

export function median(sorted: readonly number[]): number {
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
export function nearestRankP95(sorted: readonly number[]): number {
  return sorted[Math.ceil(0.95 * sorted.length) - 1];
}
const clamp = (value: number, max: number) => Math.max(0, Math.min(max, value));

function selectCalibration(recent: readonly AdaptivePongSample[], now: number): AdaptivePongSample | null {
  const newest = recent.slice(-3);
  if (newest.length < 3 || newest[2].receivedAtClientMs - newest[0].receivedAtClientMs < 1000
    || now - newest[0].receivedAtClientMs > 6000 || now - newest[2].receivedAtClientMs > 3000) return null;
  return newest.reduce((best, sample) => sample.rttMs <= best.rttMs ? sample : best);
}

/** Samples must already be validated and ordered by receipt time. */
export function proposeLead(samples: readonly AdaptivePongSample[], now: number, commitMs: number): AdaptiveProposal | null {
  if (!Number.isFinite(now) || !Number.isFinite(commitMs)) return null;
  const recent = samples.filter(s => now >= s.receivedAtClientMs && now - s.receivedAtClientMs <= SAMPLE_MAX_AGE_MS);
  const selected = selectCalibration(recent, now);
  if (!selected) return null;
  const offsetMs = selected.impliedOffsetMs;
  const rtts = recent.map(s => s.rttMs).sort((a, b) => a - b);
  const transit = recent.map(s => s.serverPongMs - s.sentAtClientMs - offsetMs).sort((a, b) => a - b);
  const wantedMs = Math.ceil(nearestRankP95(transit) + THROTTLE_MS + SAFETY_MS - commitMs);
  const ceilingMs = clamp(Math.floor(FUTURE_FRAMES * FRAME_MS - SAFETY_MS - selected.rttMs / 2), AUTO_MAX_MS);
  return { selected: { ...selected }, offsetMs, rttMin: rtts[0], rttMedian: median(rtts), rttP95: nearestRankP95(rtts),
    effectiveTransitMedian: median(transit), effectiveTransitP95: nearestRankP95(transit),
    wantedMs, ceilingMs, candidateMs: clamp(wantedMs, ceilingMs), capped: wantedMs > ceilingMs };
}

/** Owns adaptive observations, independently of the diagnostics RTT ring. */
export class AdaptiveInputLead {
  private epoch = 0;
  private nonce = 0;
  private lastActivity: number | null = null;
  private probes = new Map<string, { sent: number; contaminated: boolean }>();
  private samples: AdaptivePongSample[] = [];
  private lower: number[] = [];
  private ordinal = 0;
  private observedCount = 0;
  private history: AdaptiveDecision[] = [];

  connection(epoch: number) {
    this.epoch = epoch;
    this.probes.clear();
    this.samples = [];
    this.observedCount = 0;
    this.lower = [];
    this.lastActivity = null;
  }
  resetDecrease() { this.lower = []; }
  activity(now: number) {
    if (!Number.isFinite(now)) return;
    if (this.lastActivity !== null && now - this.lastActivity > 250) {
      for (const probe of this.probes.values()) probe.contaminated = true;
    }
    this.lastActivity = now;
  }
  observations(now: number): AdaptivePongSample[] {
    this.samples = this.samples.filter(s => now >= s.receivedAtClientMs && now - s.receivedAtClientMs <= SAMPLE_MAX_AGE_MS);
    return this.samples.map(s => ({ ...s }));
  }
  private expireProbes(now: number) {
    for (const [nonce, probe] of this.probes) if (now - probe.sent > 2000) this.probes.delete(nonce);
  }
  probe(now: number): string | null {
    if (!Number.isFinite(now)) return null;
    this.expireProbes(now);
    if (this.probes.size >= 4) return null;
    const nonce = `auto:${this.epoch}:${++this.nonce}`;
    this.probes.set(nonce, { sent: now, contaminated: false });
    return nonce;
  }
  get outstandingCount() { return this.probes.size; }
  cadence(now: number) { return selectCalibration(this.observations(now), now) ? 2000 : 500; }
  pong(nonce: string, serverPongMs: number, now: number, commitMs: number, activeMs: number): boolean {
    this.activity(now);
    const probe = this.probes.get(nonce);
    this.probes.delete(nonce);
    if (!probe || probe.contaminated || ![now, serverPongMs, probe.sent].every(Number.isFinite)) return false;
    const rttMs = now - probe.sent;
    const impliedOffsetMs = serverPongMs - (probe.sent + now) / 2;
    if (rttMs < 0 || rttMs > 2000 || !Number.isFinite(impliedOffsetMs)) return false;
    this.observations(now);
    this.samples.push({ connectionEpoch: this.epoch, sentAtClientMs: probe.sent, receivedAtClientMs: now,
      serverPongMs, rttMs, impliedOffsetMs });
    this.observedCount = Math.min(3, this.observedCount + 1);
    if (this.samples.length > 16) this.samples.shift();
    const proposal = this.proposal(now, commitMs);
    if (proposal && activeMs > 0 && (proposal.candidateMs <= activeMs - DECREASE_HYSTERESIS_MS
      || proposal.candidateMs === 0 && activeMs < DECREASE_HYSTERESIS_MS)) {
      this.lower.push(now);
      // Retain the first qualifying observation while requiring successive proposals.
      if (this.lower.length > 3) this.lower.splice(1, 1);
    } else this.lower = [];
    return true;
  }
  proposal(now: number, commitMs: number) { return proposeLead(this.observations(now), now, commitMs); }
  get fallbackReason() { return this.observedCount < 3 ? "fallback-unwarmed" as const : "fallback-stale" as const; }
  get decreaseConfirmed() { return this.lower.length >= 3 && this.lower[2] - this.lower[0] >= 4000; }
  decide(now: number, commitMs: number, previousMs: number): AdaptiveDecision {
    const proposal = this.proposal(now, commitMs);
    let appliedMs = proposal?.candidateMs ?? 0;
    let reason: AdaptiveDecision["reason"] = proposal ? (proposal.capped ? "capped" : "selected")
      : this.fallbackReason;
    if (proposal && appliedMs < previousMs) {
      if (proposal.ceilingMs < previousMs) { appliedMs = Math.min(previousMs, proposal.ceilingMs); reason = "ceiling-decrease";
        if (this.decreaseConfirmed) appliedMs = proposal.candidateMs;
      } else if (!this.decreaseConfirmed) { appliedMs = previousMs; reason = "decrease-held"; }
    }
    const decision: AdaptiveDecision = { at: now, roundOrdinal: ++this.ordinal, previousMs, appliedMs,
      offsetMs: proposal?.offsetMs ?? null, reason, proposal };
    this.history.push(decision);
    if (this.history.length > 32) this.history.shift();
    this.lower = [];
    return decision;
  }
  decisions() { return structuredClone(this.history); }
}
