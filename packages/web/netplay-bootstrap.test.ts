import { expect, test } from "bun:test";
import { FRAME_MS } from "@42tris/core";
import { verifyMatchReplayExecution } from "@42tris/replay";
import { NetplayMetrics, type Admission } from "../server/src/netplay-metrics";
import { NetHarness } from "./netplay-harness";

test("countdown downstream hold keeps bootstrap alive until a fresh calibration is eligible", async () => {
  const h = new NetHarness({ seed: 42, frameMs: 25, diagnostics: true, inputLeadMs: { a: "auto" },
    a: { up: 90, down: 90 }, b: { up: 20, down: 20 } });
  const diagnostics = h.a.diagnostics!;
  const pings: number[] = [], receipts: number[] = [];
  const admissions: Admission[] = [];
  const serverErrors: string[] = [];
  const send = h.a.session.send.bind(h.a.session);
  h.a.session.send = command => { if (command.type === "ping") pings.push(h.time); send(command); };
  const clockOffset = diagnostics.clockOffset.bind(diagnostics);
  diagnostics.clockOffset = (at, offset) => { receipts.push(at); clockOffset(at, offset); };
  const peerSend = h.a.peer!.send;
  h.a.peer!.send = (message, ephemeral) => {
    if (message.type === "error") serverErrors.push(message.code);
    peerSend(message, ephemeral);
  };
  const metrics = new NetplayMetrics(0, { log() {}, cpuUsage: () => ({ user: 0, system: 0 }) });
  metrics.admission = (_room, seat, result) => {
    if ((seat as { id: string }).id === h.a.session.playerId) admissions.push(result);
  };
  h.rooms.metrics = metrics;
  let clockChecks = 0;
  const tick = h.rooms.tick.bind(h.rooms);
  h.rooms.tick = () => {
    tick();
    const room = h.room;
    if (room?.phase !== "playing" || !room.match || room.match.ended || room.origin === null) return;
    const expected = Math.floor(Math.max(0, h.time - room.origin - room.pausedTotal - 100) / FRAME_MS);
    expect(room.match.frame).toBe(expected);
    clockChecks++;
  };
  h.scheduleTimer("a", () => {
    expect(h.time).toBe(675);
    expect(h.room!.phase).toBe("countdown");
    h.holdDownstream("a", 1700);
  }, 675);
  h.scheduleTimer("a", () => {
    expect(receipts).toEqual([380, 2375, 2375, 2375, 2380]);
    expect(diagnostics.snapshot().adaptive.sampleCount).toBe(5);
    expect(diagnostics.snapshot().lead.proposedNextMs).toBeNull();
  }, 2425);
  h.scheduleTimer("a", () => {
    expect(pings).toEqual([200, 700, 1200, 1700, 2200, 2700]);
    expect(receipts.at(-1)).toBe(2880);
    expect(diagnostics.snapshot().lead.proposedNextMs).toBeNull();
  }, 2900);
  h.scheduleTimer("a", () => {
    expect(pings).toEqual([200, 700, 1200, 1700, 2200, 2700, 3200]);
    expect(receipts.at(-1)).toBe(3380);
    expect(diagnostics.snapshot().lead.proposedNextMs).toBe(44);
    expect(diagnostics.snapshot().adaptive.decisions).toHaveLength(0);
  }, 3400);

  h.startMatch();
  expect(h.time).toBe(3790);
  expect(diagnostics.snapshot().adaptive.decisions[0]).toMatchObject({ at: 3790, appliedMs: 44, reason: "selected" });
  const decision = diagnostics.snapshot().adaptive.decisions;
  h.playScript("a", 2500, 8); // 16 physical actions; 500 ms drains the real transport.
  h.advance(3000);
  expect(h.a.traffic.inputItems).toBe(16);
  expect(admissions).toHaveLength(16);
  expect(admissions.every(result => result === "accepted")).toBe(true);
  expect(serverErrors).toEqual([]); // No pre-admission WRONG_PHASE outcomes are excluded.
  expect(diagnostics.snapshot().releases.total).toBe(0);
  expect(diagnostics.snapshot().rejections.total).toBe(0);
  expect(diagnostics.snapshot().staleRecovery.count).toBe(0);
  expect(diagnostics.snapshot().adaptive.decisions).toEqual(decision);
  expect(pings).toEqual([200, 700, 1200, 1700, 2200, 2700, 3200, 5200]);
  expect(clockChecks).toBe(312);
  const replay = await h.room!.recorder!.buildIncompleteReplay();
  expect(replay).not.toBeNull();
  expect((await verifyMatchReplayExecution(replay!)).state).toEqual(h.room!.match!.saveState());
});
