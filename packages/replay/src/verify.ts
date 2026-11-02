import type { ClearStats, FinesseStats, GameState, SingleplayerReplayState, SprintResult } from "@42tris/core";
import { computeFinalStateDigest } from "./decode";
import { ReplayError } from "./errors";
import { SPRINT_MODE_ID, type Replay, type SoloReplay, type SprintReplay } from "./format";
import { SPRINT_TARGET, SprintDriver } from "./sprint-driver";

export interface SprintExecutionVerification {
  readonly replay: SprintReplay;
  readonly state: GameState;
  readonly modeState: SingleplayerReplayState;
  readonly result: SprintResult;
  readonly finalStateDigest: string;
}

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

export async function verifyReplayExecution(replay: Replay): Promise<SprintExecutionVerification> {
  if (isSprintReplay(replay)) return verifySprintReplayExecution(replay);
  if (replay.kind === "match") {
    throw new ReplayError("unsupported", "Match execution verification is reserved for R1-C");
  }
  throw new ReplayError("unsupported", "Only Sprint replay execution is supported");
}
