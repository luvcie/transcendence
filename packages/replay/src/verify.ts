import { FRAME_MS, LEAGUE_LOCK, type ClearStats, type FinesseStats, type GameState, type SingleplayerReplayState, type SprintResult } from "@42tris/core";
import { GARBAGE_PROFILE, MATCH_VERSION, type MatchEvent, type MatchState } from "@42tris/match";
import { computeFinalStateDigest } from "./decode";
import { ReplayError } from "./errors";
import {
  SPRINT_MODE_ID,
  type MatchReplay,
  type MatchRoundReason,
  type MatchSummaryReason,
  type Replay,
  type SoloReplay,
  type SprintReplay,
} from "./format";
import { MatchDriver, type MatchInitial } from "./match-driver";
import { SPRINT_TARGET, SprintDriver } from "./sprint-driver";

export interface SprintExecutionVerification {
  readonly replay: SprintReplay;
  readonly state: GameState;
  readonly modeState: SingleplayerReplayState;
  readonly result: SprintResult;
  readonly finalStateDigest: string;
}

export interface VerifiedMatchRound {
  readonly round: number;
  readonly frame: number;
  readonly winner: string | null;
  readonly complete: boolean;
  readonly reason: MatchRoundReason;
}

export interface MatchExecutionVerification {
  readonly replay: MatchReplay;
  readonly state: MatchState;
  readonly rounds: readonly VerifiedMatchRound[];
  readonly scores: Readonly<Record<string, number>>;
  readonly winner: string | null;
  readonly reason: MatchSummaryReason | null;
  readonly complete: boolean;
  readonly finalStateDigest: string;
}

type RoundEndEvent = Extract<MatchEvent, { type: "roundEnd" }>;
type SetEndEvent = Extract<MatchEvent, { type: "setEnd" }>;

function mismatch(message: string): never {
  throw new ReplayError("simulation-mismatch", message);
}

function sameStats(a: Readonly<ClearStats>, b: Readonly<ClearStats>): boolean {
  return a.pieces === b.pieces && a.lines === b.lines && a.combo === b.combo
    && a.chainLength === b.chainLength && a.b2b === b.b2b && a.surge === b.surge
    && a.attack === b.attack;
}

function sameFinesse(a: Readonly<FinesseStats>, b: Readonly<FinesseStats>): boolean {
  return a.evaluated === b.evaluated && a.faults === b.faults && a.points === b.points;
}

export function isSprintReplay(replay: Replay): replay is SprintReplay {
  return replay.kind === "solo" && replay.mode.id === SPRINT_MODE_ID;
}

export function isMatchReplay(replay: Replay): replay is MatchReplay {
  return replay.kind === "match";
}

/**
 * Executes a decoded Sprint journal, reconstructs its terminal state and checks every
 * claimed result field against the simulation. An execution failure never returns a
 * verification object.
 */
export async function verifySprintReplayExecution(replay: SoloReplay): Promise<SprintExecutionVerification> {
  if (!isSprintReplay(replay)) throw new ReplayError("unsupported", "Only Sprint replay execution is supported");

  const driver = new SprintDriver(replay.initial);
  try {
    for (const record of replay.records) driver.apply(record);
  } catch (error) {
    if (error instanceof ReplayError) throw error;
    mismatch(error instanceof Error ? error.message : "Sprint execution failed");
  }

  const result = driver.result;
  if (result === null) mismatch("Sprint journal did not reach a terminal result");
  const state = driver.state;
  const modeState = driver.modeState;
  const finalStateDigest = await computeFinalStateDigest(state, modeState);
  if (finalStateDigest !== replay.end.finalStateDigest) mismatch("Final state digest mismatch");

  const summary = replay.summary;
  if (summary.outcome !== result.outcome) mismatch("Sprint outcome mismatch");
  if (summary.elapsedMs !== result.elapsedMs) mismatch("Sprint completion time mismatch");
  if (!sameStats(summary.stats, result.stats)) mismatch("Sprint statistics mismatch");
  if (!sameFinesse(summary.finesse, result.finesse)) mismatch("Sprint finesse mismatch");
  if (summary.topOut !== state.state.topOut) mismatch("Sprint top-out mismatch");
  if (state.state.observedNow !== result.elapsedMs) mismatch("Sprint terminal observation mismatch");

  if (result.outcome === "complete") {
    if (replay.end.status !== "complete") mismatch("Completed Sprint requires complete replay status");
    if (result.stats.lines < SPRINT_TARGET) mismatch("Completed Sprint did not clear enough lines");
    const winning = state.lastResult;
    if (!winning || winning.stats.lines < SPRINT_TARGET) mismatch("Winning Sprint lock is missing");
    if (winning.atMs !== result.elapsedMs) mismatch("Winning Sprint lock timestamp mismatch");
  } else {
    if (replay.end.status !== "stopped") mismatch("Failed Sprint requires stopped replay status");
    if (!state.state.topOut) mismatch("Failed Sprint did not top out");
    if (result.stats.lines >= SPRINT_TARGET) mismatch("Failed Sprint reached the completion target");
  }

  return { replay, state, modeState, result, finalStateDigest };
}

