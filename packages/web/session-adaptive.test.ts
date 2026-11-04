import { expect, test } from "bun:test";
import { FRAME_MS, Input } from "@42tris/core";
import { Match } from "@42tris/match";
import type { Checkpoint, ClientCommand, ServerMessage } from "@42tris/protocol";
import { Session, type SessionOptions } from "./src/session";
import { SessionDiagnostics } from "./src/session-diagnostics";
import { configuredInputLead, experimentalInputLead } from "./src/netplay-options";
import { NetHarness } from "./netplay-harness";
import { verifyMatchReplayExecution } from "@42tris/replay";

function fixture() {
  let now = 0;
  const commands: ClientCommand[] = [];
  const connections: Parameters<SessionOptions["connect"]>[0][] = [];
  const store = { getItem: () => null, setItem() {}, removeItem() {} };
  const diagnostics = new SessionDiagnostics();
  const session = new Session({ inputLeadMs: "auto", now: () => now, storage: store, profile: store, diagnostics,
    clearKeys() {}, schedule: () => () => {}, connect(callbacks) {
      connections.push(callbacks); return { send(command) { commands.push(command); }, close() {} };
    } });
  session.start();
  const welcome = () => session.receive({ type: "welcome", guestSessionId: "a", playerId: "a", resumeToken: "secret",
    name: "private-name", room: session.room, generation: 0, serverNow: now });
  welcome();
  const cp: Checkpoint = { type: "checkpoint", serverSequence: 1, serverNow: 0, matchId: "match",
    state: new Match({ players: ["a", "b"], seed: 108 }).saveState(),
    room: { code: "ABCDEF", revision: 1, ownerId: "a", options: { firstTo: 3, maxPlayers: 4, mode: "competitive", attacksEnabled: true, width: 10 },
      phase: "countdown", matchId: "match", preparationId: 1, startsAt: null, prepareDeadline: null,
      players: ["a", "b"].map(playerId => ({ playerId, name: playerId, skin: "classic", connected: true,
        ready: true, prepared: true, deadline: null, withdrawn: false })) },
    owner: { generation: 0, epoch: 0, nextSeq: 1, resolvedThroughSeq: 0, pendingAccepted: [], rejections: [] },
    clock: { currentTargetFrame: 0, simulationNow: 0, origin: 0, pausedTotal: 0, commitDelayMs: 100, frozen: true },
    roundDurations: [], events: [] };
  const receive = (change: (cp: Checkpoint) => void = () => {}) => {
    cp.serverSequence++; cp.serverNow = now; change(cp); session.receive(structuredClone(cp));
  };
  receive();
  const pong = (sent: number, up: number, down = up, serverOffset = 0) => {
    // Keep the browser running while waiting for the real Session ping.
    now = sent; session.tick();
    const ping = commands.findLast(c => c.type === "ping")! as Extract<ClientCommand, { type: "ping" }>;
    for (let at = sent + 100; at < sent + up + down; at += 100) { now = at; session.tick(); }
    now = sent + up + down;
    session.receive({ type: "pong", nonce: ping.nonce, serverNow: sent + up + serverOffset });
  };
  return { session, diagnostics, commands, connections, cp, receive, welcome, pong,
    time(value: number) { now = value; }, tick(value: number) { now = value; session.tick(); }, play() { receive(c => { c.room.phase = "playing"; c.clock.frozen = false; }); } };
}

test.each([
  ["", 0, undefined], ["diagnostics", 0, undefined], ["lead=auto", 0, undefined],
  ["diagnostics&lead=0", 0, 0], ["diagnostics&lead=104", 104, 104], ["diagnostics&lead=250", 250, 250],
  ["diagnostics&lead=auto", "auto", "auto"], ["diagnostics&lead=Auto", 0, undefined],
  ["diagnostics&lead=AUTO", 0, undefined], ["diagnostics&lead=auto%20", 0, undefined],
  ["diagnostics&lead=104&lead=auto", 104, 104], ["diagnostics&lead=auto&lead=104", 0, undefined],
  ["diagnostics&lead=auto&lead=auto", 0, undefined], ["diagnostics&lead=NaN&lead=auto", 0, undefined],
] as const)("explicit URL configuration %s", (query, expected, configured) => {
  expect(experimentalInputLead(new URLSearchParams(query))).toBe(expected);
  expect(configuredInputLead(new URLSearchParams(query))).toBe(configured);
});

