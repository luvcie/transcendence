import { describe, expect, test } from "bun:test";
import {
  DEFAULT_HANDLING,
  Input,
  LEAGUE_LOCK,
  MINOS,
  PRACTICE_LOCK,
  ROWS,
  Singleplayer,
  canPlace,
  clearRows,
  place,
  type Game,
  type GameState,
  type InputId,
  type SingleplayerReplayState,
  type SprintResult,
} from "@42tris/core";
import {
  CURRENT_REPLAY_VERSIONS,
  ReplayError,
  SHA256_ALGORITHM,
  SPRINT_MODE_ID,
  SPRINT_MODE_VERSION,
  SPRINT_TARGET,
  SprintDriver,
  computeFinalStateDigest,
  decodeReplay,
  decodeReplayJson,
  decodeReplayWithIntegrity,
  encodeReplay,
  isSprintReplay,
  sealReplay,
  verifySprintReplayExecution,
  type SoloInitial,
  type SoloOperation,
  type SoloRecord,
  type SprintReplay,
  type UnsignedSprintReplay,
} from "./index";

const handling = { ...DEFAULT_HANDLING, arr: 0, sdarr: 0 };
const initial: SoloInitial = { seed: 1, gravityMs: 500, previewCount: 5, handling,
  readyMs: 0, lockProfile: PRACTICE_LOCK, width: 10, zen: false };

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

function winningAt(state: GameState): number {
  if (!state.lastResult) throw new Error("Expected a winning lock");
  return state.lastResult.atMs;
}

interface GeneratedSprint {
  payload: UnsignedSprintReplay;
  firstInputMs: number;
  lastRecordMs: number;
  result: SprintResult;
  state: GameState;
  modeState: SingleplayerReplayState;
}

async function payloadFor(run: Singleplayer, records: SoloRecord[], seed: number): Promise<UnsignedSprintReplay> {
  const result = run.result;
  if (result === null) throw new Error("Fixture did not reach a terminal Sprint result");
  const state = run.game.saveState();
  const modeState = run.replayState();
  const lastRecordMs = recordAt(records[records.length - 1]);
  return {
    versions: CURRENT_REPLAY_VERSIONS,
    id: `sprint-${seed}-${lastRecordMs}`,
    kind: "solo",
    mode: { id: SPRINT_MODE_ID, version: SPRINT_MODE_VERSION, config: { target: SPRINT_TARGET } },
    initial: { ...initial, seed, handling: { ...handling } },
    records,
    end: {
      atMs: lastRecordMs,
      afterSeq: records.length - 1,
      status: result.outcome === "complete" ? "complete" : "stopped",
      reason: result.outcome === "complete" ? "completed" : "top-out",
      finalStateDigest: await computeFinalStateDigest(state, modeState),
    },
    summary: {
      outcome: result.outcome,
      elapsedMs: result.elapsedMs,
      stats: { ...result.stats },
      finesse: { ...result.finesse },
      topOut: state.state.topOut,
    },
  };
}

async function generateCompletion(seed = 1, startWall = 1000, firstInputWall = 5001,
  prelude = false, step = 1, midGapAfter?: number): Promise<GeneratedSprint> {
  const run = new Singleplayer("sprint", seed, startWall, handling);
  const records: SoloRecord[] = [];
  const push = (op: SoloOperation) => records.push({ seq: records.length, op });
  push({ type: "tick", atMs: startWall });
  run.tick(startWall);

  if (prelude) {
    for (const [atMs, input] of [[1500, null], [1800, Input.LeftUp], [2500, null],
      [3000, Input.SoftDropUp], [4000, null], [4500, Input.RightUp]] as const) {
      if (input === null) {
        run.tick(atMs);
        push({ type: "tick", atMs });
      } else {
        run.apply(input, atMs);
        push({ type: "input", atMs, input });
      }
    }
  }

  let now = firstInputWall - step;
  const send = (input: InputId) => {
    now += step;
    run.apply(input, now);
    push({ type: "input", atMs: now, input });
  };

  let guard = 0;
  let gapApplied = false;
  while (run.result === null && guard++ < 1000) {
    const target = candidates(run.game)[0];
    if (!target) break;
    let rotationGuard = 0;
    while (run.game.rot !== target.rot && rotationGuard++ < 4) send(Input.RotateCw);
    let moveGuard = 0;
    while (run.game.x !== target.x && moveGuard++ < 20) {
      if (target.x > run.game.x) {
        send(Input.RightDown);
        send(Input.RightUp);
      } else {
        send(Input.LeftDown);
        send(Input.LeftUp);
      }
    }
    send(Input.HardDrop);
    if (midGapAfter !== undefined && !gapApplied && records.length >= midGapAfter) {
      now += 250;
      gapApplied = true;
    }
  }

  const result = run.result;
  if (result === null) throw new Error("Completion fixture did not finish");
  return {
    payload: await payloadFor(run, records, seed),
    firstInputMs: firstInputWall,
    lastRecordMs: recordAt(records[records.length - 1]),
    result,
    state: run.game.saveState(),
    modeState: run.replayState(),
  };
}

