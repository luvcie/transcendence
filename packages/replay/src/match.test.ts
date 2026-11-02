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
  CURRENT_REPLAY_VERSIONS,
  MATCH_MODE_ID,
  MATCH_MODE_VERSION,
  MAX_MATCH_FRAMES,
  MatchDriver,
  ReplayError,
  SHA256_ALGORITHM,
  computeFinalStateDigest,
  decodeReplay,
  decodeReplayJson,
  decodeReplayWithIntegrity,
  encodeReplay,
  isMatchReplay,
  sealReplay,
  verifyMatchReplayExecution,
  verifyReplayExecution,
  type MatchExecutionVerification,
  type MatchInitial,
  type MatchRecord,
  type MatchReplay,
  type UnsignedMatchReplay,
} from "./index";

const HANDLING: Handling = { das: 1, arr: 1, sddas: 0, sdarr: 0 };

interface Boundary { round: number; frame: number }

/** Drives the real Match and records every external controller call in journal order. */
class Journal {
  readonly match: Match;
  readonly initial: MatchInitial;
  readonly records: MatchRecord[] = [];
  readonly events: MatchEvent[] = [];
  private readonly roundOneSeed: number;
  private nextOrder = 0;

  constructor(options: { players: readonly string[]; seed: number; firstTo: number; width?: number }) {
    const match = new Match({
      players: [...options.players],
      seed: options.seed,
      firstTo: options.firstTo,
      width: options.width,
      handlingByPlayer: Object.fromEntries(options.players.map(player => [player, HANDLING])),
    });
    this.match = match;
    this.roundOneSeed = options.seed;
    this.initial = {
      players: [...match.roster],
      width: match.width,
      seed: options.seed,
      firstTo: match.firstTo,
      handlingByPlayer: Object.fromEntries(match.roster.map(player => [player, { ...match.handlingByPlayer[player] }])),
      mode: "competitive",
      attacksEnabled: true,
      lockProfile: LEAGUE_LOCK,
    };
  }

  get frame(): number { return this.match.frame; }

  submit(player: string, input: InputId, frame = this.match.frame, subframe = 0.5): void {
    const before = this.boundary();
    const order = this.nextOrder++;
    const epoch = this.match.playerEpoch(player);
    this.match.submit({ player, frame, subframe, order, input, epoch });
    this.records.push({
      seq: this.records.length,
      before,
      op: { type: "submit", input: { player, frame, subframe, order, input, epoch } },
    });
    this.drain();
  }

  advance(toFrame: number): void {
    const before = this.boundary();
    this.match.advanceToFrame(toFrame);
    this.records.push({
      seq: this.records.length,
      before,
      op: { type: "advance", toFrame, reachedFrame: this.match.frame },
    });
    this.drain();
  }

  release(player?: string): void {
    const before = this.boundary();
    this.match.releaseControls(player);
    this.records.push({
      seq: this.records.length,
      before,
      op: player === undefined ? { type: "release" } : { type: "release", player },
    });
    this.drain();
  }

  forfeit(player: string): void {
    const before = this.boundary();
    this.match.forfeit(player);
    this.records.push({ seq: this.records.length, before, op: { type: "forfeit", player } });
    this.drain();
  }

  nextRound(seed: number): void {
    const before = this.boundary();
    this.match.nextRound(seed);
    this.records.push({ seq: this.records.length, before, op: { type: "nextRound", seed } });
    this.drain();
  }

  async payload(status?: "complete" | "stopped" | "incomplete"): Promise<UnsignedMatchReplay> {
    const state = this.match.saveState();
    const setEnd = this.events.findLast(event => event.type === "setEnd");
    const rounds = this.events.flatMap(event => event.type === "roundEnd" ? [{
      round: event.round,
      frame: Math.round(event.atMs / FRAME_MS),
      winner: event.winner,
      complete: event.complete,
      reason: event.reason,
    }] : []);
    return {
      versions: CURRENT_REPLAY_VERSIONS,
      id: `match-${this.roundOneSeed}-${this.records.length}`,
      kind: "match",
      mode: { id: MATCH_MODE_ID, version: MATCH_MODE_VERSION,
        config: { attacksEnabled: true, lockProfile: LEAGUE_LOCK } },
      initial: structuredClone(this.initial),
      records: structuredClone(this.records),
      end: {
        round: state.round,
        frame: state.frame,
        afterSeq: this.records.length - 1,
        status: status ?? (state.complete ? "complete" : "stopped"),
        reason: state.complete ? "set complete" : "stopped",
        finalStateDigest: await computeFinalStateDigest(state),
      },
      summary: {
        scores: { ...this.match.scores },
        winner: setEnd?.winner ?? null,
        reason: setEnd?.reason ?? "aborted",
        rounds,
      },
    };
  }