test("countdown stays unlatched until the first unfrozen playing checkpoint", () => {
  const f = fixture();
  f.pong(0, 150); f.pong(500, 150);
  f.receive();
  expect(f.diagnostics.snapshot().adaptive.decisions).toHaveLength(0);
  expect(f.session.prediction!.atMs).toBe(0);
  f.pong(1000, 150);
  f.receive(c => { c.room.phase = "playing"; });
  expect(f.diagnostics.snapshot().adaptive.decisions).toHaveLength(0);
  f.play();
  expect(f.diagnostics.snapshot().lead).toMatchObject({ mode: "adaptive", requestedMs: null, appliedMs: 104, reason: "selected" });
  expect(f.session.prediction!.atMs).toBe(104);
});

test.each(["unwarmed", "stale"] as const)("cold %s fallback remains zero for the entire round", condition => {
  const f = fixture();
  if (condition === "stale") {
    f.pong(0, 150); f.pong(500, 150); f.pong(1000, 150); f.time(40_000);
  }
  f.play();
  expect(f.diagnostics.snapshot().lead).toMatchObject({ appliedMs: 0, reason: `fallback-${condition}` });
  f.pong(42_000, 150); f.pong(42_500, 150); f.pong(43_000, 150);
  f.receive();
  expect(f.diagnostics.snapshot().lead.appliedMs).toBe(0);
  expect(f.diagnostics.snapshot().clock.selectedSampleRttMs).toBeNull();
  const decisions = f.diagnostics.snapshot().adaptive.decisions;
  f.session.release("stale-prediction");
  f.receive(c => { c.owner.generation++; });
  expect(f.diagnostics.snapshot().lead.appliedMs).toBe(0);
  expect(f.diagnostics.snapshot().clock.selectedSampleRttMs).toBeNull();
  expect(f.diagnostics.snapshot().adaptive.decisions).toEqual(decisions);
  f.receive(c => { c.state!.round++; });
  expect(f.diagnostics.snapshot().lead.appliedMs).toBe(104);
});

test("pongs, rejection, generation, epoch and same-round reconnect preserve the lead and offset", () => {
  const f = fixture();
  f.pong(0, 180, 20); f.pong(500, 180, 20); f.pong(1000, 180, 20); f.play();
  const selected = f.diagnostics.snapshot();
  expect(selected.lead.appliedMs).toBe(54);
  expect(selected.clock.effectiveOffsetMs).toBe(80);
  f.pong(3000, 20, 300);
  expect(f.diagnostics.snapshot().clock.effectiveOffsetMs).toBe(80);
  for (const code of ["INPUT_REJECTED", "STALE_INPUT"] as const) {
    f.session.receive({ type: "error", code, message: "test" });
    f.receive(c => { c.owner.generation++; });
  }
  f.receive(c => { c.owner.epoch++; c.state!.players[0].epoch++; });
  const old = f.connections[0];
  f.session.retry(); f.welcome(); f.receive();
  old.message({ type: "pong", nonce: "old", serverNow: 1e6 });
  expect(f.diagnostics.snapshot().adaptive.sampleCount).toBe(0);
  expect(f.diagnostics.snapshot().adaptive.decisions).toHaveLength(1);
  expect(f.diagnostics.snapshot().lead.appliedMs).toBe(54);
  expect(f.diagnostics.snapshot().clock.effectiveOffsetMs).toBe(80);
  f.pong(5000, 20, 300); f.pong(5500, 20, 300); f.pong(6000, 20, 300);
  expect(f.diagnostics.snapshot().clock.effectiveOffsetMs).toBe(80);
  f.receive(c => { c.state!.round++; });
  expect(f.diagnostics.snapshot().clock.effectiveOffsetMs).toBe(-140);
  expect(f.diagnostics.snapshot().checkpoints.ageMs.last).toBe(-140);
  expect(f.diagnostics.snapshot().adaptive.decisions).toHaveLength(2);
});

