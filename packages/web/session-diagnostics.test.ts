import { describe, expect, spyOn, test } from "bun:test";
import { FRAME_MS, Input } from "@42tris/core";
import { OwnerPrediction } from "@42tris/match";
import { verifyMatchReplayExecution } from "@42tris/replay";
import { NetHarness } from "./netplay-harness";
import { messagePayloadBytes, SessionDiagnostics } from "./src/session-diagnostics";

const info = { sequence: 1, serverNow: 500, frame: 0, round: 1, generation: 0, identityChanged: false };

function standalone() {
  let now = 0;
  const d = new SessionDiagnostics();
  let state = { eligible: false, playable: false, expiresAt: Infinity };
  d.attach(() => now, () => state);
  return { d, at: (time: number) => { now = time; }, state: (next: typeof state) => { state = next; d.updateControl(); } };
}

describe("N2-A browser diagnostics", () => {
  test("missing checkpoints, offsets, margins and drift remain explicitly unavailable", () => {
    const { d } = standalone();
    d.checkpoint(550, info);
    expect(d.snapshot().checkpoints.ageMs).toEqual({ last: null, p50: null, p95: null, max: null });
    expect(d.snapshot().inputs.marginAtSendMs).toEqual({ p5: null, p50: null });
    expect(d.snapshot().clock).toEqual({ offsetSamples: [], driftMsPerMin: null,
      estimatedOffsetMs: null, bestRttMs: null, calibrated: false });
  });

  test("T-D1 age uses receive time plus estimated offset, including negative estimates", () => {
    const { d } = standalone();
    d.checkpoint(425, { ...info, estimatedOffset: 100 });
    expect(d.snapshot().checkpoints.ageMs).toEqual({ last: 25, p50: 25, p95: 25, max: 25 });
    d.checkpoint(410, { ...info, estimatedOffset: 80 });
    expect(d.snapshot().checkpoints.ageMs.last).toBe(-10); // do not clamp away clock bias
  });

  test("welcome-only offset gives biased age until a pong; symmetric and asymmetric paths are labelled estimates", () => {
    const h = new NetHarness({ diagnostics: true, a: { up: 20, down: 80 }, frameMs: 2000 });
    h.runUntil(() => h.a.session.connected);
    h.a.session.send({ type: "create", requestId: "age", options: { mode: "practice", firstTo: 1, attacksEnabled: false } });
    h.runUntil(() => h.a.session.checkpoint !== null);
    expect(h.a.diagnostics!.snapshot().clock.offsetSamples).toHaveLength(0);
    expect(h.a.diagnostics!.snapshot().checkpoints.ageMs.last).toBeCloseTo(0, 6);
    h.advance(2300);
    expect(h.a.diagnostics!.snapshot().clock.offsetSamples.length).toBeGreaterThan(0);
    // Implied offset = (up - down)/2 = -30; physical downstream is 80 ms.
    expect(h.a.diagnostics!.snapshot().checkpoints.ageMs.last).toBeCloseTo(50, 6);
    const symmetric = new NetHarness({ diagnostics: true, a: { up: 30, down: 30 } });
    symmetric.startMatch();
    symmetric.advance(100);
    expect(symmetric.a.diagnostics!.snapshot().checkpoints.ageMs.last).toBeCloseTo(30, 6);
  });

  test("frozen simulation clocks do not freeze checkpoint age; identity and reconnect clear age history", () => {
    const h = new NetHarness({ diagnostics: true });
    h.startMatch();
    h.b.session.stop();
    h.advance(100);
    expect(h.aCheckpoint!.clock.frozen).toBe(true);
    expect(h.a.diagnostics!.snapshot().checkpoints.ageMs.last).toBeCloseTo(10, 6);
    h.a.session.retry();
    expect(h.a.diagnostics!.snapshot().checkpoints.ageMs.last).toBeNull();
    expect(h.a.diagnostics!.snapshot().clock.offsetSamples).toHaveLength(0);
    const { d } = standalone();
    d.checkpoint(1500, { ...info, estimatedOffset: 0 });
    d.checkpoint(510, { ...info, identityChanged: true, estimatedOffset: 0 });
    expect(d.snapshot().checkpoints.ageMs.max).toBe(10);
  });

  test("T-D2 counts UTF-8 payload bytes, binary views and blobs without reserializing parsed messages", () => {
    expect(messagePayloadBytes('é🎮')).toBe(6);
    expect(messagePayloadBytes(new Uint8Array(12).subarray(2, 5))).toBe(3);
    expect(messagePayloadBytes(new ArrayBuffer(7))).toBe(7);
    expect(messagePayloadBytes(new Blob(['é']))).toBe(2);
    const f = standalone();
    f.d.connection(0, true);
    for (let i = 0; i < 10; i++) f.d.receivedMessage(i * 100, 'é🎮');
    f.at(1000);
    expect(f.d.snapshot().transport).toEqual({ bytesPerSec: 60, messagesPerSec: 10,
      maxMessageBytes: 6, measurement: "received-application-payload", windowMs: 10_000, sampleMs: 1000 });
    f.at(11_100);
    expect(f.d.snapshot().transport.bytesPerSec).toBe(0);
    f.d.connection(11_100, false);
    f.d.connection(11_200, true);
    expect(f.d.snapshot().transport.maxMessageBytes).toBe(0);
  });

  test("browser throughput agrees with independently counted harness payload bytes", () => {
    const h = new NetHarness({ diagnostics: true });
    h.startMatch();
    h.playScript("a", 1500);
    h.advance(1500);
    const t = h.a.diagnostics!.snapshot().transport;
    expect(t.bytesPerSec * t.sampleMs / 1000).toBeCloseTo(h.a.traffic.downBytes, 5);
    expect(t.messagesPerSec * t.sampleMs / 1000).toBeCloseTo(h.a.traffic.downMessages, 5);
  });

  test("mature throughput window stays within five percent of independent harness byte counts", () => {
    const h = new NetHarness({ diagnostics: true });
    h.startMatch();
    const before = h.a.traffic.downBytes;
    h.advance(10_000);
    const actualRate = (h.a.traffic.downBytes - before) / 10;
    expect(Math.abs(h.a.diagnostics!.snapshot().transport.bytesPerSec - actualRate) / actualRate).toBeLessThan(0.05);
  });

  test("T-D3 centred regression measures offset change and refuses insufficient or frozen time", () => {
    const { d } = standalone();
    d.clockOffset(1e12, 123);
    d.clockOffset(1e12, 125);
    expect(d.snapshot().clock.driftMsPerMin).toBeNull();
    for (let i = 0; i < 16; i++) d.clockOffset(1e12 + i * 2000, 200 - i * 0.1);
    expect(d.snapshot().clock.driftMsPerMin).toBeCloseTo(-3, 6);
    expect(d.snapshot().clock.offsetSamples).toHaveLength(16);
  });

  test("every pong is sampled while gameplay retains its best-RTT clock model", () => {
    const h = new NetHarness({ diagnostics: true });
    h.startMatch();
    const baselineOffset = h.a.session.serverNow() - h.clientTime("a");
    h.setLink("a", { down: 60 });
    h.advance(5000);
    const samples = h.a.diagnostics!.snapshot().clock.offsetSamples;
    expect(samples.some(offset => offset < -20)).toBe(true);
    expect(h.a.session.serverNow() - h.clientTime("a")).toBeCloseTo(baselineOffset, 6);
    // A changing network path can move implied offsets without oscillator drift.
    expect(h.a.diagnostics!.snapshot().clock.driftMsPerMin).not.toBeNull();
  });

  test("controlled 50 ppm client clock drift is observable through real Session pongs", () => {
    const h = new NetHarness({ diagnostics: true, messageHistory: 16, a: { clockDriftPpm: 50, clockOffsetMs: 1000 } });
    h.startMatch();
    h.advance(32_000);
    expect(h.a.diagnostics!.snapshot().clock.driftMsPerMin!).toBeCloseTo(-3, 2);
    expect(h.a.diagnostics!.snapshot().clock.offsetSamples).toHaveLength(16);
  }, 15_000);

  test("T-D4 integrates eligibility boundaries and an open expiry interval exactly", () => {
    const f = standalone();
    f.at(1000);
    f.state({ eligible: true, playable: true, expiresAt: 3000 });
    f.at(3500);
    expect(f.d.snapshot().control).toEqual({ eligibleMs: 2500, blockedMs: 500, blockedPct: 20 });
    f.state({ eligible: false, playable: false, expiresAt: 3000 }); // round end / elimination
    f.at(8000);
    expect(f.d.snapshot().control).toEqual({ eligibleMs: 2500, blockedMs: 500, blockedPct: 20 });
  });

  test("T-D4 harness independently agrees through expiry, recovery, pause and round boundaries", () => {
    const h = new NetHarness({ diagnostics: true });
    h.startMatch();
    h.holdDownstream("a", 2700);
    h.advance(2500);
    let reported = h.a.diagnostics!.snapshot().control;
    expect(reported.blockedMs).toBeCloseTo(h.a.control.blockedMs, 5);
    expect(reported.eligibleMs).toBeCloseTo(h.a.control.eligibleMs, 5);
    expect(reported.blockedMs).toBeGreaterThan(400);
    h.advance(400);
    h.b.session.stop();
    h.advance(100);
    reported = h.a.diagnostics!.snapshot().control;
    const blocked = reported.blockedMs;
    h.advance(600);
    expect(h.a.diagnostics!.snapshot().control.blockedMs).toBe(blocked);
    expect(reported.blockedMs).toBeCloseTo(h.a.control.blockedMs, 5);
  });

  test("elimination in a three-player room stops eligible accounting while FFA continues", () => {
    const h = new NetHarness({ diagnostics: true, players: [{}, {}, {}] });
    h.startMatch();
    for (let i = 0; i < 20 && h.a.session.canPlay; i++) { h.press("a", Input.HardDrop); h.advance(150); }
    expect(h.room!.phase).toBe("playing");
    expect(h.a.session.canPlay).toBe(false);
    const before = h.a.diagnostics!.snapshot().control;
    h.holdDownstream("a", 3000);
    h.advance(2500);
    expect(h.a.diagnostics!.snapshot().control).toEqual(before);
  });

  test("real round-result and countdown time is excluded before eligibility resumes", () => {
    const h = new NetHarness({ diagnostics: true });
    h.startMatch({ firstTo: 2 });
    h.dropOut("a");
    h.advance(100);
    const before = h.a.diagnostics!.snapshot().control;
    expect(h.room!.phase).toBe("roundResult");
    h.advance(1500);
    expect(h.a.diagnostics!.snapshot().control).toEqual(before);
    h.advance(2500);
    const after = h.a.diagnostics!.snapshot().control;
    expect(after.eligibleMs).toBeGreaterThan(before.eligibleMs);
    expect(after.eligibleMs).toBeCloseTo(h.a.control.eligibleMs, 5);
    expect(after.blockedMs).toBeCloseTo(h.a.control.blockedMs, 5);
  });

  test.each(["left", "session-expired", "room", "match"] as const)("%s clears old checkpoint and margin samples before another checkpoint arrives", change => {
    const h = new NetHarness({ diagnostics: true });
    h.startMatch();
    h.press("a", Input.RotateCw);
    expect(h.a.diagnostics!.snapshot().inputs.marginAtSendMs.p50).not.toBeNull();
    if (change === "left") h.a.session.receive({ type: "left" });
    else if (change === "session-expired") h.a.session.receive({ type: "error", code: "SESSION_EXPIRED", message: "Expired" });
    else {
      const room = structuredClone(h.a.session.room!);
      if (change === "room") room.code = "NEWROM";
      else room.matchId = "new-match";
      h.a.session.receive({ type: "roomState", room, serverNow: h.time });
    }
    expect(h.a.diagnostics!.snapshot().checkpoints.ageMs.last).toBeNull();
    expect(h.a.diagnostics!.snapshot().inputs.marginAtSendMs).toEqual({ p5: null, p50: null });
  });

  test("old checkpoint sequences cannot add an age observation", () => {
    const h = new NetHarness({ diagnostics: true });
    h.startMatch();
    const age = h.a.diagnostics!.snapshot().checkpoints.ageMs;
    const old = structuredClone(h.aCheckpoint!);
    old.serverNow -= 1000;
    h.a.session.receive(old);
    expect(h.a.diagnostics!.snapshot().checkpoints.ageMs).toEqual(age);
    expect(h.a.diagnostics!.snapshot().checkpoints.stale).toBe(1);
  });

  test("deliberate user release is excluded; network recovery counts blocked time", () => {
    const h = new NetHarness({ diagnostics: true });
    h.startMatch();
    const before = h.a.diagnostics!.snapshot().control.blockedMs;
    h.a.session.release();
    h.advance(100);
    expect(h.a.diagnostics!.snapshot().control.blockedMs).toBe(before);
    h.a.session.release("stale-prediction");
    h.advance(10);
    expect(h.a.diagnostics!.snapshot().control.blockedMs).toBeGreaterThan(before);
  });

  test("transmitted margins use the current simulation clock and checkpoint commitment delay", () => {
    const h = new NetHarness({ diagnostics: true });
    h.startMatch();
    const cp = structuredClone(h.aCheckpoint!);
    cp.serverSequence++;
    // Alternate fixture catches a hardcoded diagnostic delay; server rules remain unchanged.
    Object.assign(cp.clock, { commitDelayMs: 137 });
    h.a.session.receive(cp);
    h.holdDownstream("a", 100);
    h.press("a", Input.RotateCw);
    const item = h.a.batches.at(-1)!.items[0];
    const stamp = (item.frame + item.subframe) * FRAME_MS;
    const estimate = cp.clock.simulationNow + Math.max(0, h.a.session.serverNow() - cp.serverNow) - 137;
    expect(h.a.diagnostics!.snapshot().inputs.marginAtSendMs).toEqual({ p5: stamp - estimate, p50: stamp - estimate });
    h.advance(5);
    h.press("a", Input.RotateCcw);
    expect(h.a.diagnostics!.snapshot().inputs.sent).toBe(1); // throttled input is not sampled yet
    h.advance(29);
    expect(h.a.diagnostics!.snapshot().inputs.sent).toBe(2);
    expect(h.a.diagnostics!.snapshot().inputs.marginAtSendMs.p5!).toBeLessThan(137);
  });

  test("new sample histories and percentiles stay bounded and detached from snapshots", () => {
    const f = standalone();
    for (let i = 0; i < 10_000; i++) {
      f.d.checkpoint(i, { ...info, serverNow: 0, estimatedOffset: 0 });
      f.d.inputMargin(i, 0);
      f.d.clockOffset(i, i);
      f.d.receivedMessage(i, 'é');
    }
    const snapshot = f.d.snapshot();
    expect(snapshot.checkpoints.ageMs).toEqual({ last: 9999, p50: 9872, p95: 9986, max: 9999 });
    expect(snapshot.inputs.marginAtSendMs).toEqual({ p5: 9757, p50: 9872 });
    snapshot.clock.offsetSamples[0] = -999;
    expect(f.d.snapshot().clock.offsetSamples[0]).toBe(9984);
    expect(snapshot.events).toHaveLength(128);
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
    expect(JSON.stringify(snapshot)).not.toMatch(/resumeToken|playerId|guestProfile|"name"/);
  });

  test("T-D6 diagnostics on/off leave input stamps, authority, checkpoints and replay journals identical", async () => {
    const run = (diagnostics: boolean) => {
      const h = new NetHarness({ seed: 57, diagnostics, messageHistory: Infinity, commandHistory: Infinity, batchHistory: Infinity, players: [{}, {}, {}] });
      h.startMatch();
      for (const c of h.clients) h.playScript(c.key, 1800, 29);
      h.advance(2000);
      return h;
    };
    const disabled = run(false), enabled = run(true);
    for (let i = 0; i < 3; i++) {
      expect(enabled.clients[i].commands).toEqual(disabled.clients[i].commands);
      expect(enabled.clients[i].messages).toEqual(disabled.clients[i].messages);
      expect(enabled.clients[i].session.prediction!.saveState()).toEqual(disabled.clients[i].session.prediction!.saveState());
    }
    expect(enabled.room!.match!.saveState()).toEqual(disabled.room!.match!.saveState());
    const a = await disabled.room!.recorder!.buildIncompleteReplay();
    const b = await enabled.room!.recorder!.buildIncompleteReplay();
    expect(a).toEqual(b);
    expect((await verifyMatchReplayExecution(b!)).state).toEqual(enabled.room!.match!.saveState());
  });

  test("disabled instrumentation never counts payloads or captures prediction state", () => {
    const capture = spyOn(OwnerPrediction.prototype, "saveState");
    const payload = spyOn(SessionDiagnostics.prototype, "receivedMessage");
    try {
      const h = new NetHarness();
      h.startMatch();
      h.playScript("a", 200);
      h.advance(500);
      expect(capture).toHaveBeenCalledTimes(0);
      expect(payload).toHaveBeenCalledTimes(0);
    } finally { capture.mockRestore(); payload.mockRestore(); }
  });
});