  private boundary(): Boundary {
    return { round: this.match.round, frame: this.match.frame };
  }

  private drain(): void {
    this.events.push(...this.match.drainEvents());
  }
}

function topOutRound(journal: Journal, losers: readonly string[], maxFrames = 2000): void {
  let guard = 0;
  while (!journal.match.ended && guard++ < maxFrames) {
    const frame = journal.match.frame;
    for (const player of losers) {
      if (!journal.match.activePlayers.includes(player) || journal.match.playerState(player).state.topOut) continue;
      journal.submit(player, Input.HardDrop, frame, 0.5);
    }
    journal.advance(frame + 1);
  }
  if (!journal.match.ended) throw new Error("Top-out fixture did not end the round");
}

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
      let holes = 0;
      let aggregate = 0;
      let bumpiness = 0;
      const heights: number[] = [];
      for (let xx = 0; xx < width; xx++) {
        let height = 0;
        let seen = false;
        for (let yy = 0; yy < ROWS; yy++) {
          if (after[yy * width + xx] !== 0) {
            if (!seen) { height = ROWS - yy; seen = true; }
          } else if (seen) holes++;
        }
        heights.push(height);
        aggregate += height;
      }
      for (let index = 1; index < width; index++) bumpiness += Math.abs(heights[index] - heights[index - 1]);
      const score = strategy === "score"
        ? rows.length * 10000 - holes * 500 - aggregate * 5 - bumpiness * 10 - Math.max(...heights) * 20
        : -aggregate * 100 - holes * 10 + x;
      result.push({ rot, x, score });
    }
  }
  return result.sort((left, right) => right.score - left.score || left.x - right.x || left.rot - right.rot);
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
  for (let rotation = 0; rotation < target.rot; rotation++) ops.push({ input: Input.RotateCw, ...at() });
  const delta = target.x - state.state.x;
  for (let step = 0; step < Math.abs(delta); step++) {
    const right = delta > 0;
    ops.push({ input: right ? Input.RightDown : Input.LeftDown, ...at() });
    ops.push({ input: right ? Input.RightUp : Input.LeftUp, ...at() });
  }
  ops.push({ input: Input.HardDrop, ...at() });
  return ops;
}

function botRound(
  journal: Journal,
  strategies: Readonly<Record<string, "score" | "tower">>,
  offsets: Readonly<Record<string, number>> = {},
  stop: (journal: Journal) => boolean = () => false,
  maxFrames = 5000,
): void {
  let guard = 0;
  while (!journal.match.ended && !journal.match.complete && journal.match.frame < maxFrames
    && !stop(journal) && guard++ < 5000) {
    const planned: PlanOp[][] = [];
    for (const player of journal.match.activePlayers) {
      const state = journal.match.playerState(player);
      if (state.state.topOut) continue;
      const ops = plan(state, journal.match.frame + (offsets[player] ?? 0), strategies[player] ?? "score");
      if (!ops.length) continue;
      for (const op of ops) journal.submit(player, op.input, op.frame, op.subframe);
      planned.push(ops);
    }
    if (!planned.length) break;
    journal.advance(Math.max(...planned.flatMap(ops => ops.map(op => op.frame))) + 1);
  }
}

async function sealed(payload: UnsignedMatchReplay): Promise<MatchReplay> {
  const decoded = await decodeReplayJson(encodeReplay(await sealReplay(payload)));
  if (!isMatchReplay(decoded)) throw new Error("Expected a Match replay");
  return decoded;
}

async function resealed(payload: UnsignedMatchReplay): Promise<MatchReplay> {
  const decoded = await decodeReplayWithIntegrity(await sealReplay(payload));
  if (!isMatchReplay(decoded)) throw new Error("Expected a Match replay");
  return decoded;
}

