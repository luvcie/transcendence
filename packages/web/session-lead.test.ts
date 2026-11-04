import { describe, expect, test } from "bun:test";
import { FRAME_MS, Input } from "@42tris/core";
import { Match } from "@42tris/match";
import { MAX_INPUT_LEAD_MS, type Checkpoint, type ClientCommand } from "@42tris/protocol";
import { Session, normalizeInputLead, type SessionOptions } from "./src/session";
import { SessionDiagnostics } from "./src/session-diagnostics";
import { experimentalInputLead } from "./src/netplay-options";
import { NetHarness } from "./netplay-harness";
import { verifyMatchReplayExecution } from "@42tris/replay";

function clockSession(inputLeadMs?: number, phase: Checkpoint["room"]["phase"] = "playing", frozen = false) {
  let now = 0;
  const sent: ClientCommand[] = [];
  const store = { getItem: () => null, setItem() {}, removeItem() {} };
  const diagnostics = new SessionDiagnostics();
  const options: SessionOptions = { now: () => now, storage: store, profile: store, clearKeys() {}, diagnostics, inputLeadMs,
    schedule: () => () => {}, connect: () => ({ send: command => sent.push(command), close() {} }) };
  const session = new Session(options);
  session.start();
  const welcome = () => session.receive({ type: "welcome", guestSessionId: "a", playerId: "a", resumeToken: "token",
    name: "A", room: null, generation: 0, serverNow: now });
  welcome();
  const cp: Checkpoint = { type: "checkpoint", serverSequence: 1, serverNow: 0, matchId: "match",
    state: new Match({ players: ["a", "b"], seed: 108 }).saveState(),
    room: { code: "ABCDEF", revision: 1, ownerId: "a",
      options: { firstTo: 3, maxPlayers: 4, mode: "competitive", attacksEnabled: true, width: 10 },
      phase, matchId: "match", preparationId: 1, startsAt: null, prepareDeadline: null,
      players: ["a", "b"].map(playerId => ({ playerId, name: playerId, skin: "classic", connected: true,
        ready: true, prepared: true, deadline: null, withdrawn: false })) },
    owner: { generation: 0, epoch: 0, nextSeq: 1, resolvedThroughSeq: 0, pendingAccepted: [], rejections: [] },
    clock: { currentTargetFrame: 0, simulationNow: 0, origin: 0, pausedTotal: 0, commitDelayMs: 100, frozen },
    roundDurations: [], events: [] };
  const initial = diagnostics.snapshot();
  const receive = (change: (cp: Checkpoint) => void = () => {}) => {
    const next = structuredClone(cp);
    next.serverSequence++;
    change(next);
    Object.assign(cp, next);
    session.receive(next);
  };
  session.receive(structuredClone(cp));
  return { session, diagnostics, options, cp, sent, receive, welcome, initial, time: (value: number) => { now = value; } };
}

describe("experimental fixed lead configuration", () => {
  test.each([
    ["", 0], ["lead=104", 0], ["diagnostics", 0], ["diagnostics&lead=0", 0],
    ["diagnostics&lead=104", 104], ["diagnostics=false&lead=104", 104],
    ["diagnostics&lead=250", MAX_INPUT_LEAD_MS], ["diagnostics&lead=0.5", 0.5],
    ...["", "NaN", "Infinity", "-Infinity", "-1", "251", "250.01", "1e2", "0x68", " 104 ", "1ms", ".5", "1.2.3"].map(value =>
      [`diagnostics&lead=${encodeURIComponent(value)}`, 0] as const),
  ] as const)("URL %s yields %i ms", (query, expected) => {
    expect(experimentalInputLead(new URLSearchParams(query))).toBe(expected);
  });

  test("localStorage diagnostics alone cannot authorize lead; first URL value wins", () => {
    const lead = experimentalInputLead(new URLSearchParams("lead=104"));
    expect(clockSession(lead).diagnostics.snapshot().lead).toEqual({ requestedMs: 0, appliedMs: 0 });
    expect(experimentalInputLead(new URLSearchParams("diagnostics&lead=NaN&lead=104"))).toBe(0);
    expect(experimentalInputLead(new URLSearchParams("diagnostics&lead=104&lead=250"))).toBe(104);
  });

  test.each([undefined, NaN, Infinity, -Infinity, -1, MAX_INPUT_LEAD_MS + 1])("Session safely normalizes %s", value => {
    expect(normalizeInputLead(value)).toBe(0);
    const h = clockSession(value);
    h.time(100);
    h.session.input(Input.RotateCw);
    expect(h.session.prediction!.atMs).toBe(100);
    expect(h.diagnostics.snapshot().lead).toEqual({ requestedMs: 0, appliedMs: 0 });
  });
});