function nonCompetitiveInitial(initial: unknown): boolean {
  if (initial === null || typeof initial !== "object" || Array.isArray(initial)) return false;
  const value = initial as Partial<MatchInitial>;
  return value.mode !== "competitive" || value.attacksEnabled !== true || value.lockProfile !== LEAGUE_LOCK;
}

/** A roundEnd timestamp is the completed-frame boundary that ended that round. */
function roundFrame(atMs: number): number {
  const frame = Math.round(atMs / FRAME_MS);
  if (!Number.isSafeInteger(frame) || frame < 0 || Math.abs(atMs - frame * FRAME_MS) > 1e-6) {
    mismatch("Round end is not aligned to a simulation frame boundary");
  }
  return frame;
}

function scoresOf(state: MatchState): Record<string, number> {
  const scores: Record<string, number> = {};
  for (const [index, player] of state.roster.entries()) scores[player] = state.scores[index];
  return scores;
}

function execute(replay: MatchReplay): { state: MatchState; events: MatchEvent[] } {
  let driver: MatchDriver;
  try {
    driver = new MatchDriver(replay.initial);
  } catch (error) {
    if (nonCompetitiveInitial(replay.initial)) {
      throw new ReplayError("unsupported", "Only competitive match replays can be executed");
    }
    throw new ReplayError("malformed", error instanceof Error ? error.message : "Invalid match initial state");
  }

  const events: MatchEvent[] = [];
  try {
    for (const record of replay.records) {
      events.push(...driver.apply(record));
      while (driver.hasPendingAdvance) events.push(...driver.advance());
    }
  } catch (error) {
    if (error instanceof ReplayError) throw error;
    mismatch(error instanceof Error ? error.message : "Match execution failed");
  }

  if (driver.hasPendingAdvance) mismatch("Match journal ended inside an outstanding advance");
  if (driver.afterSeq !== replay.end.afterSeq) mismatch("Match end cursor does not match the executed journal");
  return { state: driver.state, events };
}

/**
 * Reconstructs a competitive set from its journal through the authoritative Match
 * simulation, then checks the endpoint, round summaries, scores, winner, ending
 * reason and final-state digest. A truncated replay may verify as a prefix only when
 * it claims no terminal set result.
 */
