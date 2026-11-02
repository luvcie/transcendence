import { describe, expect, test } from "bun:test";
import {
  DEFAULT_HANDLING,
  Input,
  MINOS,
  ROWS,
  canPlace,
  clearRows,
  place,
  type Game,
  type Handling,
  type InputId,
} from "@42tris/core";
import {
  ReplayError,
  SprintDriver,
  SprintRecorder,
  verifySprintReplayExecution,
  type SoloRecord,
  type SprintReplay,
} from "@42tris/replay";
import { PLAYBACK_SPEEDS, SprintPlayback } from "./src/sprint-playback";
import { lastSprintRecording, sprintRecordingFor, startSprintRecording } from "./src/sprint-recording";

const handling: Handling = { ...DEFAULT_HANDLING, arr: 0, sdarr: 0 };

interface Candidate { rot: number; x: number; score: number }

function candidates(game: Game): Candidate[] {
  const width = game.width;
  const result: Candidate[] = [];
  const shapes = new Set<string>();
  for (let rot = 0; rot < 4; rot++) {
    const shape = Array.from(MINOS[game.piece][rot]).join(",");
    if (shapes.has(shape)) continue;
    shapes.add(shape);
    for (let x = -3; x < width; x++) {
      if (!canPlace(game.board, game.piece, rot, x, 18)) continue;
      let y = 18;
      while (canPlace(game.board, game.piece, rot, x, y + 1)) y++;
      const board = game.board.slice();
      place(board, game.piece, rot, x, y);
      const { rows } = clearRows(board);
      let holes = 0;
      let aggregate = 0;
      let bumpiness = 0;
      const heights: number[] = [];
      for (let xx = 0; xx < width; xx++) {
        let height = 0;
        let seen = false;
        for (let yy = 0; yy < ROWS; yy++) {
          if (board[yy * width + xx] !== 0) {
            if (!seen) { height = ROWS - yy; seen = true; }
          } else if (seen) holes++;
        }
        heights.push(height);
        aggregate += height;
      }
      for (let i = 1; i < width; i++) bumpiness += Math.abs(heights[i] - heights[i - 1]);
      const score = rows.length * 10000 - holes * 500 - aggregate * 5 - bumpiness * 10
        - Math.max(...heights) * 20;
      result.push({ rot, x, score });
    }
  }
  return result.sort((a, b) => b.score - a.score || a.x - b.x || a.rot - b.rot);
}

function recordAt(record: SoloRecord): number {
  return record.op.type === "handling" ? record.op.observedAtMs : record.op.atMs;
}

/** Reference reconstruction that applies the same journal up to a recorded offset. */
function referenceAt(replay: SprintReplay, positionMs: number) {
  const origin = recordAt(replay.records[0]!);
  const driver = new SprintDriver(replay.initial);
  for (const record of replay.records) {
    if (recordAt(record) - origin > positionMs) break;
    driver.apply(record);
  }
  return { state: driver.state, modeState: driver.modeState, result: driver.result };
}

async function finished(recorder: SprintRecorder): Promise<SprintReplay> {
  const replay = await recorder.finish();
  if (!replay) throw new Error(recorder.error?.message ?? "Recording fixture failed");
  return replay;
}

async function recordTopOut(seed = 7, start = 100, firstInput = 1010): Promise<SprintReplay> {
  const recorder = new SprintRecorder(seed, start, handling);
  let now = firstInput - 10;
  let guard = 0;
  while (recorder.result === null && guard++ < 100) {
    now += 10;
    recorder.apply(Input.HardDrop, now);
  }
  if (!recorder.result) throw new Error("Top-out fixture did not finish");
  return finished(recorder);
}

