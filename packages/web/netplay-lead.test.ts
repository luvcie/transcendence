import { describe, expect, test } from "bun:test";
import { FRAME_MS, GARBAGE, Input, Piece, type GameState } from "@42tris/core";
import { GARBAGE_DELAY_MS, Match, OwnerPrediction } from "@42tris/match";
import { MAX_INPUT_LEAD_MS } from "@42tris/protocol";
import { CURRENT_REPLAY_VERSIONS, verifyMatchReplayExecution } from "@42tris/replay";
import { leadExperiments, runLeadExperiment } from "./netplay-lead-experiment";
import { NetHarness } from "./netplay-harness";

describe("N3-B deterministic latency experiments", () => {
  test.each(leadExperiments)("$name: real Session timestamps, paced authority and verified replay", async scenario => {
    const { h, result, journal } = await runLeadExperiment(scenario);
    expect(result.durationMs).toBeGreaterThanOrEqual(30_000);
    expect(result.replayVerified).toBe(true);
    expect(result.clockChecks).toBeGreaterThan(1000);
    expect(result.clockViolations).toBe(0);
    expect(journal.versions).toEqual(CURRENT_REPLAY_VERSIONS);
    for (const [index, client] of h.clients.entries()) {
      const measured = result.clients[index];
      expect(measured.whole.total).toBeGreaterThan(30);
      expect(measured.whole.future).toBe(0);
      expect(measured.whole.other).toBe(0);
      expect(measured.lead.appliedMs).toBe(scenario.options.inputLeadMs?.[client.key] ?? 0);
      if (measured.lead.appliedMs > 0 && !scenario.coldClock) {
        expect(measured.whole.acceptedPct).toBe(100);
        expect(measured.resets).toBe(0);
      }
      const fingerprints = new Map<string, string>();
      const stamps = new Map<string, number>();
      for (const batch of client.batches) for (const item of batch.items) {
        const identity = `${batch.matchId}:${batch.generation}:${batch.epoch}`;
        const key = `${identity}:${item.seq}`;
        const fingerprint = JSON.stringify(item);
        if (fingerprints.has(key)) expect(fingerprint).toBe(fingerprints.get(key)!);
        else {
          const at = (item.frame + item.subframe) * FRAME_MS;
          expect(Number.isFinite(at)).toBe(true);
          expect(at).toBeGreaterThanOrEqual(stamps.get(identity) ?? 0);
          stamps.set(identity, at);
          fingerprints.set(key, fingerprint);
        }
      }
    }
    if (scenario.coldClock) {
      const a = result.clients[0];
      expect(a.calibratedAtStart).toBe(false);
      expect(a.beforePong.total).toBeGreaterThan(0);
      expect(a.beforePong.late).toBeGreaterThan(0);
      expect(a.whole.acceptedPct!).toBeLessThan(100);
      expect(a.afterPong.acceptedPct).toBe(100);
    }
    if (scenario.name === "mixed zero" || scenario.name === "mixed lead") {
      for (const low of result.clients.slice(0, 2)) {
        expect(low.lead.appliedMs).toBe(0);
        expect(low.whole.acceptedPct).toBe(100);
        expect(low.resets).toBe(0);
        expect(low.marginMs.p50).toBeCloseTo(100, 6);
        expect(low.checkpointAgeMs.p50).toBeCloseTo(low.link.down!, 6);
      }
    }
  }, 20_000);

  test("omitted and explicit zero produce identical commands, checkpoints, authority and replay bytes", async () => {
    const omitted = await runLeadExperiment(leadExperiments[0]);
    const zero = await runLeadExperiment(leadExperiments[1]);
    for (const [index, client] of omitted.h.clients.entries()) {
      expect(client.commands).toEqual(zero.h.clients[index].commands);
      expect(client.session.checkpoint).toEqual(zero.h.clients[index].session.checkpoint);
      expect(client.diagnostics!.snapshot()).toEqual(zero.h.clients[index].diagnostics!.snapshot());
    }
    expect(omitted.h.room!.match!.saveState()).toEqual(zero.h.room!.match!.saveState());
    expect(omitted.journal).toEqual(zero.journal);
  }, 20_000);
});