test.each(["left", "expiry", "missing-state", "new-room", "new-match"] as const)("%s clears the adaptive round calibration", kind => {
  const f = fixture(); f.pong(0, 180, 20); f.pong(500, 180, 20); f.pong(1000, 180, 20); f.play();
  if (kind === "left") f.session.receive({ type: "left" });
  if (kind === "expiry") f.session.receive({ type: "error", code: "SESSION_EXPIRED", message: "test" });
  if (kind === "missing-state") f.receive(c => { c.state = null; c.matchId = null; });
  if (kind === "new-room" || kind === "new-match") {
    const room = structuredClone(f.cp.room);
    if (kind === "new-room") room.code = "NEWROM"; else room.matchId = "new-match";
    f.session.receive({ type: "roomState", room, serverNow: f.cp.serverNow });
  }
  expect(f.diagnostics.snapshot().lead.appliedMs).toBe(0);
  expect(f.diagnostics.snapshot().clock.selectedSampleRttMs).toBeNull();
});

test("all gameplay stamp and send-margin paths use the latched offset exactly once", () => {
  const f = fixture(); f.pong(0, 180, 20); f.pong(500, 180, 20); f.pong(1000, 180, 20); f.play();
  f.pong(3000, 10, 10, -400); // Future estimator changes; active round remains offset +80.
  f.receive(c => {
    const match = Match.fromState(c.state!); match.advanceToFrame(100); c.state = match.saveState();
    c.clock.simulationNow = 1820;
  });
  f.time(3120);
  f.session.input(Input.HardDrop);
  const item = f.session.pending.at(-1)!;
  expect((item.frame + item.subframe) * FRAME_MS).toBeCloseTo(2054, 9); // simulation 1820 + elapsed 180 + lead 54
  expect(f.diagnostics.snapshot().inputs.marginAtSendMs.p50).toBeCloseTo(154, 9);
  const before = structuredClone(item);
  f.session.receive({ type: "error", code: "SEQ_GAP", message: "retry" }); f.receive();
  expect(f.session.pending.at(-1)).toEqual({ ...before, sent: false });
});

test("diagnostics contain only anonymous bounded decision metadata", () => {
  const f = fixture(); f.pong(0, 150); f.pong(500, 150); f.pong(1000, 150);
  for (let i = 0; i < 50; i++) { f.play(); f.receive(c => { c.state!.round++; }); }
  const snapshot = f.diagnostics.snapshot();
  expect(snapshot.adaptive.decisions).toHaveLength(32);
  expect(JSON.stringify(snapshot)).not.toMatch(/secret|private-name|ABCDEF|serverPongMs|sentAtClientMs/);
});

test("real adaptive practice reset and undo preserve the round decision", () => {
  const h = new NetHarness({ diagnostics: true, inputLeadMs: { a: "auto" }, a: { up: 150, down: 150 } });
  h.startMatch({ mode: "practice" });
  const before = h.a.diagnostics!.snapshot();
  h.press("a", Input.HardDrop); h.advance(500);
  for (const type of ["practiceUndo", "practiceReset"] as const) {
    const epoch = h.aCheckpoint!.owner.epoch;
    h.a.session.practice(type);
    h.runUntil(() => h.aCheckpoint!.owner.epoch > epoch && h.a.session.canPlay, 3000);
    const after = h.a.diagnostics!.snapshot();
    expect(after.lead.appliedMs).toBe(before.lead.appliedMs);
    expect(after.clock.effectiveOffsetMs).toBe(before.clock.effectiveOffsetMs);
    expect(after.adaptive.decisions).toEqual(before.adaptive.decisions);
  }
});

test("adaptive zero and omitted lead have equivalent gameplay under equivalent clock mapping", async () => {
  const run = async (adaptive: boolean) => {
    const h = new NetHarness({ diagnostics: true, commandHistory: Infinity, messageHistory: Infinity,
      inputLeadMs: adaptive ? { a: "auto", b: "auto" } : undefined, a: { up: 20, down: 20 }, b: { up: 20, down: 20 } });
    h.startMatch(); h.playScript("a", 3000, 8); h.playScript("b", 3000, 8); h.advance(3500);
    const journal = await h.room!.recorder!.buildIncompleteReplay();
    expect((await verifyMatchReplayExecution(journal!)).state).toEqual(h.room!.match!.saveState());
    return { h, journal };
  };
  const a = await run(true), z = await run(false);
  for (let i = 0; i < 2; i++) {
    expect(a.h.clients[i].commands.filter(c => c.type !== "ping")).toEqual(z.h.clients[i].commands.filter(c => c.type !== "ping"));
    expect(a.h.clients[i].session.checkpoint).toEqual(z.h.clients[i].session.checkpoint);
    expect(a.h.clients[i].diagnostics!.snapshot().releases).toEqual(z.h.clients[i].diagnostics!.snapshot().releases);
  }
  expect(a.journal).toEqual(z.journal);
});