async function generateTopOut(seed = 7, startWall = 100, firstInputWall = 1010,
  handlingChangeAt?: number): Promise<GeneratedSprint> {
  const run = new Singleplayer("sprint", seed, startWall, handling);
  const records: SoloRecord[] = [];
  const push = (op: SoloOperation) => records.push({ seq: records.length, op });
  push({ type: "tick", atMs: startWall });
  run.tick(startWall);
  const changedHandling = { das: 12, arr: 1, sddas: 1, sdarr: 1 };
  let changed = false;
  let now = firstInputWall - 10;
  let guard = 0;
  while (run.result === null && guard++ < 100) {
    if (handlingChangeAt !== undefined && !changed && now + 10 > handlingChangeAt) {
      now = handlingChangeAt;
      run.setHandling(changedHandling, now);
      push({ type: "handling", observedAtMs: now, handling: { ...changedHandling } });
      changed = true;
      continue;
    }
    now += 10;
    run.apply(Input.HardDrop, now);
    push({ type: "input", atMs: now, input: Input.HardDrop });
  }
  const result = run.result;
  if (result === null) throw new Error("Top-out fixture did not finish");
  return {
    payload: await payloadFor(run, records, seed),
    firstInputMs: firstInputWall,
    lastRecordMs: recordAt(records[records.length - 1]),
    result,
    state: run.game.saveState(),
    modeState: run.replayState(),
  };
}

const completionCache = new Map<string, Promise<GeneratedSprint>>();
function completion(seed = 1, firstInputWall = 5001, prelude = false,
  step = 1, midGapAfter?: number): Promise<GeneratedSprint> {
  const key = `${seed}:${firstInputWall}:${prelude}:${step}:${midGapAfter ?? "-"}`;
  let pending = completionCache.get(key);
  if (!pending) {
    pending = generateCompletion(seed, 1000, firstInputWall, prelude, step, midGapAfter);
    completionCache.set(key, pending);
  }
  return pending;
}

async function sealed(payload: UnsignedSprintReplay): Promise<SprintReplay> {
  const decoded = await decodeReplayJson(encodeReplay(await sealReplay(payload)));
  if (!isSprintReplay(decoded)) throw new Error("Expected a Sprint replay");
  return decoded;
}

function withIntegrity(payload: UnsignedSprintReplay) {
  return { ...payload, integrity: { algorithm: SHA256_ALGORITHM, digest: "0".repeat(64) } };
}

function expectCode(fn: () => unknown, code: ReplayError["code"]): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ReplayError);
    expect((error as ReplayError).code).toBe(code);
    return;
  }
  throw new Error(`Expected ReplayError ${code}`);
}

async function expectRejects(fn: () => Promise<unknown>, code: ReplayError["code"]): Promise<void> {
  try {
    await fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ReplayError);
    expect((error as ReplayError).code).toBe(code);
    return;
  }
  throw new Error(`Expected ReplayError ${code}`);
}

