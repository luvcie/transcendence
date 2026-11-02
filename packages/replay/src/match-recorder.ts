/**
 * Reusable competitive Match replay recorder (M2-B1).
 *
 * Records a live authoritative Match set by intercepting every Match
 * operation through wrapper methods. Each wrapper calls the real Match method
 * and appends the exact operation to the journal upon success.
 *
 * The recorder never runs a second simulation. It observes the authoritative
 * outcome (e.g. the actual reached frame after an advance) and writes that
 * into the record.
 *
 * Practice-mode Match instances are rejected at construction.
 */

import { FRAME_MS, LEAGUE_LOCK } from "@42tris/core";
import { type Match, type MatchEvent, type MatchInput, type MatchState } from "@42tris/match";
import { computeFinalStateDigest, decodeReplayJson, encodeReplay, sealReplay } from "./decode";
import { ReplayError } from "./errors";
import {
  CURRENT_REPLAY_VERSIONS,
  MATCH_MODE_ID,
  MATCH_MODE_VERSION,
  type MatchReplay,
  type MatchRoundSummary,
  type UnsignedMatchReplay,
} from "./format";
import { resolveReplayLimits, type ReplayDecodeOptions, type ReplayLimits } from "./limits";
import type { MatchInitial, MatchOperation, MatchRecord } from "./match-driver";
import { isMatchReplay, verifyMatchReplayExecution } from "./verify";

// ────────────────────────────────────────────────────────────────────────────
// Public API types
// ────────────────────────────────────────────────────────────────────────────

export type MatchRecorderStatus =
  | "recording"   // actively accepting operations
  | "finalizing"  // sealing and verifying the artifact asynchronously
  | "complete"    // sealed, decoded, verified; replay is available
  | "failed"      // resource limit or verification error; no replay
  | "abandoned";  // abandoned before completion; no replay

export interface MatchRecorderOptions extends ReplayDecodeOptions {
  /** Stable replay identifier. Must be non-empty and within maxStringLength. */
  id?: string;
}

// ────────────────────────────────────────────────────────────────────────────
// Internal constants
// ────────────────────────────────────────────────────────────────────────────

/**
 * Conservative per-record byte estimate used to fail-fast before the full
 * JSON serialization step. Actual JSON is smaller; the reserve keeps us within
 * the hard limit even with envelope overhead.
 */
const ENVELOPE_RESERVE = 8192;
const RECORD_BYTES: Readonly<Record<MatchOperation["type"], number>> = Object.freeze({
  submit: 160,
  advance: 72,
  release: 56,
  forfeit: 80,
  nextRound: 56,
});

// ────────────────────────────────────────────────────────────────────────────
// MatchRecorder
// ────────────────────────────────────────────────────────────────────────────

/**
 * Competitive Match replay recorder.
 *
 * ### Practice rejection
 *
 * Construction throws `ReplayError("unsupported")` for any non-competitive
 * Match. This is a permanent product requirement: online practice rooms must
 * never create a recorder.
 *
 * ### Server integration boundary (M2-B2)
 *
 * Route every authoritative Match call through the corresponding recorder
 * method:
 *
 * | Current server call               | Route through recorder        |
 * |-----------------------------------|-------------------------------|
 * | `match.submit(input)`             | `recorder.submit(input)`      |
 * | `match.advanceToFrame(frame)`     | `recorder.advanceToFrame(frame)` |
 * | `match.releaseControls(id?)`      | `recorder.releaseControls(id?)` |
 * | `match.forfeit(id)`               | `recorder.forfeit(id)`        |
 * | `match.nextRound(seed)`           | `recorder.nextRound(seed)`    |
 * | `match.drainEvents()`             | `recorder.drainEvents()`      |
 *
 * Read-only Match accessors (`.frame`, `.round`, `.ended`, `.complete`,
 * `.roster`, `.scores`, `.seed`, `.width`, `.firstTo`, `.mode`,
 * `.activePlayers`, `.playerState()`, `.playerEpoch()`, `.saveState()`)
 * need no routing.
 *
 * Practice-only operations (`setAttacksEnabled`, `practiceUndo`,
 * `practiceReset`) are impossible in competitive mode and have no recorder
 * equivalent.
 *
 * ### Authoritative controller actions outside Match
 *
 * The following server actions occur outside Match and need no special
 * treatment in M2-B2:
 *
 * - Preparation / readiness / countdown phases produce no Match calls.
 * - Pause is represented by the `releaseControls` calls `invalidate()` makes.
 * - Round-result countdown produces no Match calls until `nextRound`.
 * - Batch forfeit (seat expiry) is already routed through `match.forfeit`;
 *   the server must route each one through `recorder.forfeit` instead.
 *
 * ### Avoiding double execution
 *
 * Never call the underlying Match method and then the recorder method for the
 * same operation. The recorder calls the real Match method internally. If the
 * server does both, the Match will receive a duplicate call and throw or
 * silently accept invalid state.
 */