function withIntegrity(payload: UnsignedMatchReplay) {
  return { ...payload, integrity: { algorithm: SHA256_ALGORITHM, digest: "0".repeat(64) } };
}

function expectCode(fn: () => unknown, code: ReplayError["code"], label?: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ReplayError);
    expect((error as ReplayError).code).toBe(code);
    return;
  }
  throw new Error(`Expected ReplayError ${code}${label ? ` for ${label}` : ""}`);
}

async function expectRejects(fn: () => Promise<unknown>, code: ReplayError["code"], label?: string): Promise<void> {
  try {
    await fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ReplayError);
    expect((error as ReplayError).code).toBe(code);
    return;
  }
  throw new Error(`Expected ReplayError ${code}${label ? ` for ${label}` : ""}`);
}

function execute(initial: MatchInitial, records: readonly MatchRecord[], chunk?: number): { state: unknown; events: MatchEvent[] } {
  const driver = new MatchDriver(initial);
  const events: MatchEvent[] = [];
  for (const record of records) {
    events.push(...driver.apply(record, chunk));
    while (driver.hasPendingAdvance) events.push(...driver.advance(chunk));
  }
  return { state: driver.state, events };
}

let completedCache: Promise<{ payload: UnsignedMatchReplay; replay: MatchReplay; verification: MatchExecutionVerification }> | null = null;
function completed() {
  if (!completedCache) {
    completedCache = (async () => {
      const journal = new Journal({ players: ["a", "b"], seed: 108, firstTo: 1 });
      topOutRound(journal, ["b"]);
      const payload = await journal.payload();
      const replay = await sealed(payload);
      const verification = await verifyMatchReplayExecution(replay);
      return { payload, replay, verification };
    })();
  }
  return completedCache;
}