describe("Sprint replay reconstruction", () => {
  test("identical journals reconstruct identical terminal state and results", async () => {
    const { payload } = await completion();
    const decoded = await sealed(payload);
    const first = await verifySprintReplayExecution(decoded);
    const second = await verifySprintReplayExecution(decoded);
    expect(second.state).toEqual(first.state);
    expect(second.modeState).toEqual(first.modeState);
    expect(second.result).toEqual(first.result);
    expect(first.finalStateDigest).toBe(decoded.end.finalStateDigest);

    const replay = new SprintDriver(decoded.initial);
    for (const record of decoded.records) replay.apply(record);
    expect(replay.state).toEqual(first.state);
    expect(replay.modeState).toEqual(first.modeState);
  });

  test("first gameplay input starts the clock; earlier ticks and releases do not", async () => {
    const generated = await completion(1, 9001, true);
    const decoded = await sealed(generated.payload);
    const verification = await verifySprintReplayExecution(decoded);
    expect(verification.result.elapsedMs).toBe(generated.lastRecordMs - generated.firstInputMs);
    expect(verification.result.elapsedMs).toBeLessThan(generated.lastRecordMs - 1000);
    expect(verification.result.stats.lines).toBe(SPRINT_TARGET);
  });

  test("a sprint completes at exactly 40 lines on the winning lock timestamp", async () => {
    const generated = await completion(1);
    const decoded = await sealed(generated.payload);
    const verification = await verifySprintReplayExecution(decoded);
    expect(verification.result.outcome).toBe("complete");
    expect(verification.result.stats.lines).toBe(40);
    expect(verification.result.elapsedMs).toBe(generated.lastRecordMs - generated.firstInputMs);
    expect(verification.result.elapsedMs).toBe(winningAt(verification.state));
    expect(verification.state.state.observedNow).toBe(verification.result.elapsedMs);
    expect(decoded.end.status).toBe("complete");
  });

  test("wall-clock gaps without pause are still elapsed Sprint time", async () => {
    const generated = await completion(3, 5001, false, 1, 40);
    const verification = await verifySprintReplayExecution(await sealed(generated.payload));
    expect(verification.result.outcome).toBe("complete");
    expect(verification.result.elapsedMs).toBe(generated.lastRecordMs - generated.firstInputMs);
    expect(verification.result.elapsedMs).toBe(winningAt(verification.state));
  });

  test("fractional controller timestamps survive journal encoding at full precision", async () => {
    const generated = await completion(2, 5001, false, 0.125);
    const decoded = await sealed(generated.payload);
    const verification = await verifySprintReplayExecution(decoded);
    expect(verification.result.elapsedMs).toBe(generated.lastRecordMs - generated.firstInputMs);
    expect(verification.result.elapsedMs).not.toBe(Math.trunc(verification.result.elapsedMs));
    expect(verification.result.stats.lines).toBe(SPRINT_TARGET);
  });

  test("a clear crossing 40 lines completes with the crossed line count", async () => {
    const generated = await completion(8);
    const verification = await verifySprintReplayExecution(await sealed(generated.payload));
    expect(verification.result.outcome).toBe("complete");
    expect(verification.result.stats.lines).toBeGreaterThan(SPRINT_TARGET);
    expect(verification.result.elapsedMs).toBe(winningAt(verification.state));
  });

  test("handling changes are replayed at their observed wall time", async () => {
    const generated = await generateTopOut(7, 100, 1010, 1055);
    const decoded = await sealed(generated.payload);
    const verification = await verifySprintReplayExecution(decoded);
    const changed = { das: 12, arr: 1, sddas: 1, sdarr: 1 };
    expect(verification.modeState.handling).toEqual(changed);
    expect(verification.state.config.handling).toEqual(changed);
    expect(verification.result.outcome).toBe("failed");
  });

  test("top-out reconstructs a failed attempt and stops at its terminal timestamp", async () => {
    const generated = await generateTopOut();
    const decoded = await sealed(generated.payload);
    const verification = await verifySprintReplayExecution(decoded);
    expect(verification.result.outcome).toBe("failed");
    expect(verification.result.stats.lines).toBe(0);
    expect(verification.state.state.topOut).toBe(true);
    expect(verification.result.elapsedMs).toBe(generated.lastRecordMs - generated.firstInputMs);
    expect(verification.state.state.observedNow).toBe(verification.result.elapsedMs);
    expect(decoded.end.status).toBe("stopped");
  });
});