export class MatchRecorder {
  readonly mode = "competitive" as const;

  /**
   * Resolves with the sealed, verified `MatchReplay` when the set completes
   * and finalization succeeds, or with `null` on failure or abandonment.
   */
  readonly completion: Promise<MatchReplay | null>;

  private readonly match: Match;
  private readonly initial: MatchInitial;
  private readonly id: string;
  private readonly limits: ReplayLimits;

  /** Ordered journal records. Cleared after finalization to free memory. */
  private readonly records: MatchRecord[] = [];

  /**
   * All Match events produced since the last call to `drainEvents()`.
   * Kept here so the server can drain via the recorder and the finalization
   * path can read the full event history.
   */
  private readonly pendingEvents: MatchEvent[] = [];

  /**
   * Accumulates every Match event for use during finalization. Unlike
   * `pendingEvents`, this is never cleared by `drainEvents()`.
   */
  private readonly allEvents: MatchEvent[] = [];

  private readonly resolveCompletion: (replay: MatchReplay | null) => void;

  private statusValue: MatchRecorderStatus = "recording";
  private failure: ReplayError | null = null;
  private finalization: Promise<MatchReplay | null> | null = null;
  private completed: MatchReplay | null = null;
  private completedJson: string | null = null;
  private estimatedBytes = 0;
  private totalAdvancedFrames = 0;

  /**
   * @param match    The live authoritative competitive Match at round 1 frame 0.
   * @param matchId  Stable replay identifier (e.g. a room match UUID).
   * @param options  Optional resource-limit overrides.
   *
   * @throws {ReplayError} code `"unsupported"` if `match.mode !== "competitive"`.
   * @throws {RangeError} if the Match is not at round 1 frame 0.
   */
  constructor(match: Match, matchId: string, options: MatchRecorderOptions = {}) {
    // ── Permanent product requirement: practice rooms never record ──────────
    if (match.mode !== "competitive") {
      throw new ReplayError(
        "unsupported",
        `Practice-mode Match cannot be recorded. ` +
        `Online practice rooms must never create a MatchRecorder.`,
      );
    }

    // The journal must start at the initial state.
    if (match.round !== 1 || match.frame !== 0) {
      throw new RangeError(
        "MatchRecorder requires a Match at round 1 frame 0; cannot record a mid-set Match.",
      );
    }

    this.limits = resolveReplayLimits(options);

    const id = options.id ?? matchId;
    if (typeof id !== "string" || id.length === 0 || id.length > this.limits.maxStringLength) {
      throw new RangeError("Invalid replay identifier");
    }

    this.match = match;
    this.id = id;

    // Snapshot the immutable initial configuration from the live Match.
    this.initial = {
      players: [...match.roster],
      width: match.width,
      seed: match.seed,
      firstTo: match.firstTo,
      handlingByPlayer: Object.fromEntries(
        match.roster.map(player => [player, { ...match.handlingByPlayer[player] }]),
      ),
      mode: "competitive",
      attacksEnabled: true,
      lockProfile: LEAGUE_LOCK,
    };

    let resolveCompletion!: (replay: MatchReplay | null) => void;
    this.completion = new Promise<MatchReplay | null>(resolve => {
      resolveCompletion = resolve;
    });
    this.resolveCompletion = resolveCompletion;
  }