describe("competitive Match reconstruction", () => {
  test("a complete 1v1 round reconstructs every board, result and digest", async () => {
    const journal = new Journal({ players: ["a", "b"], seed: 108, firstTo: 1 });
    topOutRound(journal, ["b"]);
    expect(journal.match.complete).toBe(true);
    expect(journal.events.some(event => event.type === "eliminated" && event.player === "b")).toBe(true);

    const payload = await journal.payload();
    const replay = await sealed(payload);
    const verification = await verifyMatchReplayExecution(replay);
    expect(verification.complete).toBe(true);
    expect(verification.winner).toBe("a");
    expect(verification.reason).toBe("firstTo");
    expect(verification.scores).toEqual({ a: 1, b: 0 });
    expect(verification.state).toEqual(journal.match.saveState());
    expect(verification.rounds).toHaveLength(1);
    expect(verification.rounds[0]).toMatchObject({ round: 1, winner: "a", complete: true, reason: "survivor" });
    expect(verification.finalStateDigest).toBe(payload.end.finalStateDigest);
    expect((await verifyReplayExecution(replay)).complete).toBe(true);
  });

  test("multiple rounds and set completion reconstruct next-round boundaries and scores", async () => {
    const journal = new Journal({ players: ["a", "b"], seed: 108, firstTo: 2 });
    topOutRound(journal, ["b"]);
    journal.nextRound(109);
    for (const player of journal.match.roster) journal.release(player);
    topOutRound(journal, ["a"]);
    journal.nextRound(110);
    for (const player of journal.match.roster) journal.release(player);
    topOutRound(journal, ["b"]);
    expect(journal.match.complete).toBe(true);
    expect(journal.match.scores).toEqual({ a: 2, b: 1 });

    const payload = await journal.payload();
    const reconstructed = execute(journal.initial, journal.records);
    expect(reconstructed.state).toEqual(journal.match.saveState());
    expect(reconstructed.events).toEqual(journal.events);
    expect(execute(journal.initial, journal.records, 1)).toEqual(reconstructed);

    const verification = await verifyMatchReplayExecution(await sealed(payload));
    expect(verification.rounds.map(round => [round.round, round.winner, round.complete])).toEqual([
      [1, "a", false],
      [2, "b", false],
      [3, "a", true],
    ]);
    expect(verification.reason).toBe("firstTo");
    expect(verification.state.round).toBe(3);
    const transitions = journal.records.filter(record => record.op.type === "nextRound");
    expect(transitions.map(record => record.before.round)).toEqual([1, 2]);
    expect(journal.records.filter(record => record.op.type === "advance" && record.before.frame === 0)).toHaveLength(3);
  });

  test("three players reconstruct simultaneous top-outs and a single survivor", async () => {
    const journal = new Journal({ players: ["a", "b", "c"], seed: 7, firstTo: 1 });
    topOutRound(journal, ["b", "c"]);
    expect(journal.match.complete).toBe(true);
    const eliminated = journal.events.filter(event => event.type === "eliminated");
    expect(eliminated.map(event => event.player).sort()).toEqual(["b", "c"]);
    expect(eliminated.every(event => event.atMs === eliminated[0].atMs)).toBe(true);

    const verification = await verifyMatchReplayExecution(await sealed(await journal.payload()));
    expect(verification.winner).toBe("a");
    expect(verification.scores).toEqual({ a: 1, b: 0, c: 0 });
    expect(verification.state).toEqual(journal.match.saveState());
  });

  test("eight players fully reconstruct all seats and the surviving winner", async () => {
    const players = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const journal = new Journal({ players, seed: 42, firstTo: 1 });
    topOutRound(journal, players.slice(1));
    expect(journal.match.complete).toBe(true);

    const payload = await journal.payload();
    const replay = await sealed(payload);
    const verification = await verifyMatchReplayExecution(replay);
    expect(verification.state.roster).toEqual(players);
    expect(verification.state.players).toHaveLength(8);
    expect(verification.winner).toBe("a");
    expect(verification.scores).toEqual(Object.fromEntries(players.map(player => [player, player === "a" ? 1 : 0])));
    expect(verification.state).toEqual(journal.match.saveState());
  });

  test("garbage is generated, queued, cancelled, inserted and reported across both boards", async () => {
    const journal = new Journal({ players: ["a", "b"], seed: 108, firstTo: 1 });
    botRound(journal, { a: "score", b: "tower" }, { b: 5 });
    expect(journal.match.complete).toBe(true);
    for (const type of ["send", "queue", "cancel", "insert"] as const) {
      expect(journal.events.some(event => event.type === type)).toBe(true);
    }

    const payload = await journal.payload();
    const replay = await sealed(payload);
    const verification = await verifyMatchReplayExecution(replay);
    const reconstructed = execute(journal.initial, journal.records);
    expect(reconstructed.state).toEqual(journal.match.saveState());
    expect(reconstructed.events).toEqual(journal.events);
    expect(verification.state).toEqual(journal.match.saveState());
    expect(verification.winner).toBe("a");
    expect(verification.complete).toBe(true);
  });

  test("a stopped prefix preserves pending garbage queues without claiming a result", async () => {
    const journal = new Journal({ players: ["a", "b"], seed: 108, firstTo: 1 });
    botRound(journal, { a: "score", b: "tower" }, { b: 5 },
      current => current.events.some(event => event.type === "queue"));
    expect(journal.events.some(event => event.type === "queue")).toBe(true);
    expect(journal.events.some(event => event.type === "insert")).toBe(false);
    expect(journal.match.ended).toBe(false);

    const payload = await journal.payload("stopped");
    const verification = await verifyMatchReplayExecution(await sealed(payload));
    expect(verification.complete).toBe(false);
    expect(verification.winner).toBeNull();
    expect(verification.reason).toBeNull();
    expect(verification.state).toEqual(journal.match.saveState());
    expect(verification.state.players.some(player => player.garbage.packets.length > 0)).toBe(true);
    expect(verification.finalStateDigest).toBe(payload.end.finalStateDigest);
  });

  test("same-frame crossing attacks cancel before either queue receives them", async () => {
    const journal = new Journal({ players: ["a", "b"], seed: 1, firstTo: 1 });
    botRound(journal, { a: "score", b: "score" }, {},
      current => current.events.some(event => event.type === "crossCancel"));
    const crossing = journal.events.find(event => event.type === "crossCancel");
    expect(crossing).toBeDefined();
    if (crossing?.type !== "crossCancel") throw new Error("Expected a crossing cancellation");
    expect(crossing.lines).toBeGreaterThan(0);

    const verification = await verifyMatchReplayExecution(await sealed(await journal.payload("stopped")));
    expect(verification.complete).toBe(false);
    expect(verification.state).toEqual(journal.match.saveState());
  });

  test("controller releases model pause and reconnect boundaries without advancing the clock", async () => {
    const journal = new Journal({ players: ["a", "b"], seed: 7, firstTo: 1 });
    journal.submit("a", Input.LeftDown, 2, 0.5);
    journal.submit("a", Input.HardDrop, 4, 0.5);
    journal.advance(3);
    const beforeRelease = journal.match.frame;
    journal.release("a");
    expect(journal.match.frame).toBe(beforeRelease);
    expect(journal.match.saveState().inputs).toEqual([]);
    expect(journal.match.playerState("a").state.leftHeld).toBe(false);
    journal.advance(5);
    expect(journal.match.playerState("a").lastResult).toBeNull();

    const verification = await verifyMatchReplayExecution(await sealed(await journal.payload("stopped")));
    expect(verification.complete).toBe(false);
    expect(verification.state).toEqual(journal.match.saveState());
    expect(journal.events.filter(event => event.type === "controlsReleased")).toHaveLength(1);
  });

  test("journal ordering decides same-time input results and reconstruction preserves it", async () => {
    const build = (leftFirst: boolean) => {
      const journal = new Journal({ players: ["a", "b"], seed: 11, firstTo: 1 });
      if (leftFirst) {
        journal.submit("a", Input.LeftDown, 0, 0.5);
        journal.submit("a", Input.HardDrop, 0, 0.5);
      } else {
        journal.submit("a", Input.HardDrop, 0, 0.5);
        journal.submit("a", Input.LeftDown, 0, 0.5);
      }
      journal.advance(1);
      return journal;
    };
    const leftFirst = build(true);
    const dropFirst = build(false);
    expect(leftFirst.records.map(record => record.op.type)).toEqual(["submit", "submit", "advance"]);
    expect(leftFirst.records[0].op.type === "submit" && leftFirst.records[0].op.input.order).toBe(0);
    expect(leftFirst.records[1].op.type === "submit" && leftFirst.records[1].op.input.order).toBe(1);
    expect(execute(leftFirst.initial, leftFirst.records, 1)).toEqual(execute(leftFirst.initial, leftFirst.records));
    expect(leftFirst.match.saveState()).not.toEqual(dropFirst.match.saveState());

    const verification = await verifyMatchReplayExecution(await sealed(await leftFirst.payload("stopped")));
    expect(verification.state).toEqual(leftFirst.match.saveState());
  });

  test("forfeits and aborted sets reconstruct their terminal reasons", async () => {
    const forfeited = new Journal({ players: ["a", "b"], seed: 108, firstTo: 7 });
    forfeited.forfeit("a");
    expect(forfeited.match.complete).toBe(true);
    const forfeitVerification = await verifyMatchReplayExecution(await sealed(await forfeited.payload()));
    expect(forfeitVerification).toMatchObject({ winner: "b", reason: "forfeit", complete: true });
    expect(forfeitVerification.rounds[0]).toMatchObject({ winner: "b", complete: true, reason: "forfeit" });
    expect(forfeitVerification.scores).toEqual({ a: 0, b: 1 });

    const aborted = new Journal({ players: ["a", "b", "c"], seed: 108, firstTo: 3 });
    aborted.forfeit("a");
    aborted.forfeit("b");
    aborted.forfeit("c");
    expect(aborted.match.complete).toBe(true);
    const abortedVerification = await verifyMatchReplayExecution(await sealed(await aborted.payload()));
    expect(abortedVerification).toMatchObject({ winner: null, reason: "aborted", complete: true });
    expect(abortedVerification.scores).toEqual({ a: 0, b: 0, c: 1 });
    expect(abortedVerification.state).toEqual(aborted.match.saveState());
  });

  test("forfeit between rounds completes the set without awarding a second point", async () => {
    const journal = new Journal({ players: ["a", "b"], seed: 108, firstTo: 7 });
    topOutRound(journal, ["b"]);
    expect(journal.match.scores).toEqual({ a: 1, b: 0 });
    journal.forfeit("b");
    expect(journal.match.complete).toBe(true);
    const verification = await verifyMatchReplayExecution(await sealed(await journal.payload()));
    expect(verification).toMatchObject({ winner: "a", reason: "forfeit", complete: true });
    expect(verification.scores).toEqual({ a: 1, b: 0 });
    expect(verification.rounds).toHaveLength(1);
  });
});