describe("Sprint replay rejection", () => {
  test("rejects pause, undo, malformed clocks and non-Sprint configuration", async () => {
    const { payload } = await completion();
    for (const op of [
      { type: "pause", atMs: 5001, paused: true },
      { type: "undo", atMs: 5001 },
    ]) {
      const bad = structuredClone(withIntegrity(payload)) as Record<string, any>;
      bad.records[1] = { seq: 1, op };
      expectCode(() => decodeReplay(bad), "malformed");
    }

    const backwards = structuredClone(withIntegrity(payload)) as Record<string, any>;
    backwards.records[2].op.atMs = 1;
    expectCode(() => decodeReplay(backwards), "malformed");

    const firstInput = structuredClone(withIntegrity(payload)) as Record<string, any>;
    firstInput.records[0].op = { type: "input", atMs: 1000, input: Input.HardDrop };
    expectCode(() => decodeReplay(firstInput), "malformed");

    for (const [name, mutate] of [
      ["width", (value: Record<string, any>) => { value.initial.width = 8; }],
      ["gravity", (value: Record<string, any>) => { value.initial.gravityMs = 1000; }],
      ["preview count", (value: Record<string, any>) => { value.initial.previewCount = 4; }],
      ["opening delay", (value: Record<string, any>) => { value.initial.readyMs = 250; }],
      ["lock profile", (value: Record<string, any>) => { value.initial.lockProfile = LEAGUE_LOCK; }],
      ["target", (value: Record<string, any>) => { value.mode.config.target = 20; }],
    ] as const) {
      const bad = structuredClone(withIntegrity(payload)) as Record<string, any>;
      mutate(bad);
      expectCode(() => decodeReplay(bad), "malformed");
    }
  });

  test("rejects journals that continue after the terminal result", async () => {
    const { payload } = await completion();
    const lastAt = recordAt(payload.records[payload.records.length - 1]);
    const bad = structuredClone(payload);
    bad.records.push({ seq: bad.records.length, op: { type: "tick", atMs: lastAt + 1 } });
    bad.end.atMs = lastAt + 1;
    bad.end.afterSeq = bad.records.length - 1;
    const decoded = await sealed(bad);
    await expectRejects(() => verifySprintReplayExecution(decoded), "simulation-mismatch");
  });

  test("rejects terminal end statuses that contradict the reconstructed outcome", async () => {
    const completed = await completion();
    for (const status of ["stopped", "incomplete"] as const) {
      const bad = structuredClone(completed.payload);
      bad.end.status = status;
      await expectRejects(async () => verifySprintReplayExecution(await sealed(bad)), "simulation-mismatch");
    }

    const failed = await generateTopOut();
    const bad = structuredClone(failed.payload);
    bad.end.status = "complete";
    await expectRejects(async () => verifySprintReplayExecution(await sealed(bad)), "simulation-mismatch");
  });

  test("rejects modified claimed results even with a valid checksum", async () => {
    const { payload } = await completion();
    const mutations: [string, (value: Record<string, any>) => void][] = [
      ["outcome", value => {
        value.summary.outcome = "failed";
        value.summary.topOut = true;
        value.end.status = "stopped";
      }],
      ["elapsed time", value => { value.summary.elapsedMs += 1; }],
      ["line count", value => { value.summary.stats.lines -= 1; }],
      ["finesse", value => { value.summary.finesse.evaluated += 1; }],
      ["top-out flag", value => { value.summary.topOut = !value.summary.topOut; }],
    ];
    for (const [name, mutate] of mutations) {
      const bad = structuredClone(payload) as Record<string, any>;
      mutate(bad);
      const decoded = await decodeReplayWithIntegrity(await sealReplay(bad as UnsignedSprintReplay));
      if (!isSprintReplay(decoded)) throw new Error("Expected a Sprint replay");
      await expectRejects(() => verifySprintReplayExecution(decoded), "simulation-mismatch");
    }
  });

  test("rejects an incorrect final-state digest and cannot expose partial success", async () => {
    const { payload } = await completion();
    const bad = structuredClone(payload);
    bad.end.finalStateDigest = "0".repeat(64);
    const decoded = await decodeReplayWithIntegrity(await sealReplay(bad));
    if (!isSprintReplay(decoded)) throw new Error("Expected a Sprint replay");

    let failed = false;
    try {
      await verifySprintReplayExecution(decoded);
    } catch (error) {
      expect(error).toBeInstanceOf(ReplayError);
      expect((error as ReplayError).code).toBe("simulation-mismatch");
      failed = true;
    }
    expect(failed).toBe(true);

    const good = await verifySprintReplayExecution(await sealed(payload));
    expect(good.result.outcome).toBe("complete");
    expect(good.finalStateDigest).toBe(payload.end.finalStateDigest);
  });
});