async function recordCompletion(seed = 1, start = 1000, firstInput = 5001): Promise<SprintReplay> {
  const recorder = new SprintRecorder(seed, start, handling);
  let now = firstInput - 1.5;
  const send = (input: InputId) => {
    now += 1;
    recorder.apply(input, now);
  };
  let guard = 0;
  while (recorder.result === null && guard++ < 1000) {
    const target = candidates(recorder.game)[0];
    if (!target) break;
    now += 0.5;
    recorder.tick(now);
    let rotations = 0;
    while (recorder.game.rot !== target.rot && rotations++ < 4) send(Input.RotateCw);
    let moves = 0;
    while (recorder.game.x !== target.x && moves++ < 20) {
      if (target.x > recorder.game.x) {
        send(Input.RightDown);
        send(Input.RightUp);
      } else {
        send(Input.LeftDown);
        send(Input.LeftUp);
      }
    }
    send(Input.HardDrop);
  }
  if (!recorder.result) throw new Error("Completion fixture did not finish");
  return finished(recorder);
}

/** Ticks, releases and rotations before the first gameplay press. */
async function recordTimedTopOut(): Promise<SprintReplay> {
  const recorder = new SprintRecorder(9, 1000, handling);
  recorder.tick(1500);
  recorder.apply(Input.LeftUp, 1800);
  recorder.tick(2500);
  recorder.apply(Input.SoftDropUp, 3000);
  recorder.apply(Input.RotateCw, 4000);
  recorder.tick(4500);
  let now = 4500;
  let guard = 0;
  while (recorder.result === null && guard++ < 100) {
    now += 10;
    recorder.apply(Input.HardDrop, now);
  }
  if (!recorder.result) throw new Error("Timed top-out fixture did not finish");
  return finished(recorder);
}

/** A tick and an input share a timestamp, as do two different inputs. */
async function recordEqualTimes(): Promise<SprintReplay> {
  const recorder = new SprintRecorder(5, 1000, handling);
  recorder.tick(1500);
  recorder.apply(Input.RotateCw, 1500);
  recorder.apply(Input.RightDown, 2000);
  recorder.apply(Input.HardDrop, 2000);
  let now = 2000;
  let guard = 0;
  while (recorder.result === null && guard++ < 100) {
    now += 10;
    recorder.apply(Input.HardDrop, now);
  }
  if (!recorder.result) throw new Error("Equal-time fixture did not finish");
  return finished(recorder);
}

const cached = new Map<string, Promise<SprintReplay>>();
function cachedReplay(key: string, create: () => Promise<SprintReplay>): Promise<SprintReplay> {
  let value = cached.get(key);
  if (!value) {
    value = create();
    cached.set(key, value);
  }
  return value;
}
const topOutReplay = () => cachedReplay("top-out", () => recordTopOut());
const completionReplay = () => cachedReplay("completion", () => recordCompletion());
const timedTopOutReplay = () => cachedReplay("timed-top-out", () => recordTimedTopOut());
const equalTimesReplay = () => cachedReplay("equal-times", () => recordEqualTimes());

async function expectReplayError(promise: Promise<unknown>, code: ReplayError["code"]): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ReplayError);
    expect((error as ReplayError).code).toBe(code);
    return;
  }
  throw new Error(`Expected ReplayError ${code}`);
}