describe("competitive Match verification rejection", () => {
  test("rejects modified scores, winners, round summaries and ending reasons with valid checksums", async () => {
    const { payload } = await completed();
    const mutations: [string, (value: Record<string, any>) => void][] = [
      ["winner", value => { value.summary.winner = "b"; }],
      ["score", value => { value.summary.scores.b += 1; }],
      ["round winner", value => { value.summary.rounds[0].winner = "b"; }],
      ["round frame", value => { value.summary.rounds[0].frame += 1; }],
      ["round completion", value => { value.summary.rounds[0].complete = false; }],
      ["round reason", value => { value.summary.rounds[0].reason = "draw"; }],
      ["ending reason", value => { value.summary.reason = "forfeit"; }],
      ["status", value => { value.end.status = "stopped"; }],
      ["aborted claim", value => {
        value.summary.reason = "aborted";
        value.summary.winner = null;
        value.end.status = "stopped";
      }],
    ];
    for (const [name, mutate] of mutations) {
      const changed = structuredClone(payload) as Record<string, any>;
      mutate(changed);
      const replay = await resealed(changed as UnsignedMatchReplay);
      await expectRejects(() => verifyMatchReplayExecution(replay), "simulation-mismatch", name);
    }
  });

  test("rejects an incorrect final-state digest even when every summary field is unchanged", async () => {
    const { payload } = await completed();
    const changed = structuredClone(payload);
    changed.end.finalStateDigest = "0".repeat(64);
    const replay = await resealed(changed);
    await expectRejects(() => verifyMatchReplayExecution(replay), "simulation-mismatch");

    const good = await verifyMatchReplayExecution(await sealed(payload));
    expect(good.finalStateDigest).toBe(payload.end.finalStateDigest);
  });

  test("rejects a valid checksum over a journal whose execution changes the result", async () => {
    const { payload } = await completed();
    const changed = structuredClone(payload);
    const drop = changed.records.find(record => record.op.type === "submit");
    if (drop?.op.type !== "submit") throw new Error("Expected a submit record");
    drop.op.input.input = Input.Hold;
    const replay = await resealed(changed);
    await expectRejects(() => verifyMatchReplayExecution(replay), "simulation-mismatch");
  });

  test("rejects incompatible replay, simulation, core, match and garbage versions", async () => {
    const { payload } = await completed();
    const cases: [string, (value: Record<string, any>) => void][] = [
      ["format", value => { value.versions.format = 2; }],
      ["simulation", value => { value.versions.simulation = "42tris-replay-sim-v1"; }],
      ["core state", value => { value.versions.coreState -= 1; }],
      ["core rules", value => { value.versions.coreRules = "other-rules"; }],
      ["match state", value => { value.versions.matchState -= 1; }],
      ["garbage", value => { value.versions.garbage = "other-garbage"; }],
    ];
    for (const [name, mutate] of cases) {
      const changed = structuredClone(withIntegrity(payload)) as Record<string, any>;
      mutate(changed);
      expectCode(() => decodeReplay(changed), "unsupported", name);
    }
    for (const [name, mutate] of [
      ["round reason", (value: Record<string, any>) => { value.summary.rounds[0].reason = "unknown"; }],
      ["operation", (value: Record<string, any>) => {
        value.records[0].op = { type: "practiceUndo", player: "a" };
      }],
    ] as const) {
      const changed = structuredClone(withIntegrity(payload)) as Record<string, any>;
      mutate(changed);
      expectCode(() => decodeReplay(changed), "malformed", name);
    }
  });

  test("rejects practice mode at decode, driver and execution layers", async () => {
    const { payload } = await completed();
    for (const [name, mutate] of [
      ["initial mode", (value: Record<string, any>) => { value.initial.mode = "practice"; }],
      ["mode id", (value: Record<string, any>) => { value.mode.id = "42tris-practice"; }],
    ] as const) {
      const changed = structuredClone(withIntegrity(payload)) as Record<string, any>;
      mutate(changed);
      expectCode(() => decodeReplay(changed), "unsupported", name);
    }
    expect(() => new MatchDriver({ ...payload.initial, mode: "practice" } as unknown as MatchInitial)).toThrow();

    const forged = structuredClone(await sealed(payload));
    (forged.initial as { mode: string }).mode = "practice";
    await expectRejects(() => verifyMatchReplayExecution(forged), "unsupported");
  });

  test("rejects a completed set presented as stopped and an incomplete prefix claiming a winner", async () => {
    const { payload } = await completed();
    const stopped = structuredClone(payload);
    stopped.end.status = "stopped";
    await expectRejects(async () => verifyMatchReplayExecution(await resealed(stopped)), "simulation-mismatch");

    const prefix = new Journal({ players: ["a", "b"], seed: 108, firstTo: 1 });
    prefix.advance(1);
    const claimed = await prefix.payload("stopped");
    claimed.summary = { scores: { a: 0, b: 0 }, winner: "a", reason: "firstTo", rounds: [] };
    await expectRejects(async () => verifyMatchReplayExecution(await resealed(claimed)), "simulation-mismatch");
  });

  test("omitting optional round reasons keeps older v1 summaries valid", async () => {
    const { payload } = await completed();
    const legacy = structuredClone(payload);
    for (const round of legacy.summary.rounds) delete round.reason;
    const replay = await resealed(legacy);
    const verification = await verifyMatchReplayExecution(replay);
    expect(replay.summary.rounds[0].reason).toBeUndefined();
    expect(verification.rounds[0].reason).toBe("survivor");
  });

  test("never returns a partial verification for a journal that fails during execution", async () => {
    const journal = new Journal({ players: ["a", "b"], seed: 108, firstTo: 1 });
    journal.advance(2);
    const payload = await journal.payload("stopped");
    payload.records.push({
      seq: payload.records.length,
      before: { round: 1, frame: 2 },
      op: { type: "submit", input: { player: "a", frame: 1, subframe: 0.5, order: 99, input: Input.HardDrop, epoch: 0 } },
    });
    payload.end.afterSeq = payload.records.length - 1;
    // The decoder rejects the late input before execution; a directly forged driver run
    // must still fail closed rather than return the prefix state.
    expectCode(() => decodeReplay(withIntegrity(payload)), "malformed");
    const driver = new MatchDriver(journal.initial);
    for (const record of journal.records) driver.apply(record);
    expect(() => driver.apply(payload.records[payload.records.length - 1])).toThrow();
  });
});

