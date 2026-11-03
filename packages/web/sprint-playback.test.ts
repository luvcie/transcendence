import { describe, expect, spyOn, test } from "bun:test";
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
    const result = structuredClone(recorder.result);
    for (const position of [0, playback.durationMs, 20, 0, playback.durationMs / 2]) playback.seek(position);
    playback.restart();
    playback.seek(playback.durationMs);
    expect(recorder.result).toEqual(result);
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
    playback.seek(0);
    expect(playback.positionMs).toBe(position);
    expect(playback.state).toEqual(state);
  });
});

test("Sprint shares interactive seek controls, status and playback actions with Match", async () => {
  const { mountReplayControls } = await import("./src/replay-controls");
  const { FakeDocument } = await import("./test-dom");
  const playback = await SprintPlayback.create(await recordTopOut());
  const document = new FakeDocument();
  Object.assign(document.querySelector("#replay-toggle"), { blur() {} });
  let resets = 0;
  const controls = mountReplayControls(document as unknown as Document, {
    playback: () => playback, resetClock: () => { resets++; }, exit: () => playback.dispose(),
  });
  controls.sync();
  const seek = document.querySelector("#replay-seek") as unknown as HTMLInputElement;
  expect(seek.hidden).toBe(false);
  expect(seek.max).toBe(String(playback.durationMs));
  expect(seek.step).toBe("any");
  expect(seek.value).toBe("0");
  expect(document.querySelector("#replay-state").textContent).toBe("Playing · 1×");
  document.querySelector("#replay-toggle").dispatchEvent(new Event("click"));
  expect(playback.playing).toBe(false);
  expect(document.querySelector("#replay-state").textContent).toBe("Paused · 1×");
  playback.advance(100_000); expect(playback.positionMs).toBe(0);
  document.querySelector("#replay-toggle").dispatchEvent(new Event("click"));
  expect(playback.playing).toBe(true);
  document.querySelector("#replay-speed").value = "2";
  document.querySelector("#replay-speed").dispatchEvent(new Event("change"));
  expect(playback.speed).toBe(2);
  playback.advance(10); controls.sync();
  expect(seek.value).toBe("20");
  playback.advance(playback.durationMs); controls.sync();
  expect(document.querySelector("#replay-toggle").textContent).toBe("Replay");
  expect(document.querySelector("#replay-state").textContent).toBe("Finished");
  expect(seek.value).toBe(seek.max);
  seek.value = "500"; seek.dispatchEvent(new Event("input")); controls.flushSeek();
  expect(playback.positionMs).toBe(500);
  expect(playback.playing).toBe(false);
  expect(document.querySelector("#replay-state").textContent).toBe("Paused · 2×");
  expect(seek.getAttribute("aria-valuetext")).toBe(document.querySelector("#replay-time").textContent);
  document.querySelector("#replay-restart").dispatchEvent(new Event("click"));
  expect(playback.positionMs).toBe(0);
  expect(seek.value).toBe("0");
  expect(playback.playing).toBe(true);
  expect(resets).toBe(5);
  document.querySelector("#replay-exit").dispatchEvent(new Event("click"));
  expect(playback.disposed).toBe(true);
  controls.dispose();
  document.querySelector("#replay-speed").value = "4";
  document.querySelector("#replay-speed").dispatchEvent(new Event("change"));
  expect(playback.speed).toBe(2);
});

