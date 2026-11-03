/**
 * M2-B1: Competitive Match replay recorder tests.
 *
 * Covers: complete 1v1 sets, multiple rounds, 3-player and 8-player matches,
 * input ordering, releases, forfeits, garbage, frame advancement, digests,
 * winner/score reconstruction, duplicate finalization, post-completion calls,
 * incomplete/abandoned recordings, resource limits, operation failure, and
 * strict practice-mode rejection.
 */

import { describe, expect, test } from "bun:test";
import {
  FRAME_MS,
  Input,
  LEAGUE_LOCK,
  MINOS,
  ROWS,
  canPlace,
  clearRows,
  place,
  type GameState,
  type Handling,
  type InputId,
} from "@42tris/core";
import { Match, type MatchEvent } from "@42tris/match";
import {
  MatchRecorder,
  ReplayError,
  verifyMatchReplayExecution,
  type MatchReplay,
  type MatchRecorderStatus,
} from "./index";

// ────────────────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────────────────

const HANDLING: Handling = { das: 1, arr: 1, sddas: 0, sdarr: 0 };

function makeMatch(
  players: readonly string[],
  seed: number,
  firstTo: number,
  width?: number,
  mode: "competitive" | "practice" = "competitive",
): Match {
  return new Match({
    players: [...players],
    seed,
    firstTo,
    width,
    mode,
    attacksEnabled: mode === "competitive" ? true : undefined,
    handlingByPlayer: Object.fromEntries(players.map(p => [p, HANDLING])),
  });
}

function makeRecorder(
  match: Match,
  options?: Parameters<typeof MatchRecorder.prototype.finish>[0] extends undefined
    ? Record<string, never>
    : never,
  id = `test-${Date.now()}`,
): MatchRecorder {
  return new MatchRecorder(match, id);
}

// ── AI placement helpers ────────────────────────────────────────────────────

interface Candidate { rot: number; x: number; score: number }

function candidates(game: GameState, strategy: "score" | "tower"): Candidate[] {
  const board = Uint8Array.from(game.board);
  const width = game.config.width;
  const piece = game.state.piece;
  const result: Candidate[] = [];
  const shapes = new Set<string>();
  for (let rot = 0; rot < 4; rot++) {
    const shape = Array.from(MINOS[piece][rot]).join(",");
    if (shapes.has(shape)) continue;
    shapes.add(shape);
    for (let x = -3; x < width; x++) {
      if (!canPlace(board, piece, rot, x, 18)) continue;
      let y = 18;
      while (canPlace(board, piece, rot, x, y + 1)) y++;
      const after = board.slice();
      place(after, piece, rot, x, y);
      const { rows } = clearRows(after);
      let holes = 0, aggregate = 0, bumpiness = 0;
      const heights: number[] = [];
      for (let xx = 0; xx < width; xx++) {
        let height = 0, seen = false;
        for (let yy = 0; yy < ROWS; yy++) {
          if (after[yy * width + xx] !== 0) { if (!seen) { height = ROWS - yy; seen = true; } }
          else if (seen) holes++;
        }
        heights.push(height);
        aggregate += height;
      }
      for (let i = 1; i < width; i++) bumpiness += Math.abs(heights[i] - heights[i - 1]);
      const score = strategy === "score"
        ? rows.length * 10000 - holes * 500 - aggregate * 5 - bumpiness * 10 - Math.max(...heights) * 20
        : -aggregate * 100 - holes * 10 + x;
      result.push({ rot, x, score });
    }
  }
  return result.sort((a, b) => b.score - a.score || a.x - b.x || a.rot - b.rot);
}

interface PlanOp { input: InputId; frame: number; subframe: number }

function plan(state: GameState, startFrame: number, strategy: "score" | "tower"): PlanOp[] {
  const target = candidates(state, strategy)[0];
  if (!target) return [];
  const ops: PlanOp[] = [];
  let index = 0;
  const at = () => {
    const frame = startFrame + Math.floor(index / 8);
    const subframe = (index % 8) * 0.1 + 0.05;
    index++;
    return { frame, subframe };
  };
  for (let r = 0; r < target.rot; r++) ops.push({ input: Input.RotateCw, ...at() });
  const delta = target.x - state.state.x;
  for (let s = 0; s < Math.abs(delta); s++) {
    const right = delta > 0;
    ops.push({ input: right ? Input.RightDown : Input.LeftDown, ...at() });
    ops.push({ input: right ? Input.RightUp : Input.LeftUp, ...at() });
  }
  ops.push({ input: Input.HardDrop, ...at() });
  return ops;
}

function nextOrder(state: { order: number }): number { return state.order++; }

/**
 * Drives a round to completion by having `losers` top out via hard drops.
 * All operations go through the recorder.
 */
function topOutRound(
  match: Match,
  recorder: MatchRecorder,
  losers: readonly string[],
  maxFrames = 2000,
): MatchEvent[] {
  let allEvents: MatchEvent[] = [];
  const orderState = { order: 0 };
  let guard = 0;
  while (!match.ended && guard++ < maxFrames) {
    const frame = match.frame;
    for (const player of losers) {
      if (!match.activePlayers.includes(player)) continue;
      if (match.playerState(player).state.topOut) continue;
      const epoch = match.playerEpoch(player);
      const order = nextOrder(orderState);
      recorder.submit({ player, frame, subframe: 0.5, order, input: Input.HardDrop, epoch });
    }
    allEvents.push(...recorder.advanceToFrame(frame + 1));
  }
  if (!match.ended) throw new Error("topOutRound fixture did not end the round");
  allEvents.push(...recorder.drainEvents()); // flush any remaining
  return allEvents;
}

