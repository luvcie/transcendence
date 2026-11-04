import { describe, expect, test } from "bun:test";
import {
  DEFAULT_HANDLING,
  FRAME_MS,
  Input,
  MINOS,
  ROWS,
  canPlace,
  clearRows,
  place,
  Game,
  type GameState,
  type Handling,
  type InputId,
  type SingleplayerReplayState,
  type SprintResult,
} from "@42tris/core";
import {
  SPRINT_TARGET,
  SprintRecorder,
  decodeReplayJson,
  verifySprintReplayExecution,
  type SprintReplay,
} from "./index";

const handling: Handling = { ...DEFAULT_HANDLING, arr: 0, sdarr: 0 };
const changedHandling: Handling = { das: 12, arr: 1, sddas: 1, sdarr: 1 };

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

function winningAt(state: GameState): number {
  if (!state.lastResult) throw new Error("Expected a winning lock");
  return state.lastResult.atMs;
}

interface LiveSnapshot {
  readonly state: GameState;
  readonly modeState: SingleplayerReplayState;
  readonly result: SprintResult;
}

function snapshot(recorder: SprintRecorder): LiveSnapshot {
  if (!recorder.result) throw new Error("Recording has not finished");
  return {
    state: recorder.game.saveState(),
    modeState: recorder.replayState(),
    result: recorder.result,
  };
}

async function completed(recorder: SprintRecorder): Promise<{
  replay: SprintReplay;
  json: string;
  live: LiveSnapshot;
}> {
  const live = snapshot(recorder);
  const replay = await recorder.finish();
  if (!replay) throw new Error(`Recording failed: ${recorder.error?.message ?? "unknown"}`);
  const json = recorder.json;
  if (!json) throw new Error("Completed recording has no JSON");
  const decoded = await decodeReplayJson(json);
  expect(decoded).toEqual(replay);
  const verification = await verifySprintReplayExecution(decoded);
  expect(verification.state).toEqual(live.state);
  expect(verification.modeState).toEqual(live.modeState);
  expect(verification.result).toEqual(live.result);
  return { replay, json, live };
}