describe("lead target and lifecycle", () => {
  test("latches before the first prediction; prospective stamps retain rounding and monotonicity", () => {
    const h = clockSession(104);
    expect(h.initial.lead).toEqual({ requestedMs: 104, appliedMs: 0 });
    expect(h.session.prediction!.atMs).toBe(104);
    expect(h.diagnostics.snapshot().clock).toMatchObject({ calibrated: false, bestRttMs: null, estimatedOffsetMs: 0 });
    h.time(116.9);
    h.session.input(Input.RotateCw);
    const original = structuredClone(h.session.pending[0]);
    expect((original.frame + original.subframe) * FRAME_MS).toBeCloseTo(220.9, 12);
    expect(original.subframe).toBeGreaterThanOrEqual(0);
    expect(original.subframe).toBeLessThan(1);
    h.time(100); // Best-pong clock corrections can move the estimate backwards.
    h.session.tick();
    h.session.input(Input.Hold);
    expect(h.session.prediction!.atMs).toBeCloseTo(220.9, 12);
    expect(h.session.pending[0]).toEqual(original);
    expect(h.session.pending[1].frame).toBeGreaterThanOrEqual(original.frame);
    h.time(1999);
    h.session.tick();
    expect(h.session.prediction!.atMs).toBe(2000);
  });

  test.each(["preparing", "countdown", "paused", "roundResult"] as const)("%s adds no lead or elapsed time", phase => {
    const h = clockSession(250, phase);
    expect(h.session.prediction!.atMs).toBe(0);
    h.time(1000);
    h.receive();
    expect(h.session.prediction!.atMs).toBe(0);
    expect(h.session.canPlay).toBe(false);
  });

  test("a frozen playing clock adds no lead; a pause preserves an advanced prediction without accumulating", () => {
    const frozen = clockSession(250, "playing", true);
    frozen.time(1000);
    frozen.receive();
    expect(frozen.session.prediction!.atMs).toBe(0);
    const h = clockSession(104);
    h.time(50);
    h.session.tick();
    expect(h.session.prediction!.atMs).toBe(154);
    h.receive(cp => { cp.room.phase = "paused"; cp.clock.frozen = true; cp.clock.simulationNow = 50; });
    h.time(1000);
    h.receive();
    expect(h.session.prediction!.atMs).toBe(154);
    h.receive(cp => { cp.room.phase = "playing"; cp.clock.frozen = false; cp.clock.simulationNow = 50; cp.serverNow = 1000; });
    expect(h.session.prediction!.atMs).toBe(154);
    h.time(1010);
    h.session.tick();
    expect(h.session.prediction!.atMs).toBe(164);
  });

  test("construction captures immutable configuration through recovery, new rounds, matches and rooms", () => {
    const h = clockSession(104);
    h.options.inputLeadMs = 250;
    for (const field of ["generation", "epoch", "round", "match", "room"] as const) {
      h.receive(cp => {
        if (field === "generation") cp.owner.generation++;
        if (field === "epoch") { cp.owner.epoch++; cp.state!.players[0].epoch++; }
        if (field === "round") cp.state!.round++;
        if (field === "match") cp.matchId = cp.room.matchId = "next-match";
        if (field === "room") cp.room.code = "NEWROM";
      });
      expect(h.diagnostics.snapshot().lead).toEqual({ requestedMs: 104, appliedMs: 104 });
      expect(h.session.prediction!.atMs).toBe(104);
    }
    h.session.release();
    h.receive(cp => { cp.owner.generation++; });
    expect(h.diagnostics.snapshot().lead.appliedMs).toBe(104);
    h.session.retry();
    h.welcome();
    h.receive();
    expect(h.diagnostics.snapshot().lead.appliedMs).toBe(104);
    h.session.receive({ type: "left" });
    expect(h.diagnostics.snapshot().lead).toEqual({ requestedMs: 104, appliedMs: 0 });
    h.receive(cp => { cp.room.code = "THIRDR"; });
    expect(h.diagnostics.snapshot().lead.appliedMs).toBe(104);
    const fresh = clockSession();
    expect(fresh.diagnostics.snapshot().lead.appliedMs).toBe(0);
  });

  test("real reconnect, practice epoch, countdown and next round preserve fixed policy", async () => {
    const h = new NetHarness({ diagnostics: true, inputLeadMs: { a: 104 } });
    h.startMatch({ firstTo: 2 });
    const initialRound = h.room!.match!.round;
    h.b.session.stop();
    h.advance(100);
    const frozen = h.a.session.prediction!.atMs;
    h.advance(500);
    expect(h.a.session.prediction!.atMs).toBe(frozen);
    h.b.session.start();
    h.runUntil(() => h.a.session.canPlay && h.b.session.canPlay, 6000);
    expect(h.room!.match!.round).toBe(initialRound);
    expect(h.a.diagnostics!.snapshot().lead.appliedMs).toBe(104);
    h.a.session.retry();
    h.runUntil(() => h.a.session.canPlay && h.b.session.canPlay, 6000);
    h.press("a", Input.RotateCw);
    h.runUntil(() => h.a.session.pending.length === 0);
    expect(h.a.diagnostics!.snapshot().rejections.total).toBe(0);
    h.dropOut("b");
    h.runUntil(() => h.room!.match!.round > initialRound && h.a.session.canPlay, 8000);
    expect(h.a.diagnostics!.snapshot().lead.appliedMs).toBe(104);
    const prefix = await h.room!.recorder!.buildIncompleteReplay();
    expect((await verifyMatchReplayExecution(prefix!)).state).toEqual(h.room!.match!.saveState());

    const practice = new NetHarness({ diagnostics: true, inputLeadMs: { a: 104 } });
    practice.startMatch({ mode: "practice" });
    const epoch = practice.aCheckpoint!.owner.epoch;
    practice.a.session.practice("practiceReset");
    practice.runUntil(() => practice.aCheckpoint!.owner.epoch > epoch && practice.a.session.canPlay);
    expect(practice.a.diagnostics!.snapshot().lead.appliedMs).toBe(104);
    expect(practice.room!.recorder).toBeUndefined();
  });
});