test("maximum Session lead queues an action until its recorded authoritative frame without accelerating the clock", async () => {
  const h = new NetHarness({ diagnostics: true, inputLeadMs: { a: MAX_INPUT_LEAD_MS } });
  const control = new NetHarness();
  h.startMatch(); control.startMatch();
  h.press("a", Input.RotateCw);
  const item = h.a.batches[0].items[0];
  const owner = () => h.room!.match!.playerState(h.a.session.playerId);
  h.advance(20); control.advance(20);
  expect(h.aCheckpoint!.owner.pendingAccepted.map(i => i.seq)).toContain(item.seq);
  expect(owner().state.rot).toBe(0);
  expect(h.room!.match!.frame).toBe(control.room!.match!.frame);
  h.runUntil(() => h.room!.match!.frame === item.frame);
  expect(owner().state.rot).toBe(0);
  h.runUntil(() => h.room!.match!.frame > item.frame);
  expect(owner().state.rot).toBe(1);
  const replay = await h.room!.recorder!.buildIncompleteReplay();
  expect(replay!.records.filter(r => r.op.type === "submit").map(r => r.op.type === "submit" ? r.op.input.frame : -1)).toContain(item.frame);
  expect((await verifyMatchReplayExecution(replay!)).state).toEqual(h.room!.match!.saveState());
});

test("a completed competitive set with real positive-lead inputs verifies without a new replay field", async () => {
  const h = new NetHarness({ seed: 47, diagnostics: true, inputLeadMs: { a: 104, b: 120 }, a: { up: 150, down: 150 } });
  h.startMatch({ firstTo: 1 });
  h.press("a", Input.RotateCw);
  h.advance(500);
  h.dropOut("b");
  await h.room!.recorder!.finish();
  const replay = h.rooms.completedReplay(h.room!.code)!;
  expect(replay.end.status).toBe("complete");
  expect(replay.versions).toEqual(CURRENT_REPLAY_VERSIONS);
  expect((await verifyMatchReplayExecution(replay)).state).toEqual(h.room!.match!.saveState());
  expect(JSON.stringify(replay)).not.toMatch(/leadMs|inputLead|requestedMs|appliedMs/);
});

test.each([[20, 180], [180, 20], [150, 150]])("maximum lead stays inside N3-A bounds with an actual %i/%i clock bias", async (up, down) => {
  const h = new NetHarness({ diagnostics: true, inputLeadMs: { a: MAX_INPUT_LEAD_MS }, a: { up, down } });
  h.startMatch();
  h.playScript("a", 2000, 8);
  h.advance(2500);
  expect(h.a.diagnostics!.snapshot().rejections.total).toBe(0);
  expect(h.a.diagnostics!.snapshot().releases.total).toBe(0);
  const replay = await h.room!.recorder!.buildIncompleteReplay();
  expect((await verifyMatchReplayExecution(replay!)).state).toEqual(h.room!.match!.saveState());
});

test("positive lead does not guarantee a timestamp after physical keypress time on an asymmetric path", async () => {
  const h = new NetHarness({ diagnostics: true, inputLeadMs: { a: 44 }, a: { up: 20, down: 180 } });
  h.startMatch();
  const physical = h.time - h.room!.origin! - h.room!.pausedTotal;
  h.press("a", Input.RotateCw);
  const item = h.a.batches[0].items[0];
  expect((item.frame + item.subframe) * FRAME_MS).toBeCloseTo(physical - 36, 6);
  expect(h.a.diagnostics!.snapshot().clock.estimatedOffsetMs).toBeCloseTo(-80, 6);
  h.advance(500);
  expect(h.a.diagnostics!.snapshot().rejections.total).toBe(0);
  const replay = await h.room!.recorder!.buildIncompleteReplay();
  expect((await verifyMatchReplayExecution(replay!)).state).toEqual(h.room!.match!.saveState());
});