  // ── Status and artifact accessors ────────────────────────────────────────

  get status(): MatchRecorderStatus { return this.statusValue; }
  get error(): ReplayError | null { return this.failure; }
  get replay(): MatchReplay | null { return this.completed; }
  get json(): string | null { return this.completedJson; }

  // ── Wrapped Match operations ─────────────────────────────────────────────

  /**
   * Calls `match.submit(input)`, then records the operation.
   * If Match throws, the record is not appended and the error propagates.
   */
  submit(input: Required<MatchInput>): MatchEvent[] {
    if (this.statusValue !== "recording") return [];
    const before = this.boundary();
    // Match.submit does not drain events; we drain after to capture any that
    // became available as a side effect of the input queue mutation.
    this.match.submit(input);
    const events = this.flushMatchEvents();
    this.record({ type: "submit", input: { ...input } }, before);
    // Submit does not end the round directly; no set-completion check needed.
    return events;
  }

  /**
   * Calls `match.advanceToFrame(toFrame)`, records the operation with the
   * actual reached frame, and checks for set completion.
   *
   * The recorded `reachedFrame` is the authoritative `match.frame` after the
   * call, which may be less than `toFrame` when the round ended early.
   */
  advanceToFrame(toFrame: number): MatchEvent[] {
    if (this.statusValue !== "recording") return [];
    const before = this.boundary();
    const frameBefore = this.match.frame;
    this.match.advanceToFrame(toFrame);
    const reachedFrame = this.match.frame;
    const advanced = reachedFrame - frameBefore;
    const events = this.flushMatchEvents();
    this.totalAdvancedFrames += advanced;
    if (this.totalAdvancedFrames > this.limits.maxMatchFrames) {
      this.fail(new ReplayError("resource-limit", "Match recording frame budget exceeded"));
      return events;
    }
    this.record({ type: "advance", toFrame, reachedFrame }, before);
    this.observeSetCompletion();
    return events;
  }

  /**
   * Calls `match.releaseControls(playerId?)` and records the operation.
   * Release never completes the set; no completion check.
   */
  releaseControls(playerId?: string): MatchEvent[] {
    if (this.statusValue !== "recording") return [];
    const before = this.boundary();
    this.match.releaseControls(playerId);
    const events = this.flushMatchEvents();
    const op: MatchOperation =
      playerId === undefined ? { type: "release" } : { type: "release", player: playerId };
    this.record(op, before);
    return events;
  }

  /**
   * Calls `match.forfeit(playerId)` and records the operation.
   * A forfeit may complete the set; completion is observed after recording.
   */
  forfeit(playerId: string): MatchEvent[] {
    if (this.statusValue !== "recording") return [];
    const before = this.boundary();
    this.match.forfeit(playerId);
    const events = this.flushMatchEvents();
    this.record({ type: "forfeit", player: playerId }, before);
    this.observeSetCompletion();
    return events;
  }

  /**
   * Calls `match.nextRound(seed)` and records the operation.
   * nextRound never completes the set.
   */
  nextRound(seed: number): MatchEvent[] {
    if (this.statusValue !== "recording") return [];
    const before = this.boundary();
    this.match.nextRound(seed);
    const events = this.flushMatchEvents();
    this.record({ type: "nextRound", seed }, before);
    return events;
  }