export async function verifyMatchReplayExecution(replay: MatchReplay): Promise<MatchExecutionVerification> {
  if (replay.kind !== "match") throw new ReplayError("unsupported", "Only competitive Match replay execution is supported");

  const { state, events } = execute(replay);
  const initial = replay.initial;

  if (state.version !== MATCH_VERSION || state.garbageProfile !== GARBAGE_PROFILE) {
    mismatch("Match compatibility identifiers do not match the simulation");
  }
  if (state.mode !== "competitive") mismatch("Match replay executed in a noncompetitive mode");
  if (!state.attacksEnabled) mismatch("Competitive match replay has attacks disabled");
  if (state.roster.length !== initial.players.length
    || state.roster.some((player, index) => player !== initial.players[index])) {
    mismatch("Final roster does not match the replay initial state");
  }
  if (state.width !== initial.width) mismatch("Final board width does not match the replay initial state");
  if (state.firstTo !== initial.firstTo) mismatch("Final first-to setting does not match the replay initial state");
  if (state.round !== replay.end.round) mismatch("Final match round does not match the replay endpoint");
  if (state.frame !== replay.end.frame) mismatch("Final match frame does not match the replay endpoint");
  if (state.players.some(player => player.epoch !== state.round - 1)) {
    mismatch("Final player epoch is inconsistent with the round");
  }

  const roundEnds: RoundEndEvent[] = [];
  const setEnds: SetEndEvent[] = [];
  for (const event of events) {
    if (event.type === "roundEnd") roundEnds.push(event);
    else if (event.type === "setEnd") setEnds.push(event);
  }
  const rounds: VerifiedMatchRound[] = roundEnds.map(event => ({
    round: event.round,
    frame: roundFrame(event.atMs),
    winner: event.winner,
    complete: event.complete,
    reason: event.reason,
  }));
  for (let index = 0; index < rounds.length; index++) {
    if (rounds[index].round !== index + 1) mismatch("Round end events are not contiguous");
  }

  const summaryRounds = replay.summary.rounds;
  if (summaryRounds.length !== rounds.length) mismatch("Round summary count does not match the executed journal");
  for (let index = 0; index < rounds.length; index++) {
    const claimed = summaryRounds[index];
    const actual = rounds[index];
    if (claimed.round !== actual.round || claimed.frame !== actual.frame
      || claimed.winner !== actual.winner || claimed.complete !== actual.complete
      || claimed.reason !== undefined && claimed.reason !== actual.reason) {
      mismatch(`Round ${actual.round} summary does not match the executed journal`);
    }
  }
  const finalRound = rounds[rounds.length - 1];
  if (finalRound && finalRound.round === state.round && finalRound.frame !== state.frame) {
    mismatch("Final round summary frame does not match the replay endpoint");
  }

  const scores = scoresOf(state);
  for (const player of state.roster) {
    if (replay.summary.scores[player] !== scores[player]) mismatch("Final scores do not match the executed journal");
  }

  const setEnd = setEnds[setEnds.length - 1] ?? null;
  if (state.complete) {
    if (setEnd === null) mismatch("Completed set has no terminal setEnd event");
    if (setEnd.round !== state.round) mismatch("Terminal setEnd round does not match the final round");
    if (replay.end.status !== "complete") mismatch("Completed set requires complete replay status");
    if (replay.summary.reason !== setEnd.reason) mismatch("Match ending reason does not match the executed journal");
    if (replay.summary.winner !== setEnd.winner) mismatch("Match winner does not match the executed journal");

    const eligible = state.players
      .map((player, index) => ({ id: state.roster[index], withdrawn: player.withdrawn }))
      .filter(player => !player.withdrawn);
    if (setEnd.reason === "aborted") {
      if (setEnd.winner !== null) mismatch("Aborted set cannot have a winner");
      if (eligible.length !== 0) mismatch("Aborted set still has eligible players");
    } else if (setEnd.reason === "forfeit") {
      if (setEnd.winner === null || eligible.length !== 1 || eligible[0].id !== setEnd.winner) {
        mismatch("Forfeit set result does not match the remaining eligible player");
      }
    } else {
      if (setEnd.winner === null) mismatch("First-to set has no winner");
      if (scores[setEnd.winner] < state.firstTo) mismatch("First-to winner has not reached the target score");
      if (!finalRound || finalRound.round !== state.round
        || finalRound.winner !== setEnd.winner || !finalRound.complete) {
        mismatch("First-to set ending does not match the final round");
      }
    }
  } else {
    if (setEnd !== null) mismatch("Incomplete set has a terminal setEnd event");
    if (replay.end.status === "complete") mismatch("Incomplete set cannot have complete replay status");
    if (replay.summary.reason !== "aborted" || replay.summary.winner !== null) {
      mismatch("Incomplete set must be summarized as aborted with no winner");
    }
  }

  const finalStateDigest = await computeFinalStateDigest(state);
  if (finalStateDigest !== replay.end.finalStateDigest) mismatch("Final state digest does not match the executed journal");

  return {
    replay,
    state,
    rounds,
    scores,
    winner: setEnd?.winner ?? null,
    reason: setEnd?.reason ?? null,
    complete: state.complete,
    finalStateDigest,
  };
}

export async function verifyReplayExecution(
  replay: Replay,
): Promise<SprintExecutionVerification | MatchExecutionVerification> {
  if (isSprintReplay(replay)) return verifySprintReplayExecution(replay);
  if (isMatchReplay(replay)) return verifyMatchReplayExecution(replay);
  throw new ReplayError("unsupported", "Only Sprint and competitive Match replay execution is supported");
}
