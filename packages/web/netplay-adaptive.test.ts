import { expect, test } from "bun:test";
import { FRAME_MS, Input } from "@42tris/core";
import { verifyMatchReplayExecution } from "@42tris/replay";
import { NetHarness } from "./netplay-harness";
import { runLeadExperiment } from "./netplay-lead-experiment";
import { adaptiveExperiments, routeExperiments } from "./netplay-adaptive-experiment";

const leads = [0, 44, 54, 104, null, null, 54, 54];
test.each(adaptiveExperiments)("$name: calibrated Session, exact admission classes and replay", async scenario => {
  const { h, result } = await runLeadExperiment(scenario);
  expect(result.durationMs).toBeGreaterThanOrEqual(30_000);
  expect(result.clockViolations).toBe(0);
  expect(result.clockChecks).toBeGreaterThan(1000);
  expect(result.replayVerified).toBe(true);
  const expected = leads[adaptiveExperiments.indexOf(scenario)];
  for (const [index, measured] of result.clients.entries()) {
    expect(measured.whole.total).toBeGreaterThan(30);
    expect(measured.whole.future).toBe(0);
    expect(measured.whole.other).toBe(0);
    // In this no-retransmission script, each WRONG_PHASE command has one item.
    expect(measured.inputItemsSent - measured.whole.total).toBe(measured.serverErrors.WRONG_PHASE ?? 0);
    expect(measured.lead.appliedMs).toBeLessThanOrEqual(160);
    expect(measured.adaptive.decisions.every(d => d.ceilingMs === null || d.appliedMs <= d.ceilingMs)).toBe(true);
    if (!scenario.name.includes("spikes")) {
      expect(measured.whole.late).toBe(0);
      expect(measured.whole.accepted).toBe(measured.whole.total);
      expect(measured.resets).toBe(0);
    }
    const fingerprints = new Map<string, string>();
    const stamps = new Map<string, number>();
    for (const batch of h.clients[index].batches) for (const item of batch.items) {
      const identity = `${batch.matchId}:${batch.generation}:${batch.epoch}`;
      const key = `${identity}:${item.seq}`;
      if (fingerprints.has(key)) expect(JSON.stringify(item)).toBe(fingerprints.get(key)!);
      else {
        const stamp = (item.frame + item.subframe) * FRAME_MS;
        expect(stamp).toBeGreaterThanOrEqual(stamps.get(identity) ?? 0);
        stamps.set(identity, stamp); fingerprints.set(key, JSON.stringify(item));
      }
    }
  }
  if (expected !== null) expect(result.clients[0].adaptive.decisions[0].appliedMs).toBe(expected);
  if (scenario.name === "adaptive mixed") expect(result.clients.map(c => c.adaptive.decisions[0].appliedMs)).toEqual([0, 0, 44, 104]);
}, 20_000);

test.each(routeExperiments)("$name: immutable mid-round timing and a genuine next-round decision", async scenario => {
  const { result } = await runLeadExperiment(scenario);
  expect(result.replayVerified).toBe(true);
  expect(result.clockViolations).toBe(0);
  const a = result.clients[0];
  expect(a.whole.future).toBe(0);
  expect(a.whole.other).toBe(0);
  const decision = a.adaptive.decisions[1];
  if (scenario.name.includes("180/20")) expect(decision).toMatchObject({ wantedMs: 114, ceilingMs: 103, reason: "capped" });
  expect(decision.appliedMs).toBe(scenario.name.includes("300 to 40") ? 0 : scenario.name.includes("40 to 300") ? 104 : 103);
}, 30_000);

test("an adaptive action waits for its stamped time without accelerating authority", async () => {
  const h = new NetHarness({ diagnostics: true, inputLeadMs: { a: "auto" }, a: { up: 150, down: 150 } });
  h.startMatch();
  h.press("a", Input.RotateCw);
  const item = h.a.batches[0].items[0];
  const owner = () => h.room!.match!.playerState(h.a.session.playerId);
  h.advance(150);
  expect(h.room!.match!.frame).toBeLessThanOrEqual(item.frame);
  expect(owner().state.rot).toBe(0);
  h.runUntil(() => h.room!.match!.frame > item.frame);
  expect(owner().state.rot).toBe(1);
  const replay = await h.room!.recorder!.buildIncompleteReplay();
  expect((await verifyMatchReplayExecution(replay!)).state).toEqual(h.room!.match!.saveState());
});