  /**
   * Returns events buffered since the last drain and clears the buffer.
   * The server must call this instead of `match.drainEvents()` directly.
   * The recorder calls `drainEvents()` internally after each Match operation.
   */
  drainEvents(): MatchEvent[] {
    const events = this.pendingEvents.slice();
    this.pendingEvents.length = 0;
    return events;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  /**
   * Abandons an unfinished recording. No-op for completed or finalizing
   * recorders. Safe to call multiple times.
   */
  abandon(): void {
    if (
      this.statusValue === "complete" ||
      this.statusValue === "finalizing" ||
      this.statusValue === "abandoned"
    ) return;
    const wasRecording = this.statusValue === "recording";
    this.statusValue = "abandoned";
    this.records.length = 0;
    this.pendingEvents.length = 0;
    this.allEvents.length = 0;
    if (wasRecording) this.resolveCompletion(null);
  }

  /**
   * Returns the finalization promise if a set completion was observed, or
   * resolves immediately with `null` for unfinished/abandoned/failed recorders.
   * Idempotent.
   */
  finish(): Promise<MatchReplay | null> {
    if (this.finalization) return this.finalization;
    return Promise.resolve(this.completed);
  }

  /**
   * Constructs and verifies a stopped/incomplete replay from the current
   * journal without requiring set completion. Returns null if no rounds have
   * been recorded, if the recorder is already complete or failed, or if
   * verification fails.
   *
   * The resulting replay has `status: "stopped"` and `complete: false`. Use
   * this when the room is closed or abandoned mid-set to produce a verifiable
   * prefix journal.
   *
   * This does not modify the recorder's status.
   */
  async buildIncompleteReplay(): Promise<MatchReplay | null> {
    if (this.statusValue === "complete") return this.completed;
    if (this.statusValue === "failed") return null;
    if (this.records.length === 0) return null;
    try {
      const state = this.match.saveState();
      const finalStateDigest = await computeFinalStateDigest(state);
      const payload = this.buildPayload(state, finalStateDigest, false);
      const sealed = await sealReplay(payload);
      const json = encodeReplay(sealed);
      if (new TextEncoder().encode(json).length > this.limits.maxBytes) return null;
      const decoded = await decodeReplayJson(json, this.limits);
      if (!isMatchReplay(decoded)) return null;
      const result = await verifyMatchReplayExecution(decoded);
      return result.complete ? null : decoded;
    } catch {
      return null;
    }
  }

  // ── Internal helpers ─────────────────────────────────────────────────────

  private boundary(): { round: number; frame: number } {
    return { round: this.match.round, frame: this.match.frame };
  }

  /** Drain events from the real Match and buffer them in both stores. */
  private flushMatchEvents(): MatchEvent[] {
    const events = this.match.drainEvents();
    this.pendingEvents.push(...events);
    this.allEvents.push(...events);
    return events;
  }

  private record(op: MatchOperation, before: { round: number; frame: number }): void {
    if (this.statusValue !== "recording") return;

    if (this.records.length + 1 > this.limits.maxOperations) {
      this.fail(new ReplayError("resource-limit", "Match recording operation limit exceeded"));
      return;
    }

    const nextBytes = this.estimatedBytes + RECORD_BYTES[op.type];
    const reserve = Math.min(ENVELOPE_RESERVE, Math.max(0, Math.floor(this.limits.maxBytes / 8)));
    if (nextBytes > this.limits.maxBytes - reserve) {
      this.fail(new ReplayError("resource-limit", "Match recording byte limit exceeded"));
      return;
    }

    this.estimatedBytes = nextBytes;
    this.records.push({
      seq: this.records.length,
      before: { round: before.round, frame: before.frame },
      op: copyOp(op),
    });
  }

  /**
   * Checks whether the set has completed after an operation. If so, captures
   * terminal state and begins async finalization.
   */
  private observeSetCompletion(): void {
    if (this.statusValue !== "recording") return;
    if (!this.match.complete) return;
    // Snapshot the terminal state before any caller can further mutate Match.
    const terminalState = this.match.saveState();
    this.statusValue = "finalizing";
    this.finalization = this.seal(terminalState);
  }

  private fail(error: ReplayError): void {
    if (
      this.statusValue === "failed" ||
      this.statusValue === "abandoned" ||
      this.statusValue === "complete"
    ) return;
    this.statusValue = "failed";
    this.failure = error;
    this.records.length = 0;
    this.pendingEvents.length = 0;
    this.allEvents.length = 0;
    this.resolveCompletion(null);
  }

  private buildPayload(
    state: MatchState,
    finalStateDigest: string,
    complete: boolean,
  ): UnsignedMatchReplay {
    return {
      versions: CURRENT_REPLAY_VERSIONS,
      id: this.id,
      kind: "match",
      mode: {
        id: MATCH_MODE_ID,
        version: MATCH_MODE_VERSION,
        config: { attacksEnabled: true, lockProfile: LEAGUE_LOCK },
      },
      initial: structuredClone(this.initial),
      records: this.records.map(r => ({
        seq: r.seq,
        before: { round: r.before.round, frame: r.before.frame },
        op: copyOp(r.op),
      })),
      end: {
        round: state.round,
        frame: state.frame,
        afterSeq: this.records.length - 1,
        status: complete ? "complete" : "stopped",
        reason: complete ? "set complete" : "stopped",
        finalStateDigest,
      },
      summary: buildSummary(state, this.allEvents),
    };
  }

  private async seal(terminalState: MatchState): Promise<MatchReplay | null> {
    try {
      const finalStateDigest = await computeFinalStateDigest(terminalState);
      const payload = this.buildPayload(terminalState, finalStateDigest, true);
      const sealed = await sealReplay(payload);
      const json = encodeReplay(sealed);

      if (new TextEncoder().encode(json).length > this.limits.maxBytes) {
        throw new ReplayError("resource-limit", "Match replay byte limit exceeded");
      }

      const decoded = await decodeReplayJson(json, this.limits);
      if (!isMatchReplay(decoded)) {
        throw new ReplayError("malformed", "Recorded journal is not a competitive Match replay");
      }

      await verifyMatchReplayExecution(decoded);

      this.completed = decoded;
      this.completedJson = json;
      this.statusValue = "complete";
      this.records.length = 0;
      this.pendingEvents.length = 0;
      this.allEvents.length = 0;
      this.resolveCompletion(decoded);
      return decoded;
    } catch (error) {
      const replayError =
        error instanceof ReplayError
          ? error
          : new ReplayError(
              "simulation-mismatch",
              error instanceof Error ? error.message : "Match replay finalization failed",
            );
      this.statusValue = "failed";
      this.failure = replayError;
      this.records.length = 0;
      this.pendingEvents.length = 0;
      this.allEvents.length = 0;
      this.resolveCompletion(null);
      return null;
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function copyOp(op: MatchOperation): MatchOperation {
  switch (op.type) {
    case "submit":
      return {
        type: "submit",
        input: {
          player: op.input.player,
          frame: op.input.frame,
          subframe: op.input.subframe,
          order: op.input.order,
          input: op.input.input,
          epoch: op.input.epoch,
        },
      };
    case "advance":
      return { type: "advance", toFrame: op.toFrame, reachedFrame: op.reachedFrame };
    case "release":
      return op.player === undefined
        ? { type: "release" }
        : { type: "release", player: op.player };
    case "forfeit":
      return { type: "forfeit", player: op.player };
    case "nextRound":
      return { type: "nextRound", seed: op.seed };
  }
}

type SetEndEvent = Extract<MatchEvent, { type: "setEnd" }>;
type RoundEndEvent = Extract<MatchEvent, { type: "roundEnd" }>;

function buildSummary(
  state: MatchState,
  events: readonly MatchEvent[],
): UnsignedMatchReplay["summary"] {
  const roundEnds: RoundEndEvent[] = [];
  let setEnd: SetEndEvent | null = null;

  for (const event of events) {
    if (event.type === "roundEnd") roundEnds.push(event as RoundEndEvent);
    else if (event.type === "setEnd") setEnd = event as SetEndEvent;
  }

  const rounds: MatchRoundSummary[] = roundEnds.map(event => ({
    round: event.round,
    frame: Math.round(event.atMs / FRAME_MS),
    winner: event.winner,
    complete: event.complete,
    reason: event.reason,
  }));

  const scores: Record<string, number> = {};
  for (const [index, player] of state.roster.entries()) {
    scores[player] = state.scores[index];
  }

  if (state.complete && setEnd !== null) {
    return { scores, winner: setEnd.winner, reason: setEnd.reason, rounds };
  }

  // Incomplete / stopped prefix.
  return { scores, winner: null, reason: "aborted", rounds };
}