describe("Sprint replay playback", () => {
  test("watches a completed attempt from the initial state to the verified final board", async () => {
    const replay = await completionReplay();
    const verification = await verifySprintReplayExecution(replay);
    const playback = await SprintPlayback.create(replay);
    expect(playback.positionMs).toBe(0);
    expect(playback.complete).toBe(false);
    expect(playback.playing).toBe(true);
    expect(playback.elapsedMs).toBe(0);
    expect(playback.started).toBe(false);
    expect(playback.state.state.topOut).toBe(false);
    expect(playback.state).toEqual(referenceAt(replay, 0).state);

    let frames = 0;
    while (!playback.complete && frames++ < 2000) playback.advance(16);
    expect(frames).toBeLessThan(2000);
    expect(playback.complete).toBe(true);
    expect(playback.playing).toBe(false);
    expect(playback.positionMs).toBe(playback.durationMs);
    expect(playback.state).toEqual(verification.state);
    expect(playback.result).toEqual(verification.result);
    expect(playback.elapsedMs).toBe(verification.result.elapsedMs);
    expect(playback.outcome).toBe("complete");
  });

  test("intermediate states depend on recorded time only, not frame chunking", async () => {
    const replay = await equalTimesReplay();
    const coarse = await SprintPlayback.create(replay);
    const fine = await SprintPlayback.create(replay);
    coarse.advance(250);
    coarse.advance(250);
    coarse.advance(250);
    for (let i = 0; i < 150; i++) fine.advance(5);
    expect(coarse.positionMs).toBe(750);
    expect(fine.positionMs).toBe(750);
    expect(fine.state).toEqual(coarse.state);
    expect(fine.elapsedMs).toBe(coarse.elapsedMs);
    expect(coarse.state).toEqual(referenceAt(replay, 750).state);
  });

  test("operations that share a timestamp apply in journal order at the same cursor step", async () => {
    const replay = await equalTimesReplay();
    const playback = await SprintPlayback.create(replay);
    expect(playback.state.state.rot).toBe(0);
    playback.advance(499);
    expect(playback.state.state.rot).toBe(0);
    expect(playback.state.lastResult).toBeNull();
    playback.advance(1);
    expect(playback.state.state.rot).toBe(1);
    expect(playback.state).toEqual(referenceAt(replay, 500).state);
    playback.advance(500);
    expect(playback.state.lastResult?.stats.pieces).toBe(1);
    expect(playback.state).toEqual(referenceAt(replay, 1000).state);
  });

  test("the Sprint timer stays at zero until the first gameplay input and excludes pre-input time", async () => {
    const replay = await timedTopOutReplay();
    const playback = await SprintPlayback.create(replay);
    expect(playback.elapsedMs).toBe(0);
    expect(playback.started).toBe(false);
    playback.advance(2999);
    expect(playback.elapsedMs).toBe(0);
    expect(playback.started).toBe(false);
    playback.advance(501);
    expect(playback.positionMs).toBe(3500);
    expect(playback.started).toBe(true);
    expect(playback.elapsedMs).toBe(500);
    expect(playback.state).toEqual(referenceAt(replay, 3500).state);

    while (!playback.complete) playback.advance(1000);
    expect(playback.result?.elapsedMs).toBe(replay.summary.elapsedMs);
    expect(playback.result?.elapsedMs).toBeLessThan(playback.durationMs);
  });

  test("pause freezes the cursor and state; resume continues without timeline drift", async () => {
    const replay = await topOutReplay();
    const paused = await SprintPlayback.create(replay);
    const straight = await SprintPlayback.create(replay);
    paused.advance(100);
    const frozen = paused.state;
    paused.pause();
    expect(paused.playing).toBe(false);
    paused.advance(5000);
    expect(paused.positionMs).toBe(100);
    expect(paused.state).toEqual(frozen);
    paused.play();
    paused.advance(50);

    straight.advance(100);
    straight.advance(50);
    expect(paused.positionMs).toBe(straight.positionMs);
    expect(paused.state).toEqual(straight.state);
    expect(paused.elapsedMs).toBe(straight.elapsedMs);
  });

  test("restart rebuilds the initial replay state and plays again", async () => {
    const replay = await topOutReplay();
    const playback = await SprintPlayback.create(replay);
    const initial = playback.state;
    playback.advance(1000);
    expect(playback.positionMs).toBe(1000);
    expect(playback.state).not.toEqual(initial);
    playback.pause();
    playback.restart();
    expect(playback.positionMs).toBe(0);
    expect(playback.complete).toBe(false);
    expect(playback.playing).toBe(true);
    expect(playback.state).toEqual(initial);
    expect(playback.elapsedMs).toBe(0);
  });

  test("playback speed scales presentation time without changing reconstructed states", async () => {
    const replay = await topOutReplay();
    expect([...PLAYBACK_SPEEDS]).toEqual([0.5, 1, 2, 4]);

    const normal = await SprintPlayback.create(replay);
    normal.advance(100);
    expect(normal.positionMs).toBe(100);
    const doubled = await SprintPlayback.create(replay, { speed: 2 });
    doubled.advance(100);
    expect(doubled.positionMs).toBe(200);
    const half = await SprintPlayback.create(replay, { speed: 0.5 });
    half.advance(100);
    expect(half.positionMs).toBe(50);
    const fast = await SprintPlayback.create(replay, { speed: 4 });
    fast.advance(100);
    expect(fast.positionMs).toBe(400);

    normal.setSpeed(2);
    normal.advance(50);
    expect(normal.positionMs).toBe(200);
    expect(() => normal.setSpeed(3)).toThrow(RangeError);

    const byOne = await SprintPlayback.create(replay);
    byOne.advance(1_000_000);
    const byFour = await SprintPlayback.create(replay, { speed: 4 });
    byFour.advance(250_000);
    expect(byFour.complete).toBe(true);
    expect(byOne.complete).toBe(true);
    expect(byFour.state).toEqual(byOne.state);
    expect(byFour.result).toEqual(byOne.result);
  });

  test("a top-out replay ends on the failed terminal board and stops", async () => {
    const replay = await topOutReplay();
    const verification = await verifySprintReplayExecution(replay);
    const playback = await SprintPlayback.create(replay);
    while (!playback.complete) playback.advance(1000);
    expect(playback.outcome).toBe("failed");
    expect(playback.result?.outcome).toBe("failed");
    expect(playback.state.state.topOut).toBe(true);
    expect(playback.state).toEqual(verification.state);
    expect(playback.elapsedMs).toBe(verification.result.elapsedMs);
    expect(playback.playing).toBe(false);
  });

  test("rejects unsupported, malformed and unverified replay data", async () => {
    const replay = await topOutReplay();
    const zen = {
      ...replay,
      mode: { id: "42tris-local", version: 1, config: { zen: false } },
    } as unknown as SprintReplay;
    await expectReplayError(SprintPlayback.create(zen), "unsupported");
    await expectReplayError(SprintPlayback.create({ ...replay, records: [] } as SprintReplay), "malformed");
    await expectReplayError(SprintPlayback.create({ ...replay, end: { ...replay.end, afterSeq: 0 } } as SprintReplay), "malformed");

    const tampered = structuredClone(replay);
    tampered.summary.stats.lines += 1;
    await expectReplayError(SprintPlayback.create(tampered), "simulation-mismatch");
  });

  test("playback neither records nor mutates the stored Sprint recording", async () => {
    const recorder = startSprintRecording(41, 100, handling);
    let now = 100;
    while (recorder.result === null && now < 5000) {
      now += 10;
      recorder.apply(Input.HardDrop, now);
    }
    expect(recorder.result?.outcome).toBe("failed");
    const replay = await recorder.finish();
    await recorder.completion;
    const recording = sprintRecordingFor(recorder);
    expect(recording?.replay).toBe(replay);
    expect(recording).toBe(lastSprintRecording());
    const stored = JSON.stringify(recording!.replay);
    const json = recording!.json;

    const playback = await SprintPlayback.create(recording!.replay);
    playback.advance(1_000_000);
    expect(playback.complete).toBe(true);
    expect(recorder.status).toBe("complete");
    expect(recorder.error).toBeNull();
    expect(recorder.json).toBe(json);
    expect(sprintRecordingFor(recorder)).toBe(recording);
    expect(lastSprintRecording()).toBe(recording);
    expect(JSON.stringify(recording!.replay)).toBe(stored);
  });

  test("dispose stops playback and prevents further simulated movement", async () => {
    const replay = await topOutReplay();
    const playback = await SprintPlayback.create(replay);
    playback.advance(300);
    const state = playback.state;
    const position = playback.positionMs;
    playback.dispose();
    expect(playback.disposed).toBe(true);
    expect(playback.playing).toBe(false);
    playback.advance(5000);
    expect(playback.positionMs).toBe(position);
    expect(playback.state).toEqual(state);
    playback.play();
    expect(playback.playing).toBe(false);
    playback.restart();
    expect(playback.positionMs).toBe(position);
  });
});