test("only adaptive mode uses bootstrap cadence, then returns to two seconds", () => {
  const f = fixture(); f.pong(0, 20); f.pong(500, 20); f.pong(1000, 20);
  const pings = () => f.commands.filter(c => c.type === "ping");
  expect(pings()).toHaveLength(3);
  for (let at = 1100; at <= 2900; at += 100) f.tick(at);
  expect(pings()).toHaveLength(3);
  f.tick(3000); expect(pings()).toHaveLength(4);
});

test("sampled upstream and downstream spikes produce distinct future proposals through Session", () => {
  const run = (up: number, down: number) => {
    const f = fixture(); f.pong(0, 30); f.pong(500, 30); f.pong(1000, 30); f.play();
    const before = f.diagnostics.snapshot();
    f.pong(3000, up, down);
    const after = f.diagnostics.snapshot();
    expect(after.lead.appliedMs).toBe(0);
    expect(after.clock.effectiveOffsetMs).toBe(before.clock.effectiveOffsetMs);
    return after.lead.proposedNextMs;
  };
  expect(run(180, 30)).toBe(134);
  expect(run(30, 180)).toBe(0);
  expect(run(180, 30)).toBe(run(180, 30));
});

test("repeated frozen checkpoints preserve the round clock and prediction", () => {
  const f = fixture(); f.pong(0, 150); f.pong(500, 150); f.pong(1000, 150); f.play();
  const before = f.session.prediction!.atMs;
  f.receive(c => { c.room.phase = "paused"; c.clock.frozen = true; });
  for (const at of [1500, 2000, 2500]) { f.time(at); f.receive(); }
  expect(f.session.prediction!.atMs).toBe(before);
  expect(f.diagnostics.snapshot().lead.appliedMs).toBe(104);
  expect(f.diagnostics.snapshot().adaptive.decisions).toHaveLength(1);
});

test("manual fixed mode retains the all-connection best-pong clock and two-second cadence", () => {
  let now = 0;
  const commands: ClientCommand[] = [];
  const store = { getItem: () => null, setItem() {}, removeItem() {} };
  const diagnostics = new SessionDiagnostics();
  const session = new Session({ inputLeadMs: 250, diagnostics, now: () => now, storage: store, profile: store,
    clearKeys() {}, connect: () => ({ send: c => commands.push(c), close() {} }) });
  session.start(); session.receive({ type: "welcome", guestSessionId: "a", playerId: "a", resumeToken: "token",
    name: "a", room: null, generation: 0, serverNow: 0 });
  const pong = (sent: number, rtt: number, offset: number) => {
    now = sent; session.tick();
    const command = commands.at(-1)!;
    expect(command.type).toBe("ping");
    if (command.type !== "ping") throw new Error("Expected clock probe");
    now += rtt; session.receive({ type: "pong", nonce: command.nonce, serverNow: sent + rtt / 2 + offset });
  };
  pong(0, 40, 10);
  now = 500; session.tick(); expect(commands.filter(c => c.type === "ping")).toHaveLength(1);
  pong(2000, 100, 80); pong(4000, 40, 90);
  expect(session.serverNow() - now).toBe(10); // Equal RTT retains the earlier sample.
  pong(6000, 20, -30);
  expect(session.serverNow() - now).toBe(-30);
  expect(diagnostics.snapshot().adaptive.sampleCount).toBe(0);
});

test.each([undefined, 0, 104, 250])("non-adaptive request %s keeps the two-second probe cadence", inputLeadMs => {
  let now = 0;
  const pings: number[] = [];
  const store = { getItem: () => null, setItem() {}, removeItem() {} };
  const session = new Session({ inputLeadMs, now: () => now, storage: store, profile: store, clearKeys() {},
    connect: () => ({ send(command) { if (command.type === "ping") pings.push(now); }, close() {} }) });
  session.start();
  session.receive({ type: "welcome", guestSessionId: "a", playerId: "a", resumeToken: "token",
    name: "a", room: null, generation: 0, serverNow: 0 });
  for (now = 0; now <= 4500; now += 25) session.tick();
  expect(pings).toEqual([0, 2000, 4000]);
});