describe("Match execution determinism", () => {
  test("the final digest and events are independent of execution chunking", async () => {
    const journal = new Journal({ players: ["a", "b"], seed: 108, firstTo: 1 });
    topOutRound(journal, ["b"]);
    const full = execute(journal.initial, journal.records);
    const chunked = execute(journal.initial, journal.records, 1);
    expect(chunked).toEqual(full);
    expect(await computeFinalStateDigest(full.state)).toBe(await computeFinalStateDigest(journal.match.saveState()));
  });

  test("a forged small reachedFrame cannot force work past the global frame budget", () => {
    const journal = new Journal({ players: ["a", "b"], seed: 108, firstTo: 1 });
    const driver = new MatchDriver(journal.initial);
    Object.assign(driver, { frames: MAX_MATCH_FRAMES - 2 });
    const record: MatchRecord = {
      seq: 0,
      before: { round: 1, frame: 0 },
      op: { type: "advance", toFrame: MAX_MATCH_FRAMES, reachedFrame: 2 },
    };
    expect(() => driver.apply(record, 3)).toThrow(/frame budget/i);
    expect(driver.state.frame).toBe(2);
  });

  test("an ended round may stop a large requested advance without exceeding the work budget", async () => {
    const journal = new Journal({ players: ["a", "b"], seed: 108, firstTo: 1 });
    topOutRound(journal, ["b"]);
    const payload = await journal.payload();
    const last = payload.records.at(-1);
    if (last?.op.type !== "advance") throw new Error("Expected a final advance record");
    expect(last.before.frame).toBeGreaterThan(0);
    last.op.toFrame = MAX_MATCH_FRAMES;
    const replay = await resealed(payload);
    const verification = await verifyMatchReplayExecution(replay);
    expect(verification.complete).toBe(true);
    expect(verification.finalStateDigest).toBe(payload.end.finalStateDigest);
    expect(execute(journal.initial, replay.records, 5).state).toEqual(journal.match.saveState());
  });
});