describe("Sprint replay seeking", () => {
  function expectPosition(playback: SprintPlayback, replay: SprintReplay, position: number) {
    const expected = referenceAt(replay, position);
    expect(playback.positionMs).toBe(position);
    expect(playback.state).toEqual(expected.state);
    expect(playback.elapsedMs).toBe(expected.modeState.elapsed);
    expect(playback.started).toBe(expected.modeState.running);
    expect(playback.result).toEqual(expected.result);
  }

  test("fractional seeks just before completion do not round into the final operation", async () => {
    const replay = await recordTopOut(7, 1_000_000, 1_000_010);
    const playback = await SprintPlayback.create(replay);
    const beforeEnd = playback.durationMs - 1e-11;
    playback.seek(beforeEnd);
    expectPosition(playback, replay, beforeEnd);
    expect(playback.complete).toBe(false);
    expect(playback.playing).toBe(true);
    expect(playback.result).toBeNull();
    playback.seek(playback.durationMs);
    expect(playback.complete).toBe(true);
    expect(playback.playing).toBe(false);
    playback.seek(beforeEnd);
    expectPosition(playback, replay, beforeEnd);
    expect(playback.complete).toBe(false);
    expect(playback.result).toBeNull();
    playback.play(); playback.advance(1);
    expectPosition(playback, replay, playback.durationMs);
    expect(playback.complete).toBe(true);
    expect(playback.playing).toBe(false);
  });

  test("forward and backward seeks preserve equal-time input ordering and fractional positions", async () => {
    const replay = await equalTimesReplay();
    const original = JSON.stringify(replay);
    const playback = await SprintPlayback.create(replay);
    for (const position of [1000, 499.999, 500, 999.999, 1000.001, 0, 750.5]) {
      playback.seek(position);
      expectPosition(playback, replay, position);
      expect(playback.playing).toBe(true);
    }
    expect(JSON.stringify(replay)).toBe(original);
  });

  test("seeks reconstruct hold, previews, held movement, handling changes and locked pieces", async () => {
    const recorder = new SprintRecorder(13, 100, handling);
    recorder.tick(150);
    recorder.apply(Input.Hold, 200);
    recorder.apply(Input.RightDown, 200);
    recorder.tick(240);
    recorder.apply(Input.RightUp, 250);
    recorder.setHandling({ ...handling, das: 1 }, 260);
    recorder.apply(Input.RotateCw, 270);
    recorder.apply(Input.HardDrop, 280);
    let now = 280;
    while (!recorder.result && now < 5000) recorder.apply(Input.HardDrop, now += 20);
    expect(recorder.result).not.toBeNull();
    const replay = await finished(recorder);
    const playback = await SprintPlayback.create(replay, { paused: true });
    for (const position of [180, 100, 99, 140, 160, 170, 180, 0, 150]) {
      playback.seek(position);
      expectPosition(playback, replay, position);
      expect(playback.playing).toBe(false);
    }
    playback.seek(100);
    expect(playback.state.state.held).not.toBeNull();
    expect(playback.state.state.rightHeld).toBe(true);
    playback.seek(180);
    expect(playback.state.lastResult?.stats.pieces).toBe(1);
  });

  test("seeking across line clears restores statistics, finesse and the terminal success state", async () => {
    const replay = await completionReplay();
    const playback = await SprintPlayback.create(replay);
    const driver = new SprintDriver(replay.initial);
    const positions: number[] = [];
    let lines = 0;
    for (const record of replay.records) {
      driver.apply(record);
      const nextLines = driver.state.lastResult?.stats.lines ?? 0;
      if (nextLines > lines && (positions.length < 3 || nextLines >= 40)) {
        positions.push(recordAt(record) - recordAt(replay.records[0]!));
      }
      lines = nextLines;
    }
    expect(positions.length).toBeGreaterThan(3);
    for (const position of [...positions, ...positions.toReversed()]) {
      playback.seek(position - 0.001);
      expectPosition(playback, replay, position - 0.001);
      playback.seek(position);
      expectPosition(playback, replay, position);
    }
    expect(playback.state.lastResult!.stats.lines).toBeGreaterThanOrEqual(1);
    playback.seek(playback.durationMs);
    expect(playback.result?.outcome).toBe("complete");
    expect(playback.result?.stats).toEqual(replay.summary.stats);
    expect(playback.result?.finesse).toEqual(replay.summary.finesse);
  });

  for (const [outcome, fixture] of [["complete", completionReplay], ["failed", topOutReplay]] as const) {
    test(`beginning/end seeking, restart and continuation do not drift for a ${outcome} replay`, async () => {
      const replay = await fixture();
      const original = JSON.stringify(replay);
      const playback = await SprintPlayback.create(replay);
      for (let repeat = 0; repeat < 3; repeat++) {
        playback.seek(playback.durationMs);
        expectPosition(playback, replay, playback.durationMs);
        expect(playback.complete).toBe(true);
        expect(playback.playing).toBe(false);
        expect(playback.result?.outcome).toBe(outcome);
        playback.seek(0);
        expectPosition(playback, replay, 0);
        expect(playback.complete).toBe(false);
        expect(playback.playing).toBe(false);
        playback.play();
        playback.seek(playback.durationMs / 2);
        expect(playback.playing).toBe(true);
        playback.advance(1_000_000);
        expectPosition(playback, replay, playback.durationMs);
        playback.restart();
        expect(playback.playing).toBe(true);
        expectPosition(playback, replay, 0);
      }
      expect(JSON.stringify(replay)).toBe(original);
    });
  }

  test("pause and speed remain independent of seeks and resumed playback applies only remaining journal operations", async () => {
    const replay = await timedTopOutReplay();
    const playback = await SprintPlayback.create(replay);
    playback.seek(3500);
    expect(playback.elapsedMs).toBe(500);
    playback.pause(); playback.setSpeed(2);
    playback.seek(2999);
    expect(playback.elapsedMs).toBe(0);
    expect(playback.started).toBe(false);
    playback.advance(100_000);
    expectPosition(playback, replay, 2999);
    playback.seek(3000);
    expect(playback.started).toBe(true);
    expect(playback.playing).toBe(false);
    playback.play(); playback.advance(250);
    expectPosition(playback, replay, 3500);
    expect(playback.speed).toBe(2);
  });

  test("invalid positions leave state intact and seeks within an unchanged journal prefix do no reconstruction", async () => {
    const replay = await equalTimesReplay();
    const playback = await SprintPlayback.create(replay);
    playback.seek(750);
    const state = playback.state;
    for (const position of [-1, NaN, Infinity, -Infinity, playback.durationMs + 0.001]) {
      expect(() => playback.seek(position)).toThrow(RangeError);
      expect(playback.positionMs).toBe(750);
      expect(playback.state).toEqual(state);
    }
    const apply = spyOn(SprintDriver.prototype, "apply");
    try {
      playback.seek(600);
      playback.seek(600);
      playback.advance(1);
      expect(apply).not.toHaveBeenCalled();
      playback.seek(499);
      expect(apply).toHaveBeenCalled();
      expectPosition(playback, replay, 499);
    } finally { apply.mockRestore(); }
  });
});