async function recordCompletion(recorder: SprintRecorder, firstInput: number, step: number,
  prelude = false, handlingChangeAt?: number): Promise<void> {
  if (prelude) {
    recorder.tick(1500);
    recorder.apply(Input.LeftUp, 1800);
    recorder.tick(2500);
    recorder.apply(Input.SoftDropUp, 3000);
    recorder.tick(4000);
    recorder.apply(Input.RightUp, 4500);
  }

  let now = firstInput - step * 1.5;
  let changed = false;
  const send = (input: InputId) => {
    now += step;
    recorder.apply(input, now);
  };

  let guard = 0;
  while (recorder.result === null && guard++ < 1000) {
    if (handlingChangeAt !== undefined && !changed && now + step >= handlingChangeAt) {
      now = handlingChangeAt;
      recorder.setHandling(changedHandling, now);
      changed = true;
      continue;
    }
    const target = candidates(recorder.game)[0];
    if (!target) break;
    now += step / 2;
    recorder.tick(now);
    let rotationGuard = 0;
    while (recorder.game.rot !== target.rot && rotationGuard++ < 4) send(Input.RotateCw);
    let moveGuard = 0;
    while (recorder.game.x !== target.x && moveGuard++ < 20) {
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
}

async function recordTopOut(recorder: SprintRecorder, firstInput: number,
  handlingChangeAt?: number): Promise<void> {
  let now = firstInput - 10;
  let changed = false;
  let guard = 0;
  while (recorder.result === null && guard++ < 100) {
    if (handlingChangeAt !== undefined && !changed && now + 10 >= handlingChangeAt) {
      now = handlingChangeAt;
      recorder.setHandling(changedHandling, now);
      changed = true;
      continue;
    }
    now += 10;
    recorder.apply(Input.HardDrop, now);
  }
  if (!recorder.result) throw new Error("Top-out fixture did not finish");
}

describe("live Sprint recording", () => {
  test("perfect-finesse training completion seals and verifies normally", async () => {
    const recorder = new SprintRecorder(1, 0, { ...DEFAULT_HANDLING, das: 1, arr: 1 }, { abandonOnFinesseFault: true });
    let now = 1;
    let guard = 0;
    while (!recorder.result && guard++ < 1000) {
      let chosen: { input: InputId; at: number }[] | undefined;
      for (const target of candidates(recorder.game)) {
        const trial = Game.fromState(recorder.game.saveState(), null);
        const inputs: { input: InputId; at: number }[] = [];
        let at = 0;
        const send = (input: InputId) => { inputs.push({ input, at }); trial.apply(input, recorder.elapsedMs + at); };
        const rotation = (target.rot - trial.rot + 4) % 4;
        if (rotation) send(rotation === 1 ? Input.RotateCw : rotation === 2 ? Input.Rotate180 : Input.RotateCcw);
        const distance = target.x - trial.x;
        if (distance) {
          send(distance < 0 ? Input.LeftDown : Input.RightDown);
          if (Math.abs(distance) > 1) at += (Math.abs(distance) - 1) * FRAME_MS + 0.01;
          send(distance < 0 ? Input.LeftUp : Input.RightUp);
        }
        if (trial.x !== target.x) continue;
        send(Input.HardDrop);
        if (!trial.topOut && trial.finesse.faults === 0) { chosen = inputs; break; }
      }
      if (!chosen) throw new Error("No safe perfect-finesse placement");
      for (const operation of chosen) recorder.apply(operation.input, now + operation.at);
      now += chosen[chosen.length - 1].at + 1;
      if (recorder.status === "abandoned") throw new Error("Unexpected finesse fault");
    }
    expect(recorder.result?.outcome).toBe("complete");
    expect(recorder.game.finesse.faults).toBe(0);
    expect(recorder.game.finesse.evaluated).toBeGreaterThan(0);
    expect(recorder.game.finesse.points).toBe(recorder.game.finesse.evaluated * 5);
    const { replay } = await completed(recorder);
    expect(replay.summary.outcome).toBe("complete");
    expect(replay.summary.finesse.faults).toBe(0);
  });

  test("a completed attempt round-trips through the replay verifier", async () => {
    const recorder = new SprintRecorder(1, 1000, handling);
    await recordCompletion(recorder, 5001, 1);
    const { replay, live } = await completed(recorder);
    expect(replay.end.status).toBe("complete");
    expect(replay.summary.outcome).toBe("complete");
    expect(replay.summary.stats.lines).toBeGreaterThanOrEqual(SPRINT_TARGET);
    expect(replay.summary.elapsedMs).toBe(live.result.elapsedMs);
    expect(replay.summary.finesse).toEqual(live.result.finesse);
    expect(replay.records.length).toBeGreaterThan(1);
    expect(replay.records[0]).toEqual({ seq: 0, op: { type: "tick", atMs: 1000 } });
  });

  test("first gameplay input starts the clock; earlier ticks and releases do not", async () => {
    const recorder = new SprintRecorder(1, 1000, handling);
    await recordCompletion(recorder, 9001, 1, true);
    const { replay, live } = await completed(recorder);
    const firstGameplay = replay.records.find(record => record.op.type === "input"
      && record.op.input !== Input.LeftUp && record.op.input !== Input.RightUp
      && record.op.input !== Input.SoftDropUp);
    expect(firstGameplay?.op.type).toBe("input");
    if (firstGameplay?.op.type === "input") expect(firstGameplay.op.atMs).toBe(9001);
    expect(live.result.elapsedMs).toBe(winningAt(live.state));
    expect(live.result.elapsedMs).toBeLessThan(replay.end.atMs - 1000);
    expect(replay.end.atMs - live.result.elapsedMs).toBeGreaterThanOrEqual(9000);
    expect(replay.summary.elapsedMs).toBe(live.result.elapsedMs);
    expect(replay.summary.stats.lines).toBeGreaterThanOrEqual(SPRINT_TARGET);
  });

  test("fractional timestamps survive recording, serialization and reconstruction", async () => {
    const recorder = new SprintRecorder(2, 1000.125, handling);
    await recordCompletion(recorder, 5001.375, 0.125);
    const { replay, live } = await completed(recorder);
    expect(live.result.elapsedMs).not.toBe(Math.trunc(live.result.elapsedMs));
    expect(replay.summary.elapsedMs).toBe(live.result.elapsedMs);
    expect(replay.records.some(record => record.op.type === "input"
      && !Number.isInteger(record.op.atMs))).toBe(true);
  });

  test("frame ticks interleaved with equal-time inputs reconstruct exactly", async () => {
    const recorder = new SprintRecorder(5, 1000, handling);
    let now = 1000;
    let lastDrop = 0;
    while (recorder.result === null && now < 20_000) {
      now += 16.6667;
      recorder.tick(now);
      if (now > 1500 && (lastDrop === 0 || now - lastDrop >= 160)) {
        recorder.apply(Input.HardDrop, now);
        lastDrop = now;
      }
    }
    expect(recorder.result).not.toBeNull();
    const { replay } = await completed(recorder);
    expect(replay.records.filter(record => record.op.type === "tick").length).toBeGreaterThan(50);
    const equalTime = replay.records.some((record, index) => {
      if (record.op.type !== "input") return false;
      const previous = replay.records[index - 1];
      return previous?.op.type === "tick" && previous.op.atMs === record.op.atMs;
    });
    expect(equalTime).toBe(true);
  });

  test("records logical inputs and releases in call order at exact timestamps", async () => {
    const recorder = new SprintRecorder(11, 100.5, handling);
    recorder.tick(100.75);
    recorder.apply(Input.LeftDown, 101.125);
    recorder.apply(Input.LeftUp, 101.25);
    recorder.apply(Input.RotateCw, 101.5);
    recorder.apply(Input.HardDrop, 102.875);
    let now = 102.875;
    while (recorder.result === null && now < 5000) {
      now += 10;
      recorder.apply(Input.HardDrop, now);
    }
    const { replay } = await completed(recorder);
    expect(replay.records.slice(0, 6)).toEqual([
      { seq: 0, op: { type: "tick", atMs: 100.5 } },
      { seq: 1, op: { type: "tick", atMs: 100.75 } },
      { seq: 2, op: { type: "input", atMs: 101.125, input: Input.LeftDown } },
      { seq: 3, op: { type: "input", atMs: 101.25, input: Input.LeftUp } },
      { seq: 4, op: { type: "input", atMs: 101.5, input: Input.RotateCw } },
      { seq: 5, op: { type: "input", atMs: 102.875, input: Input.HardDrop } },
    ]);
  });

  test("handling changes are recorded at their observed time and replayed", async () => {
    const recorder = new SprintRecorder(7, 100, handling);
    await recordTopOut(recorder, 1010, 1055);
    const { replay, live } = await completed(recorder);
    expect(replay.summary.outcome).toBe("failed");
    expect(live.modeState.handling).toEqual(changedHandling);
    expect(live.state.config.handling).toEqual(changedHandling);
    const change = replay.records.find(record => record.op.type === "handling");
    expect(change?.op).toEqual({ type: "handling", observedAtMs: 1055, handling: changedHandling });
  });

  test("ignored Sprint pause requests still record their clock observation", async () => {
    const recorder = new SprintRecorder(7, 100, handling);
    recorder.apply(Input.RotateCw, 110);
    recorder.setPaused(true, 120);
    expect(recorder.paused).toBe(false);
    await recordTopOut(recorder, 130);
    const { replay } = await completed(recorder);
    expect(replay.records.some(record => record.op.type === "tick" && record.op.atMs === 120)).toBe(true);
  });

  test("top-out finalizes a failed attempt with a stopped journal", async () => {
    const recorder = new SprintRecorder(7, 100, handling);
    await recordTopOut(recorder, 1010);
    const { replay, live } = await completed(recorder);
    expect(live.result.outcome).toBe("failed");
    expect(live.result.stats.lines).toBe(0);
    expect(live.state.state.topOut).toBe(true);
    expect(replay.end.status).toBe("stopped");
    expect(replay.end.reason).toBe("top-out");
    expect(replay.summary.topOut).toBe(true);
    expect(replay.summary.elapsedMs).toBe(live.result.elapsedMs);
  });
});

describe("Sprint recording lifecycle", () => {
  test("the recorder is always a Sprint controller, never Zen", () => {
    const recorder = new SprintRecorder(1, 0);
    expect(recorder.mode).toBe("sprint");
    expect(recorder.game.zen).toBe(false);
    expect(recorder.game.width).toBe(10);
  });

  test("restarting starts a separate journal without previous operations", async () => {
    const first = new SprintRecorder(1, 100, handling);
    first.apply(Input.RotateCw, 110);
    first.tick(120);
    first.abandon();

    const second = new SprintRecorder(2, 200, handling);
    await recordCompletion(second, 300, 1);
    const { replay } = await completed(second);
    expect(replay.initial.seed).toBe(2);
    expect(replay.records[0]).toEqual({ seq: 0, op: { type: "tick", atMs: 200 } });
    expect(await first.finish()).toBeNull();
    expect(first.replay).toBeNull();
    expect(first.status).toBe("abandoned");
  });

  test("abandoning an unfinished attempt exposes no replay but gameplay continues", async () => {
    const recorder = new SprintRecorder(1, 0, handling);
    recorder.apply(Input.RotateCw, 10);
    recorder.tick(20);
    recorder.abandon();
    expect(await recorder.finish()).toBeNull();
    expect(await recorder.completion).toBeNull();
    expect(recorder.replay).toBeNull();
    expect(recorder.json).toBeNull();
    expect(recorder.status).toBe("abandoned");

    recorder.apply(Input.HardDrop, 30);
    expect(recorder.game.stats.pieces).toBe(1);
  });

  test("terminal finalization is idempotent and ignores later operations", async () => {
    const recorder = new SprintRecorder(1, 1000, handling);
    await recordCompletion(recorder, 5001, 1);
    const first = await recorder.finish();
    expect(first).not.toBeNull();
    const records = first!.records.length;
    const state = recorder.game.saveState();
    const result = recorder.result;

    recorder.tick(1_000_000);
    recorder.apply(Input.HardDrop, 1_000_001);
    recorder.setHandling(changedHandling, 1_000_002);
    expect(await recorder.finish()).toBe(first);
    expect(first!.records.length).toBe(records);
    expect(recorder.game.saveState()).toEqual(state);
    expect(recorder.result).toBe(result);
    expect(recorder.status).toBe("complete");
  });

  test("abandoning a completed recording does not discard it", async () => {
    const recorder = new SprintRecorder(1, 1000, handling);
    await recordCompletion(recorder, 5001, 1);
    const replay = await recorder.finish();
    expect(replay).not.toBeNull();
    recorder.abandon();
    expect(recorder.status).toBe("complete");
    expect(await recorder.finish()).toBe(replay);
  });
});

describe("Sprint recording limits", () => {
  test("operation limits stop recording without stopping gameplay", async () => {
    const recorder = new SprintRecorder(1, 0, handling, { maxOperations: 2 });
    recorder.tick(1);
    recorder.tick(2);
    expect(recorder.status).toBe("failed");
    expect(recorder.error?.code).toBe("resource-limit");
    expect(await recorder.finish()).toBeNull();
    expect(recorder.replay).toBeNull();

    recorder.apply(Input.HardDrop, 3);
    expect(recorder.game.stats.pieces).toBe(1);
  });

  test("duration limits reject the attempt explicitly", async () => {
    const recorder = new SprintRecorder(1, 0, handling, { maxDurationMs: 50 });
    recorder.tick(60);
    expect(recorder.status).toBe("failed");
    expect(recorder.error?.code).toBe("resource-limit");
    expect(await recorder.finish()).toBeNull();
  });

  test("byte limits reject the attempt explicitly", async () => {
    const recorder = new SprintRecorder(1, 0, handling, { maxBytes: 64 });
    recorder.tick(1);
    expect(recorder.status).toBe("failed");
    expect(recorder.error?.code).toBe("resource-limit");
    expect(await recorder.finish()).toBeNull();
    expect(recorder.json).toBeNull();
  });
});