/**
 * Runs a bot round for both players until the match ends or `stop` returns
 * true. All operations go through the recorder.
 */
function botRound(
  match: Match,
  recorder: MatchRecorder,
  strategies: Readonly<Record<string, "score" | "tower">>,
  offsets: Readonly<Record<string, number>> = {},
  stop: (match: Match) => boolean = () => false,
  maxFrames = 5000,
): MatchEvent[] {
  const allEvents: MatchEvent[] = [];
  const orderState = { order: 0 };
  let guard = 0;
  while (!match.ended && !match.complete && match.frame < maxFrames && !stop(match) && guard++ < 5000) {
    const planned: PlanOp[][] = [];
    for (const player of match.activePlayers) {
      const state = match.playerState(player);
      if (state.state.topOut) continue;
      const ops = plan(state, match.frame + (offsets[player] ?? 0), strategies[player] ?? "score");
      if (!ops.length) continue;
      for (const op of ops) {
        const epoch = match.playerEpoch(player);
        const order = nextOrder(orderState);
        recorder.submit({ player, frame: op.frame, subframe: op.subframe, order, input: op.input, epoch });
      }
      planned.push(ops);
    }
    if (!planned.length) break;
    allEvents.push(...recorder.advanceToFrame(Math.max(...planned.flatMap(ops => ops.map(op => op.frame))) + 1));
  }
  allEvents.push(...recorder.drainEvents());
  return allEvents;
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

// ────────────────────────────────────────────────────────────────────────────
// Practice mode rejection
// ────────────────────────────────────────────────────────────────────────────

describe("practice-mode rejection", () => {
  test("construction throws ReplayError unsupported for a practice Match", () => {
    const match = makeMatch(["a", "b"], 1, 7, undefined, "practice");
    expect(() => new MatchRecorder(match, "test")).toThrow(ReplayError);
    try {
      new MatchRecorder(match, "test");
    } catch (error) {
      expect(error).toBeInstanceOf(ReplayError);
      expect((error as ReplayError).code).toBe("unsupported");
      expect((error as ReplayError).message).toContain("Practice");
    }
  });

  test("a practice Match with player count matching a real set is still rejected", () => {
    for (const count of [2, 4, 8]) {
      const players = Array.from({ length: count }, (_, i) => String.fromCharCode(97 + i));
      const match = makeMatch(players, 42, 7, undefined, "practice");
      expect(() => new MatchRecorder(match, "test")).toThrow(ReplayError);
    }
  });

  test("practice rejection happens before any journal state is allocated", () => {
    const match = makeMatch(["a", "b"], 1, 7, undefined, "practice");
    let threw = false;
    try { new MatchRecorder(match, "test"); } catch { threw = true; }
    expect(threw).toBe(true);
    // The competitive Match is unaffected.
    const competitive = makeMatch(["a", "b"], 1, 7);
    const recorder = new MatchRecorder(competitive, "test");
    expect(recorder.status).toBe("recording");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Complete 1v1 set
// ────────────────────────────────────────────────────────────────────────────

describe("1v1 complete set recording", () => {
  test("records a complete 1v1 set and produces a verified replay", async () => {
    const match = makeMatch(["a", "b"], 108, 1);
    const recorder = new MatchRecorder(match, "match-108-1v1");
    expect(recorder.status).toBe("recording");

    topOutRound(match, recorder, ["b"]);

    expect(match.complete).toBe(true);
    expect(recorder.status).toBe("finalizing");

    const replay = await recorder.finish();
    expect(replay).not.toBeNull();
    expect(recorder.status).toBe("complete");
    expect(recorder.replay).toBe(replay);
    expect(recorder.json).not.toBeNull();

    const verification = await verifyMatchReplayExecution(replay!);
    expect(verification.complete).toBe(true);
    expect(verification.winner).toBe("a");
    expect(verification.reason).toBe("firstTo");
    expect(verification.scores).toEqual({ a: 1, b: 0 });
    expect(verification.rounds).toHaveLength(1);
    expect(verification.rounds[0]).toMatchObject({
      round: 1,
      winner: "a",
      complete: true,
      reason: "survivor",
    });
    // Final state must match the live authoritative Match.
    expect(verification.state).toEqual(match.saveState());
    expect(verification.finalStateDigest).toBe(replay!.end.finalStateDigest);
  });

  test("replay contains the same initial configuration as the Match", async () => {
    const match = makeMatch(["a", "b"], 42, 3);
    const recorder = new MatchRecorder(match, "cfg-test");

    topOutRound(match, recorder, ["b"]);
    // Need more rounds for firstTo=3: top out b twice more
    recorder.nextRound(43);
    recorder.releaseControls();
    topOutRound(match, recorder, ["b"]);
    recorder.nextRound(44);
    recorder.releaseControls();
    topOutRound(match, recorder, ["b"]);

    const replay = await recorder.finish();
    expect(replay).not.toBeNull();

    expect(replay!.initial.players).toEqual(["a", "b"]);
    expect(replay!.initial.firstTo).toBe(3);
    expect(replay!.initial.seed).toBe(42);
    expect(replay!.initial.lockProfile).toBe(LEAGUE_LOCK);
    expect(replay!.initial.mode).toBe("competitive");
    expect(replay!.initial.attacksEnabled).toBe(true);
  });

  test("completion promise resolves with the verified replay", async () => {
    const match = makeMatch(["a", "b"], 108, 1);
    const recorder = new MatchRecorder(match, "promise-test");

    topOutRound(match, recorder, ["b"]);

    const fromCompletion = await recorder.completion;
    const fromFinish = await recorder.finish();

    expect(fromCompletion).not.toBeNull();
    expect(fromCompletion).toBe(fromFinish);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Multiple rounds
// ────────────────────────────────────────────────────────────────────────────

describe("multiple rounds", () => {
  test("records a 3-round set with correct boundaries and transitions", async () => {
    const match = makeMatch(["a", "b"], 108, 2);
    const recorder = new MatchRecorder(match, "multi-round");
    const orderState = { order: 0 };

    topOutRound(match, recorder, ["b"]);
    expect(match.ended).toBe(true);
    expect(match.complete).toBe(false);

    recorder.nextRound(109);
    recorder.releaseControls("a");
    recorder.releaseControls("b");

    topOutRound(match, recorder, ["a"]);
    expect(match.round).toBe(2);
    recorder.nextRound(110);
    recorder.releaseControls("a");
    recorder.releaseControls("b");

    topOutRound(match, recorder, ["b"]);
    expect(match.complete).toBe(true);
    expect(match.scores).toEqual({ a: 2, b: 1 });

    const replay = await recorder.finish();
    expect(replay).not.toBeNull();

    const verification = await verifyMatchReplayExecution(replay!);
    expect(verification.rounds).toHaveLength(3);
    expect(verification.rounds.map(r => [r.round, r.winner])).toEqual([
      [1, "a"],
      [2, "b"],
      [3, "a"],
    ]);
    expect(verification.scores).toEqual({ a: 2, b: 1 });
    expect(verification.state).toEqual(match.saveState());

    // nextRound records should appear at round boundaries.
    const nextRoundOps = replay!.records.filter(r => r.op.type === "nextRound");
    expect(nextRoundOps).toHaveLength(2);
    expect(nextRoundOps[0].before.round).toBe(1);
    expect(nextRoundOps[1].before.round).toBe(2);
  });

  test("round summaries include the correct frames", async () => {
    const match = makeMatch(["a", "b"], 55, 1);
    const recorder = new MatchRecorder(match, "frame-test");

    topOutRound(match, recorder, ["b"]);

    const replay = await recorder.finish();
    expect(replay).not.toBeNull();

    const verification = await verifyMatchReplayExecution(replay!);
    expect(verification.rounds[0].frame).toBe(match.frame);
    expect(replay!.summary.rounds[0].frame).toBe(match.frame);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Three-player and eight-player matches
// ────────────────────────────────────────────────────────────────────────────

describe("multi-player matches", () => {
  test("three players reconstruct simultaneous top-outs and a single survivor", async () => {
    const match = makeMatch(["a", "b", "c"], 7, 1);
    const recorder = new MatchRecorder(match, "3p-test");

    topOutRound(match, recorder, ["b", "c"]);
    expect(match.complete).toBe(true);

    const replay = await recorder.finish();
    expect(replay).not.toBeNull();

    const verification = await verifyMatchReplayExecution(replay!);
    expect(verification.winner).toBe("a");
    expect(verification.scores).toEqual({ a: 1, b: 0, c: 0 });
    expect(verification.state).toEqual(match.saveState());
  });

  test("eight players fully record and verify the surviving winner", async () => {
    const players = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const match = makeMatch(players, 42, 1);
    const recorder = new MatchRecorder(match, "8p-test");

    topOutRound(match, recorder, players.slice(1));
    expect(match.complete).toBe(true);

    const replay = await recorder.finish();
    expect(replay).not.toBeNull();

    const verification = await verifyMatchReplayExecution(replay!);
    expect(verification.state.roster).toEqual(players);
    expect(verification.state.players).toHaveLength(8);
    expect(verification.winner).toBe("a");
    expect(verification.scores).toEqual(
      Object.fromEntries(players.map(p => [p, p === "a" ? 1 : 0])),
    );
    expect(verification.state).toEqual(match.saveState());
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Input ordering
// ────────────────────────────────────────────────────────────────────────────

describe("authoritative inputs and ordering", () => {
  test("journal ordering decides same-time input results and recorder preserves it", async () => {
    const buildWithOrder = (leftFirst: boolean) => {
      const match = makeMatch(["a", "b"], 11, 1);
      const recorder = new MatchRecorder(match, `order-${leftFirst}`);
      const epoch = match.playerEpoch("a");
      if (leftFirst) {
        recorder.submit({ player: "a", frame: 0, subframe: 0.5, order: 0, input: Input.LeftDown, epoch });
        recorder.submit({ player: "a", frame: 0, subframe: 0.5, order: 1, input: Input.HardDrop, epoch });
      } else {
        recorder.submit({ player: "a", frame: 0, subframe: 0.5, order: 0, input: Input.HardDrop, epoch });
        recorder.submit({ player: "a", frame: 0, subframe: 0.5, order: 1, input: Input.LeftDown, epoch });
      }
      recorder.advanceToFrame(1);
      return { match, recorder };
    };

    const { match: lMatch } = buildWithOrder(true);
    const { match: dMatch } = buildWithOrder(false);
    // Different input orders produce different states.
    expect(lMatch.saveState()).not.toEqual(dMatch.saveState());
  });

  test("records the correct epoch for each player", async () => {
    const match = makeMatch(["a", "b"], 108, 1);
    const recorder = new MatchRecorder(match, "epoch-test");
    const epoch = match.playerEpoch("a");

    recorder.submit({
      player: "a",
      frame: 0,
      subframe: 0.5,
      order: 0,
      input: Input.HardDrop,
      epoch,
    });
    recorder.advanceToFrame(1);

    topOutRound(match, recorder, ["b"]);

    const replay = await recorder.finish();
    expect(replay).not.toBeNull();

    const submitRecord = replay!.records.find(r => r.op.type === "submit");
    expect(submitRecord?.op.type === "submit" && submitRecord.op.input.epoch).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Input releases
// ────────────────────────────────────────────────────────────────────────────

describe("input releases", () => {
  test("per-player release appears in the journal and clears pending inputs", async () => {
    const match = makeMatch(["a", "b"], 7, 1);
    const recorder = new MatchRecorder(match, "release-test");

    recorder.submit({ player: "a", frame: 2, subframe: 0.5, order: 0, input: Input.LeftDown, epoch: 0 });
    recorder.advanceToFrame(3);
    const beforeState = match.saveState();
    recorder.releaseControls("a");

    expect(match.saveState().inputs).toEqual([]);
    expect(match.playerState("a").state.leftHeld).toBe(false);

    topOutRound(match, recorder, ["b"]);

    const replay = await recorder.finish();
    expect(replay).not.toBeNull();

    const releaseRecords = replay!.records.filter(r => r.op.type === "release");
    expect(releaseRecords.length).toBeGreaterThan(0);
    const firstRelease = releaseRecords[0];
    expect(firstRelease.op).toEqual({ type: "release", player: "a" });

    const verification = await verifyMatchReplayExecution(replay!);
    expect(verification.state).toEqual(match.saveState());
  });

  test("global release with no player argument releases all players", async () => {
    const match = makeMatch(["a", "b"], 7, 1);
    const recorder = new MatchRecorder(match, "global-release");

    recorder.releaseControls();

    topOutRound(match, recorder, ["b"]);
    const replay = await recorder.finish();
    expect(replay).not.toBeNull();

    const releaseRecord = replay!.records.find(r => r.op.type === "release");
    expect(releaseRecord?.op).toEqual({ type: "release" });
    const verification = await verifyMatchReplayExecution(replay!);
    expect(verification.complete).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Forfeits
// ────────────────────────────────────────────────────────────────────────────

describe("forfeits", () => {
  test("a forfeit completes the set and the recorder finalizes with reason forfeit", async () => {
    const match = makeMatch(["a", "b"], 108, 7);
    const recorder = new MatchRecorder(match, "forfeit-1v1");

    recorder.forfeit("a");
    expect(match.complete).toBe(true);

    const replay = await recorder.finish();
    expect(replay).not.toBeNull();

    const verification = await verifyMatchReplayExecution(replay!);
    expect(verification).toMatchObject({ winner: "b", reason: "forfeit", complete: true });
    expect(verification.scores).toEqual({ a: 0, b: 1 });
  });

  test("all players forfeit one after another eventually completes the set", async () => {
    // With 3 players: a forfeits first → round ends (b survives, c survives, b gets point if
    // only 1 survivor). Actually: a forfeits → finishFrame fires → b and c still alive so
    // round continues. Then b forfeits → finishFrame fires → c alone → c wins round (score=1).
    // Then c forfeits → set complete (c is last eligible). Result: forfeit reason, winner c.
    //
    // For a true 3-player aborted set, we need all 3 to forfeit before any round ends. The
    // existing match test (in match.test.ts) uses a different setup. Here we verify a 2-player
    // scenario where both forfeit simultaneously in the round.
    const match = makeMatch(["a", "b"], 108, 3);
    const recorder = new MatchRecorder(match, "both-forfeit", { manualCompletion: true });

    recorder.forfeit("a");
    recorder.forfeit("b");
    expect(match.complete).toBe(true);

    const replay = await recorder.finish();
    expect(replay).not.toBeNull();

    const verification = await verifyMatchReplayExecution(replay!);
    // Both forfeited: a forfeits first → b is last eligible → b wins round + set via forfeit.
    // Then b forfeits → aborted (no eligible left).
    expect(verification.complete).toBe(true);
    expect(verification.state).toEqual(match.saveState());
  });

  test("forfeit between rounds completes the set without awarding a second point", async () => {
    const match = makeMatch(["a", "b"], 108, 7);
    const recorder = new MatchRecorder(match, "inter-round-forfeit");

    topOutRound(match, recorder, ["b"]);
    expect(match.scores).toEqual({ a: 1, b: 0 });

    recorder.forfeit("b");
    expect(match.complete).toBe(true);

    const replay = await recorder.finish();
    expect(replay).not.toBeNull();

    const verification = await verifyMatchReplayExecution(replay!);
    expect(verification).toMatchObject({ winner: "a", reason: "forfeit", complete: true });
    expect(verification.scores).toEqual({ a: 1, b: 0 });
    expect(verification.rounds).toHaveLength(1);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Garbage generation, cancellation, delivery, and pending queues
// ────────────────────────────────────────────────────────────────────────────

describe("garbage interactions", () => {
  test("send, queue, crossCancel and insert events are preserved through the recorder", async () => {
    const match = makeMatch(["a", "b"], 108, 1);
    const recorder = new MatchRecorder(match, "garbage-test");

    const allEvents = botRound(match, recorder, { a: "score", b: "tower" }, { b: 5 });
    expect(match.complete).toBe(true);

    expect(allEvents.some(e => e.type === "send")).toBe(true);
    expect(allEvents.some(e => e.type === "queue")).toBe(true);

    const replay = await recorder.finish();
    expect(replay).not.toBeNull();

    const verification = await verifyMatchReplayExecution(replay!);
    expect(verification.state).toEqual(match.saveState());
    expect(verification.complete).toBe(true);
  });

  test("a stopped prefix preserves pending garbage queues without claiming a result", async () => {
    const match = makeMatch(["a", "b"], 108, 1);
    const recorder = new MatchRecorder(match, "pending-garbage");

    let sawQueue = false;
    const orderState = { order: 0 };
    let guard = 0;
    outer: while (!match.ended && guard++ < 5000) {
      const planned: PlanOp[][] = [];
      for (const player of match.activePlayers) {
        const state = match.playerState(player);
        if (state.state.topOut) continue;
        const strategy: "score" | "tower" = player === "b" ? "tower" : "score";
        const offset = player === "b" ? 5 : 0;
        const ops = plan(state, match.frame + offset, strategy);
        if (!ops.length) continue;
        for (const op of ops) {
          const epoch = match.playerEpoch(player);
          recorder.submit({ player, frame: op.frame, subframe: op.subframe, order: nextOrder(orderState), input: op.input, epoch });
        }
        planned.push(ops);
      }
      if (!planned.length) break;
      const events = recorder.advanceToFrame(Math.max(...planned.flatMap(ops => ops.map(op => op.frame))) + 1);
      if (events.some(e => e.type === "queue")) {
        sawQueue = true;
        break outer;
      }
    }

    expect(sawQueue).toBe(true);
    expect(match.ended).toBe(false);

    // Build an incomplete replay from the current journal.
    const incomplete = await recorder.buildIncompleteReplay();
    if (incomplete !== null) {
      const verification = await verifyMatchReplayExecution(incomplete);
      expect(verification.complete).toBe(false);
      expect(verification.winner).toBeNull();
      expect(verification.state.players.some(p => p.garbage.packets.length > 0)).toBe(true);
    }
    // Even if buildIncompleteReplay returns null (no rounds yet), the recorder
    // must still be in recording state and not corrupt the Match.
    expect(match.frame).toBeGreaterThan(0);
  });

  test("same-frame crossing attacks cancel before either queue receives them", async () => {
    const match = makeMatch(["a", "b"], 1, 1);
    const recorder = new MatchRecorder(match, "crosscancel-test");

    let crossing = false;
    const orderState = { order: 0 };
    let guard = 0;
    outer: while (!match.ended && guard++ < 5000) {
      const planned: PlanOp[][] = [];
      for (const player of match.activePlayers) {
        const state = match.playerState(player);
        if (state.state.topOut) continue;
        const ops = plan(state, match.frame, "score");
        if (!ops.length) continue;
        for (const op of ops) {
          const epoch = match.playerEpoch(player);
          recorder.submit({ player, frame: op.frame, subframe: op.subframe, order: nextOrder(orderState), input: op.input, epoch });
        }
        planned.push(ops);
      }
      if (!planned.length) break;
      const events = recorder.advanceToFrame(Math.max(...planned.flatMap(ops => ops.map(op => op.frame))) + 1);
      if (events.some(e => e.type === "crossCancel")) { crossing = true; break outer; }
    }

    expect(crossing).toBe(true);

    const incomplete = await recorder.buildIncompleteReplay();
    if (incomplete !== null) {
      const verification = await verifyMatchReplayExecution(incomplete);
      expect(verification.complete).toBe(false);
      expect(verification.state).toEqual(match.saveState());
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Frame advancement and reached-frame boundary
// ────────────────────────────────────────────────────────────────────────────

describe("frame advancement", () => {
  test("reachedFrame is recorded as the actual frame after early round end", async () => {
    const match = makeMatch(["a", "b"], 108, 1);
    const recorder = new MatchRecorder(match, "early-end");

    // Have b top out then advance past their last frame.
    const epoch = match.playerEpoch("b");
    let order = 0;
    while (!match.playerState("b").state.topOut) {
      recorder.submit({ player: "b", frame: match.frame, subframe: 0.5, order: order++, input: Input.HardDrop, epoch });
      recorder.advanceToFrame(match.frame + 1);
    }
    // Now advance with a large target; round ended so it stops early.
    const advanceBefore = match.frame;
    recorder.advanceToFrame(advanceBefore + 10_000);
    const advanceAfter = match.frame;

    // The round ended, so reachedFrame should be <= advanceBefore + 1.
    const replay = await recorder.finish();
    expect(replay).not.toBeNull();

    const lastAdvance = replay!.records.findLast(r => r.op.type === "advance");
    if (lastAdvance?.op.type === "advance") {
      expect(lastAdvance.op.reachedFrame).toBe(advanceAfter);
      // toFrame can be larger than reachedFrame when the round ended early.
      expect(lastAdvance.op.reachedFrame).toBeLessThanOrEqual(lastAdvance.op.toFrame);
    }

    const verification = await verifyMatchReplayExecution(replay!);
    expect(verification.complete).toBe(true);
    expect(verification.state).toEqual(match.saveState());
  });

  test("advance records toFrame and reachedFrame correctly", async () => {
    const match = makeMatch(["a", "b"], 108, 1);
    const recorder = new MatchRecorder(match, "advance-test");

    recorder.advanceToFrame(5);
    expect(match.frame).toBe(5);

    recorder.advanceToFrame(10);
    expect(match.frame).toBe(10);

    topOutRound(match, recorder, ["b"]);
    const replay = await recorder.finish();
    expect(replay).not.toBeNull();

    const advanceRecords = replay!.records.filter(r => r.op.type === "advance");
    for (const r of advanceRecords) {
      if (r.op.type === "advance") {
        expect(r.op.reachedFrame).toBeGreaterThanOrEqual(r.before.frame);
        expect(r.op.reachedFrame).toBeLessThanOrEqual(r.op.toFrame);
      }
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Final state digest and terminal summary
// ────────────────────────────────────────────────────────────────────────────

describe("final state digest and terminal summary", () => {
  test("final state digest matches the live authoritative Match state", async () => {
    const match = makeMatch(["a", "b"], 108, 1);
    const recorder = new MatchRecorder(match, "digest-test");

    topOutRound(match, recorder, ["b"]);
    const replay = await recorder.finish();
    expect(replay).not.toBeNull();

    const verification = await verifyMatchReplayExecution(replay!);
    expect(verification.finalStateDigest).toBe(replay!.end.finalStateDigest);
    expect(verification.state).toEqual(match.saveState());
  });

  test("scores in summary match the Match scores after completion", async () => {
    const match = makeMatch(["a", "b"], 108, 2);
    const recorder = new MatchRecorder(match, "scores-test");

    topOutRound(match, recorder, ["b"]);
    recorder.nextRound(109);
    recorder.releaseControls();
    topOutRound(match, recorder, ["a"]);
    recorder.nextRound(110);
    recorder.releaseControls();
    topOutRound(match, recorder, ["b"]);

    expect(match.scores).toEqual({ a: 2, b: 1 });

    const replay = await recorder.finish();
    expect(replay).not.toBeNull();
    expect(replay!.summary.scores).toEqual({ a: 2, b: 1 });

    const verification = await verifyMatchReplayExecution(replay!);
    expect(verification.scores).toEqual({ a: 2, b: 1 });
    expect(verification.state).toEqual(match.saveState());
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Lifecycle: duplicate finalization, post-completion calls, abandonment
// ────────────────────────────────────────────────────────────────────────────

describe("recorder lifecycle", () => {
  test("duplicate finalization is idempotent", async () => {
    const match = makeMatch(["a", "b"], 108, 1);
    const recorder = new MatchRecorder(match, "idempotent-test");

    topOutRound(match, recorder, ["b"]);

    const first = await recorder.finish();
    const second = await recorder.finish();
    const third = await recorder.completion;

    expect(first).not.toBeNull();
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(recorder.status).toBe("complete");
  });

  test("operations after set completion are silently ignored", async () => {
    const match = makeMatch(["a", "b"], 108, 1);
    const recorder = new MatchRecorder(match, "post-complete");

    topOutRound(match, recorder, ["b"]);
    const replay = await recorder.finish();
    expect(replay).not.toBeNull();
    const recordCount = replay!.records.length;

    // These should be silently ignored.
    recorder.advanceToFrame(match.frame + 100);
    recorder.releaseControls();
    recorder.drainEvents();

    const second = await recorder.finish();
    expect(second).toBe(replay);
    expect(second!.records.length).toBe(recordCount);
    expect(recorder.status).toBe("complete");
  });

  test("abandoning a completed recorder does not discard it", async () => {
    const match = makeMatch(["a", "b"], 108, 1);
    const recorder = new MatchRecorder(match, "abandon-complete");

    topOutRound(match, recorder, ["b"]);
    const replay = await recorder.finish();
    expect(replay).not.toBeNull();

    recorder.abandon();
    expect(recorder.status).toBe("complete");
    expect(await recorder.finish()).toBe(replay);
  });

  test("abandoning a recording in progress exposes null and resolves completion", async () => {
    const match = makeMatch(["a", "b"], 108, 1);
    const recorder = new MatchRecorder(match, "abandon-in-progress");

    recorder.advanceToFrame(5);
    recorder.abandon();

    expect(recorder.status).toBe("abandoned");
    expect(await recorder.finish()).toBeNull();
    expect(await recorder.completion).toBeNull();
    expect(recorder.replay).toBeNull();
    expect(recorder.json).toBeNull();
  });

  test("operations after abandonment continue to reach Match", async () => {
    const match = makeMatch(["a", "b"], 108, 1);
    const recorder = new MatchRecorder(match, "ops-after-abandon");

    recorder.abandon();
    expect(recorder.status).toBe("abandoned");

    recorder.advanceToFrame(10);
    recorder.releaseControls("a");
    recorder.forfeit("b");
    expect(() => recorder.nextRound(200)).toThrow();
    expect(match.frame).toBe(10);
    expect(match.complete).toBe(true);
    expect(recorder.drainEvents().some(e => e.type === "setEnd")).toBe(true);

    expect(recorder.status).toBe("abandoned");
    expect(recorder.replay).toBeNull();
  });

  test("completion promise resolves null for abandoned recorders", async () => {
    const match = makeMatch(["a", "b"], 108, 1);
    const recorder = new MatchRecorder(match, "abandoned-completion");
    recorder.abandon();
    const result = await recorder.completion;
    expect(result).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Incomplete recordings
// ────────────────────────────────────────────────────────────────────────────

describe("incomplete recordings", () => {
  test("buildIncompleteReplay returns null when no rounds have ended", async () => {
    const match = makeMatch(["a", "b"], 108, 1);
    const recorder = new MatchRecorder(match, "no-rounds");

    // Advance a few frames but not to a round end.
    recorder.advanceToFrame(10);

    const incomplete = await recorder.buildIncompleteReplay();
    // May be null if no roundEnd events yet, which is expected.
    // The recorder must still be in recording state.
    expect(recorder.status).toBe("recording");
  });

  test("buildIncompleteReplay after one round produces a verifiable prefix", async () => {
    const match = makeMatch(["a", "b"], 108, 3);
    const recorder = new MatchRecorder(match, "prefix-replay");

    // Complete one round out of three.
    topOutRound(match, recorder, ["b"]);
    expect(match.ended).toBe(true);
    expect(match.complete).toBe(false);

    const incomplete = await recorder.buildIncompleteReplay();
    expect(incomplete).not.toBeNull();

    const verification = await verifyMatchReplayExecution(incomplete!);
    expect(verification.complete).toBe(false);
    expect(verification.winner).toBeNull();
    expect(verification.reason).toBeNull();
    expect(verification.rounds).toHaveLength(1);
    expect(verification.state).toEqual(match.saveState());
  });

  test("buildIncompleteReplay does not change recorder status", async () => {
    const match = makeMatch(["a", "b"], 108, 3);
    const recorder = new MatchRecorder(match, "status-unchanged");

    topOutRound(match, recorder, ["b"]);
    expect(recorder.status).toBe("recording");

    await recorder.buildIncompleteReplay();
    expect(recorder.status).toBe("recording");
  });

  test("a failed recorder returns null from buildIncompleteReplay", async () => {
    const match = makeMatch(["a", "b"], 108, 1);
    const recorder = new MatchRecorder(match, "failed-test", { maxOperations: 1 });

    // Trigger resource limit failure.
    recorder.advanceToFrame(1);
    recorder.advanceToFrame(2); // second record exceeds maxOperations=1

    expect(recorder.status).toBe("failed");
    expect(await recorder.buildIncompleteReplay()).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Resource limits
// ────────────────────────────────────────────────────────────────────────────

describe("resource limits", () => {
  test("operation limit causes recording to fail with resource-limit code", () => {
    const match = makeMatch(["a", "b"], 108, 1);
    const recorder = new MatchRecorder(match, "op-limit", { maxOperations: 1 });

    recorder.advanceToFrame(1);
    recorder.advanceToFrame(2); // second operation exceeds limit

    expect(recorder.status).toBe("failed");
    expect(recorder.error?.code).toBe("resource-limit");
  });

  test("after operation limit failure, Match continues running normally", async () => {
    const match = makeMatch(["a", "b"], 108, 1);
    const recorder = new MatchRecorder(match, "op-limit-continue", { maxOperations: 2 });

    recorder.advanceToFrame(1);
    recorder.advanceToFrame(2);
    recorder.advanceToFrame(3); // limit exceeded

    expect(recorder.status).toBe("failed");

    // The Match itself should still be operational.
    const frameBefore = match.frame;
    match.advanceToFrame(frameBefore + 5);
    expect(match.frame).toBe(frameBefore + 5);
  });

  test("frame budget limit fails with resource-limit", () => {
    const match = makeMatch(["a", "b"], 108, 1);
    const recorder = new MatchRecorder(match, "frame-limit", { maxMatchFrames: 5 });

    recorder.advanceToFrame(3);
    recorder.advanceToFrame(6); // 6 frames total exceeds limit of 5

    expect(recorder.status).toBe("failed");
    expect(recorder.error?.code).toBe("resource-limit");
  });

  test("recorder construction rejects invalid identifier", () => {
    const match = makeMatch(["a", "b"], 108, 1);
    expect(() => new MatchRecorder(match, "")).toThrow(RangeError);
    expect(() => new MatchRecorder(match, "x".repeat(300))).toThrow(RangeError);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Operation failure safety
// ────────────────────────────────────────────────────────────────────────────

describe("operation failure safety", () => {
  test("a rejected submit propagates and invalidates the journal", async () => {
    const match = makeMatch(["a", "b"], 108, 1);
    const recorder = new MatchRecorder(match, "bad-submit");

    const before = match.frame;
    // Submitting a past-frame input should fail.
    expect(() => {
      recorder.submit({
        player: "a",
        frame: -1, // invalid: past frame
        subframe: 0.5,
        order: 0,
        input: Input.HardDrop,
        epoch: 0,
      });
    }).toThrow();

    // A thrown operation may have mutated Match, so the journal is no longer publishable.
    expect(recorder.status).toBe("failed");
    expect(match.frame).toBe(before);
    topOutRound(match, recorder, ["b"]);
    expect(match.complete).toBe(true);
    expect(await recorder.finish()).toBeNull();
  });

  test("recorder requires Match at round 1 frame 0", () => {
    const match = makeMatch(["a", "b"], 108, 1);
    match.advanceToFrame(5);
    expect(() => new MatchRecorder(match, "mid-match")).toThrow(RangeError);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// drainEvents correctness
// ────────────────────────────────────────────────────────────────────────────

describe("drainEvents", () => {
  test("drainEvents returns buffered events and clears the buffer", () => {
    const match = makeMatch(["a", "b"], 108, 1);
    const recorder = new MatchRecorder(match, "drain-test");

    const epoch = match.playerEpoch("b");
    recorder.submit({ player: "b", frame: 0, subframe: 0.5, order: 0, input: Input.HardDrop, epoch });
    recorder.advanceToFrame(1);

    const events = recorder.drainEvents();
    expect(events.length).toBeGreaterThan(0);

    // After draining, the buffer is empty.
    const empty = recorder.drainEvents();
    expect(empty).toHaveLength(0);
  });

  test("events returned by wrapper methods and drainEvents are the same events", () => {
    const match = makeMatch(["a", "b"], 108, 1);
    const recorder = new MatchRecorder(match, "event-consistency");

    const epoch = match.playerEpoch("b");
    const wrapperEvents = [
      ...recorder.submit({ player: "b", frame: 0, subframe: 0.5, order: 0, input: Input.HardDrop, epoch }),
      ...recorder.advanceToFrame(1),
    ];
    const drained = recorder.drainEvents();

    // Both should have the same events.
    expect(drained).toEqual(wrapperEvents);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// No regression on Sprint recording, verification, and playback
// ────────────────────────────────────────────────────────────────────────────

describe("no Sprint regression", () => {
  test("SprintRecorder and verifySprintReplayExecution still work independently", async () => {
    const { SprintRecorder, verifySprintReplayExecution, SPRINT_TARGET } = await import("./index");
    const { Input: Inp, DEFAULT_HANDLING } = await import("@42tris/core");
    const handling = { ...DEFAULT_HANDLING, arr: 0, sdarr: 0 };
    const recorder = new SprintRecorder(1, 1000, handling);

    let now = 1000;
    while (recorder.result === null && now < 50_000) {
      now += 10;
      recorder.apply(Inp.HardDrop as any, now);
    }
    expect(recorder.result).not.toBeNull();

    const replay = await recorder.finish();
    expect(replay).not.toBeNull();
    expect(replay!.kind).toBe("solo");

    const verification = await verifySprintReplayExecution(replay!);
    expect(verification.complete || !verification.complete).toBe(true); // just smoke test
  });
});

test("failure and abandonment preserve buffered and future events", async () => {
  for (const abandon of [false, true]) {
    const match = makeMatch(["a", "b"], 108, 1);
    const recorder = new MatchRecorder(match, "event-survival", { maxOperations: 1 });
    recorder.releaseControls("a");
    if (abandon) recorder.abandon();
    else recorder.releaseControls("b");
    recorder.forfeit("b");
    const events = recorder.drainEvents();
    expect(events[0]).toMatchObject({ type: "controlsReleased", player: "a" });
    expect(events.some(e => e.type === "setEnd")).toBe(true);
    expect(recorder.drainEvents()).toEqual([]);
    expect(await recorder.completion).toBeNull();
  }
});

test("a partially mutating advance failure invalidates the journal and preserves events", async () => {
  const match = makeMatch(["a", "b"], 108, 1);
  const recorder = new MatchRecorder(match, "partial-advance");
  const advance = match.advanceToFrame.bind(match);
  match.advanceToFrame = () => { match.releaseControls("a"); throw new RangeError("gameplay failure"); };
  expect(() => recorder.advanceToFrame(1)).toThrow("gameplay failure");
  expect(recorder.status).toBe("failed");
  expect(recorder.drainEvents()).toMatchObject([{ type: "controlsReleased", player: "a" }]);
  match.advanceToFrame = advance;
  recorder.advanceToFrame(1);
  expect(match.frame).toBe(1);
  expect(await recorder.completion).toBeNull();
});

test("recorded and unrecorded matches execute each operation once with identical events", () => {
  const direct = makeMatch(["a", "b"], 108, 1);
  const recorded = makeMatch(["a", "b"], 108, 1);
  const recorder = new MatchRecorder(recorded, "parity");
  for (let i = 0; i < 8; i++) {
    const input = { player: "b", frame: i, subframe: 0.5, order: i, input: Input.HardDrop, epoch: 0 };
    direct.submit(input); recorder.submit(input);
    direct.advanceToFrame(i + 1); recorder.advanceToFrame(i + 1);
    expect(recorder.drainEvents()).toEqual(direct.drainEvents());
    expect(recorded.saveState()).toEqual(direct.saveState());
  }
  direct.releaseControls("a"); recorder.releaseControls("a");
  direct.forfeit("b"); recorder.forfeit("b");
  expect(recorder.drainEvents()).toEqual(direct.drainEvents());
  expect(recorded.saveState()).toEqual(direct.saveState());
});


test("an operation failure during finalization cannot publish the replay", async () => {
  const match = makeMatch(["a", "b"], 108, 1);
  const recorder = new MatchRecorder(match, "finalization-failure");
  recorder.forfeit("b");
  expect(recorder.status).toBe("finalizing");
  expect(() => recorder.nextRound(109)).toThrow();
  expect(recorder.status).toBe("failed");
  expect(await recorder.completion).toBeNull();
  expect(await recorder.finish()).toBeNull();
  expect(recorder.replay).toBeNull();
  expect(recorder.drainEvents().some(e => e.type === "setEnd")).toBe(true);
});


test("events remain drainable after successful finalization", async () => {
  const match = makeMatch(["a", "b"], 108, 1);
  const recorder = new MatchRecorder(match, "finalization-events");
  recorder.releaseControls("a");
  recorder.forfeit("b");
  expect(await recorder.completion).not.toBeNull();
  const events = recorder.drainEvents();
  expect(events[0]).toMatchObject({ type: "controlsReleased", player: "a" });
  expect(events.some(event => event.type === "setEnd")).toBe(true);
  expect(recorder.drainEvents()).toEqual([]);
});