test("rapid Sprint slider input coalesces on the app frame and resets presentation time before resuming", async () => {
  const { mountReplayControls } = await import("./src/replay-controls");
  const { FakeDocument } = await import("./test-dom");
  const replay = await equalTimesReplay();
  const playback = await SprintPlayback.create(replay);
  const document = new FakeDocument();
  Object.assign(document.querySelector("#replay-toggle"), { blur() {} });
  let lastFrameAt: number | null = 0;
  const controls = mountReplayControls(document as unknown as Document, {
    playback: () => playback, resetClock: () => { lastFrameAt = null; }, exit() {},
  });
  const seek = document.querySelector("#replay-seek");
  const frame = (now: number) => {
    controls.flushSeek();
    const delta = lastFrameAt === null ? 0 : now - lastFrameAt;
    lastFrameAt = now;
    playback.advance(delta); controls.sync();
  };
  const change = (value: number) => { seek.value = String(value); seek.dispatchEvent(new Event("input")); };
  const request = spyOn(playback, "seek");
  try {
    for (let i = 0; i < 100; i++) change(1000 - i * 2);
    controls.sync();
    expect(seek.value).toBe("802");
    expect(request).not.toHaveBeenCalled();
    frame(90_000);
    expect(request).toHaveBeenCalledTimes(1);
    expect(playback.positionMs).toBe(802);
    expect(playback.state).toEqual(referenceAt(replay, 802).state);
    frame(90_001);
    expect(playback.positionMs).toBe(803);
    document.querySelector("#replay-toggle").dispatchEvent(new Event("click"));
    change(500); seek.dispatchEvent(new Event("change"));
    expect(playback.positionMs).toBe(500);
    frame(180_000);
    expect(playback.positionMs).toBe(500);
    document.querySelector("#replay-toggle").dispatchEvent(new Event("click"));
    frame(270_000); expect(playback.positionMs).toBe(500);
    frame(270_016); expect(playback.positionMs).toBe(516);
    expect(playback.state).toEqual(referenceAt(replay, 516).state);
    change(0);
    controls.dispose(); controls.flushSeek();
    expect(playback.positionMs).toBe(516);
  } finally { controls.dispose(); request.mockRestore(); playback.dispose(); }
});

test("pending slider requests settle before pause/speed changes and cannot survive restart or navigation", async () => {
  const { mountReplayControls } = await import("./src/replay-controls");
  const { FakeDocument } = await import("./test-dom");
  const playback = await SprintPlayback.create(await equalTimesReplay());
  const document = new FakeDocument();
  Object.assign(document.querySelector("#replay-toggle"), { blur() {} });
  let current: SprintPlayback | null = playback;
  const controls = mountReplayControls(document as unknown as Document, {
    playback: () => current, resetClock() {}, exit() { current?.dispose(); current = null; },
  });
  const queue = (position: number) => {
    const slider = document.querySelector("#replay-seek");
    slider.value = String(position); slider.dispatchEvent(new Event("input"));
  };
  queue(500);
  document.querySelector("#replay-speed").value = "4";
  document.querySelector("#replay-speed").dispatchEvent(new Event("change"));
  expect(playback.positionMs).toBe(500); expect(playback.speed).toBe(4);
  queue(750);
  document.querySelector("#replay-toggle").dispatchEvent(new Event("click"));
  expect(playback.positionMs).toBe(750); expect(playback.playing).toBe(false);
  queue(1000);
  document.querySelector("#replay-restart").dispatchEvent(new Event("click"));
  controls.flushSeek();
  expect(playback.positionMs).toBe(0); expect(playback.playing).toBe(true);
  queue(1000);
  document.querySelector("#replay-exit").dispatchEvent(new Event("click"));
  controls.flushSeek();
  expect(playback.positionMs).toBe(0); expect(playback.disposed).toBe(true);
  current = await SprintPlayback.create(await topOutReplay());
  queue(500);
  const reopened = await SprintPlayback.create(await equalTimesReplay());
  current.dispose(); current = reopened;
  controls.flushSeek();
  expect(reopened.positionMs).toBe(0);
  controls.dispose(); reopened.dispose();
});

test("zero-duration Sprint recordings stay complete when seeking or restarting", async () => {
  const recorder = new SprintRecorder(7, 100, handling);
  for (let count = 0; count < 100 && !recorder.result; count++) recorder.apply(Input.HardDrop, 100);
  expect(recorder.result?.outcome).toBe("failed");
  const replay = await finished(recorder);
  const playback = await SprintPlayback.create(replay);
  expect(playback.durationMs).toBe(0);
  const state = playback.state;
  playback.seek(0); playback.restart(); playback.seek(0);
  expect(playback.complete).toBe(true);
  expect(playback.playing).toBe(false);
  expect(playback.state).toEqual(state);
  expect(playback.result?.outcome).toBe("failed");
});