function quad(game: GameState, allClear = true) {
  game.board.fill(0);
  Object.assign(game.state, { piece: Piece.I, rot: 1, x: 2, y: 18 });
  for (let y = 36; y < 40; y++) {
    game.board.fill(Piece.L, y * 10, (y + 1) * 10);
    game.board[y * 10 + 4] = 0;
  }
  if (!allClear) game.board[350] = Piece.L;
}

describe("synthetic attack fixtures (not replay fixtures)", () => {
  test.each(["crossing", "cancellation", "eligibility"] as const)("future queued locks preserve %s", scenario => {
    const state = new Match({ players: ["a", "b"], seed: 108 }).saveState();
    quad(state.players[0].game, scenario === "eligibility");
    if (scenario !== "eligibility") quad(state.players[1].game, false);
    const early = Match.fromState(state), onTime = Match.fromState(state);
    const inputs = [
      { player: "a", frame: 10, subframe: 0.25, input: Input.HardDrop, order: 0 },
      { player: "b", frame: scenario === "crossing" ? 10 : scenario === "cancellation" ? 11 : 30,
        subframe: scenario === "crossing" ? 0.75 : scenario === "eligibility" ? 0.25 - 1e-10 : 0, input: Input.HardDrop, order: 1 },
      ...(scenario === "eligibility" ? [{ player: "b", frame: 30, subframe: 0.25, input: Input.HardDrop, order: 2 }] : []),
    ];
    for (const input of inputs) early.submit(input);
    for (let frame = 0; frame <= 32; frame++) {
      for (const input of inputs.filter(i => i.frame === frame)) onTime.submit(input);
      early.advanceToFrame(frame + 1); onTime.advanceToFrame(frame + 1);
    }
    expect(early.saveState()).toEqual(onTime.saveState());
    const events = early.drainEvents();
    expect(events).toEqual(onTime.drainEvents());
    if (scenario === "crossing") expect(events.filter(e => e.type === "crossCancel").map(e => e.lines)).toEqual([4]);
    if (scenario === "cancellation") expect(events.filter(e => e.type === "cancel").map(e => e.lines)).toEqual([4]);
    if (scenario === "eligibility") {
      const inserted = events.filter(e => e.type === "insert");
      expect(inserted.reduce((sum, e) => sum + e.holes.length, 0)).toBe(8);
      expect(inserted.every(e => e.atMs === 30.25 * FRAME_MS)).toBe(true);
      expect(GARBAGE_DELAY_MS).toBe(20 * FRAME_MS);
    }
  });

  test("unknown incoming garbage corrects a led prediction across a piece transition", () => {
    const h = new NetHarness({ diagnostics: true, inputLeadMs: { a: 250 } });
    h.startMatch({ mode: "practice", attacksEnabled: true });
    expect(h.room!.recorder).toBeUndefined();
    const state = h.room!.match!.saveState();
    quad(state.players[state.roster.indexOf(h.b.session.playerId)].game);
    h.room!.match = Match.fromState(state);
    h.advance(100);
    h.holdDownstream("a", 600);
    h.press("b", Input.HardDrop);
    h.runUntil(() => h.room!.match!.saveState().players[0].garbage.packets.length > 0);
    h.advance(100);
    h.press("a", Input.HardDrop);
    h.advance(40);
    h.press("a", Input.Hold);
    const hold = structuredClone(h.a.batches.at(-1)!.items.at(-1)!);
    expect(hold.input).toBe(Input.Hold);
    h.advance(1000);
    const prediction = h.a.session.prediction!;
    const authoritative = new OwnerPrediction(h.aCheckpoint!.state!, h.a.session.playerId);
    authoritative.advanceToTime(prediction.atMs);
    expect(prediction.gameState()).toEqual(authoritative.gameState());
    expect(prediction.gameState().board.some(cell => cell === GARBAGE)).toBe(true);
    expect(h.a.diagnostics!.snapshot().corrections.board).toBeGreaterThan(0);
    expect(h.a.diagnostics!.snapshot().releases.total).toBe(0);
    expect(h.a.diagnostics!.snapshot().rejections.total).toBe(0);
    expect(h.a.batches.flatMap(b => b.items).find(i => i.seq === hold.seq)).toEqual(hold);
  });
});
