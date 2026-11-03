import { describe, expect, spyOn, test } from "bun:test";
import { DEFAULT_HANDLING, FRAME_MS, Input } from "@42tris/core";
import { verifyMatchReplayExecution } from "@42tris/replay";
import { NetHarness } from "../../web/netplay-harness";
import { createApp } from "../src/app";
import { latenessBucket, NetplayMetrics } from "../src/netplay-metrics";
import { Rooms } from "../src/rooms";

function fixture(count = 2, firstTo = 7) {
  const h = new NetHarness({ players: Array.from({ length: count }, () => ({})) });
  const lines: string[] = [];
  let cpu = 100;
  let reads = 0;
  h.rooms.metrics = new NetplayMetrics(0, {
    log: line => lines.push(line), cpuUsage: () => { reads++; return { user: cpu, system: cpu / 2 }; },
  });
  h.startMatch({ firstTo });
  return { h, lines, report() { cpu += 200; h.rooms.metrics!.report(h.rooms.rooms.values(), h.time); }, get reads() { return reads; } };
}

describe("optional server netplay metrics", () => {
  test.each([[0, 0], [10, 0], [10.001, 1], [25, 1], [25.001, 2], [30, 2], [50, 2], [50.001, 3], [100, 3], [100.001, 4]])(
    "lateness %f ms goes in bucket %i", (ms, bucket) => expect(latenessBucket(ms)).toBe(bucket));

  test("T-D5 real admission reports accepted, 30 ms late, future, and ignores retransmissions", async () => {
    const f = fixture(), h = f.h;
    h.advance(500);
    const cp = h.aCheckpoint!, seat = h.room!.seats[0], match = h.room!.match!;
    const stamp = match.frame - 1.8;
    const frame = Math.floor(stamp), subframe = stamp - frame;
    const command = { type: "inputBatch" as const, matchId: cp.matchId!, generation: cp.owner.generation,
      epoch: cp.owner.epoch, items: [
        { seq: seat.nextSeq, frame, subframe, input: Input.RotateCw },
        { seq: seat.nextSeq + 1, frame: cp.clock.currentTargetFrame + 100, subframe: 0, input: Input.RotateCw },
        { seq: seat.nextSeq + 2, frame: cp.clock.currentTargetFrame, subframe: 0, input: Input.RotateCw },
      ] };
    h.rooms.receive(h.a.peer!.id, command);
    h.rooms.receive(h.a.peer!.id, command);
    expect(seat.rejections).toHaveLength(2);
    expect(seat.pending.size).toBe(1);
    h.advance(10_000 - h.time);
    f.report();
    expect(f.lines).toHaveLength(1);
    const record = JSON.parse(f.lines[0]);
    expect(record.seats[0]).toMatchObject({ accepted: 1, rejectedLate: 1, rejectedFuture: 1,
      rejectedPendingFull: 0, rejectedOther: 0, lateMs: [0, 0, 1, 0, 0] });
    expect(record.seats[1].accepted).toBe(0);
    expect(record.transmission.checkpointsSent).toBeGreaterThan(0);
    expect(record.transmission.bytesSent).toBeGreaterThan(0);
    expect(record.transmission.measurement).toBe("serialized-utf8-payload-offered-to-send");
    expect(record.processCpu).toEqual({ scope: "process", userUs: 200, systemUs: 100 });
    const replay = await h.room!.recorder!.buildIncompleteReplay();
    expect((await verifyMatchReplayExecution(replay!)).state).toEqual(match.saveState());
  });

  test("pending-full comes from the existing 128 pending limit, without changing simulation or admission", () => {
    const h = new NetHarness(); // use its real preparation path, then freeze server ticks below
    const lines: string[] = [];
    h.rooms.metrics = new NetplayMetrics(0, { log: line => lines.push(line), cpuUsage: () => ({ user: 0, system: 0 }) });
    h.startMatch();
    const seat = h.room!.seats[0];
    const cp = h.aCheckpoint!;
    let seq = seat.nextSeq;
    // Refill the input-rate bucket through a fake clock, without committing queued inputs.
    let authorityNow = h.time;
    const originalNow = h.rooms.now;
    Object.defineProperty(h.rooms, "now", { value: () => authorityNow, configurable: true });
    try {
      for (let batch = 0; batch < 5; batch++) {
        if (batch === 2 || batch === 4) authorityNow += 300;
        const frame = Math.floor((authorityNow - h.room!.origin! - h.room!.pausedTotal) / FRAME_MS);
        h.rooms.receive(h.a.peer!.id, { type: "inputBatch", matchId: cp.matchId!, generation: cp.owner.generation, epoch: cp.owner.epoch,
          items: Array.from({ length: batch === 4 ? 1 : 32 }, () => ({ seq: seq++, frame, subframe: 0, input: Input.RotateCw })) });
      }
      expect(seat.pending.size).toBe(128);
      expect(seat.rejections).toHaveLength(1);
      h.rooms.metrics!.report(h.rooms.rooms.values(), 10_000);
      expect(JSON.parse(lines[0]).seats[0]).toMatchObject({ accepted: 128, rejectedPendingFull: 1, rejectedLate: 0, rejectedFuture: 0 });
    } finally { Object.defineProperty(h.rooms, "now", { value: originalNow, configurable: true }); }
  });

  test("periodic reports are interval counters; reads and output are gated at ten seconds", () => {
    const f = fixture();
    f.report();
    expect(f.lines).toHaveLength(0);
    expect(f.reads).toBe(1);
    f.h.advance(10_000 - f.h.time);
    f.report();
    expect(f.lines).toHaveLength(1);
    expect(f.reads).toBe(2);
    f.report();
    expect(f.lines).toHaveLength(1);
    f.h.rooms.metrics!.report(f.h.rooms.rooms.values(), 20_000);
    const second = JSON.parse(f.lines[1]);
    expect(second.transmission).toMatchObject({ checkpointsSent: 0, checkpointsSkipped: 0, bytesSent: 0 });
    expect(second.seats.every((s: { accepted: number }) => s.accepted === 0)).toBe(true);
    expect(second.windowMs).toBe(10_000);
    expect(second.sample).toBe(2);
  });

  test("small scheduler rounding does not turn ten-second reports into twenty-second reports", () => {
    const f = fixture();
    f.h.rooms.metrics!.report(f.h.rooms.rooms.values(), 10_000);
    f.h.rooms.metrics!.report(f.h.rooms.rooms.values(), 19_999.5);
    expect(f.lines).toHaveLength(2);
    expect(JSON.parse(f.lines[1]).windowMs).toBe(9999.5);
  });

  test("actual modeled backpressure counts skipped checkpoints without counting their unsent bytes", () => {
    const f = fixture();
    f.h.setLink("a", { downBytesPerSec: 1000, backpressure: true });
    f.h.advance(10_000 - f.h.time);
    f.report();
    const transmission = JSON.parse(f.lines[0]).transmission;
    expect(transmission.checkpointsSkipped).toBe(f.h.a.traffic.skippedCheckpoints);
    expect(transmission.checkpointsSkipped).toBeGreaterThan(0);
    expect(transmission.checkpointsSent).toBeGreaterThan(0);
  });

  test("a shared CPU sample is reported once for multiple active rooms, with anonymous labels", () => {
    const f = fixture();
    const another = new NetHarness();
    another.startMatch();
    f.h.rooms.metrics!.report([f.h.room!, another.room!], 10_000);
    const records = f.lines.map(line => JSON.parse(line));
    expect(records).toHaveLength(2);
    expect(records[0].processCpu.scope).toBe("process");
    expect(records[1].processCpu).toBeNull();
    expect(records[0].sample).toBe(records[1].sample);
    expect(records[0].room).not.toBe(records[1].room);
    expect(f.lines.join("\n")).not.toMatch(/resumeToken|guestProfile|playerId|matchId|"name"|"board"|"token"|"code"|00000000/);
  });

  test("completed rooms emit no active-room records", () => {
    const f = fixture();
    f.h.b.session.send({ type: "leave" });
    f.h.advance(100);
    f.h.rooms.metrics!.report(f.h.rooms.rooms.values(), 10_000);
    expect(f.lines).toHaveLength(0);
  });

  test("inactive intervals clear old counters before a rematch resumes reporting", () => {
    const f = fixture(2, 1);
    f.h.dropOut("a");
    f.h.advance(10_000 - f.h.time);
    expect(f.h.room!.phase).toBe("setResult");
    f.h.rooms.metrics!.transmission(f.h.room!, Number.MAX_SAFE_INTEGER, true, false);
    f.report();
    expect(f.lines).toHaveLength(0);
    for (const c of f.h.clients) c.session.send({ type: "ready", ready: true, handling: DEFAULT_HANDLING });
    f.h.advance(10_000);
    expect(f.h.room!.phase).toBe("playing");
    f.report();
    const record = JSON.parse(f.lines[0]);
    expect(record.windowMs).toBe(10_000);
    expect(record.transmission.bytesSent).toBeLessThan(Number.MAX_SAFE_INTEGER);
    expect(record.seats.every((seat: { accepted: number }) => seat.accepted === 0)).toBe(true);
  });

  test("removed seats lose their interval counters while remaining FFA seats keep separate reports", () => {
    const f = fixture(3);
    f.h.press("a", Input.RotateCw);
    f.h.advance(20);
    f.h.a.session.send({ type: "leave" });
    f.h.advance(100);
    expect(f.h.room!.phase).toBe("playing");
    f.h.rooms.metrics!.report(f.h.rooms.rooms.values(), 10_000);
    const seats = JSON.parse(f.lines[0]).seats;
    expect(seats).toHaveLength(2);
    expect(seats.every((seat: { accepted: number }) => seat.accepted === 0)).toBe(true);
    expect(seats[0].seat).not.toBe(seats[1].seat);
  });

  test("payload counters saturate at safe integers without increasing seat count", () => {
    const f = fixture();
    const collector = f.h.rooms.metrics!;
    for (let i = 0; i < 3; i++) collector.transmission(f.h.room!, Number.MAX_SAFE_INTEGER, true, false);
    collector.report(f.h.rooms.rooms.values(), 10_000);
    expect(JSON.parse(f.lines[0]).transmission.bytesSent).toBe(Number.MAX_SAFE_INTEGER);
    expect(JSON.parse(f.lines[0]).seats).toHaveLength(2);
  });

  test("metrics on/off produce identical authoritative states, checkpoints and replay journals", async () => {
    const disabled = new NetHarness({ seed: 18 }), enabled = new NetHarness({ seed: 18 });
    enabled.rooms.metrics = new NetplayMetrics(0, { log() {}, cpuUsage: () => ({ user: 0, system: 0 }) });
    for (const h of [disabled, enabled]) { h.startMatch(); h.playScript("a", 1500); h.advance(2000); }
    expect(enabled.a.commands).toEqual(disabled.a.commands);
    expect(enabled.a.messages).toEqual(disabled.a.messages);
    expect(enabled.room!.match!.saveState()).toEqual(disabled.room!.match!.saveState());
    expect(await enabled.room!.recorder!.buildIncompleteReplay()).toEqual(await disabled.room!.recorder!.buildIncompleteReplay());
  });

  test.each([undefined, "0", "true", "1"])("NETPLAY_METRICS=%s creates a collector and timer only for 1, and stop cleans it up", async flag => {
    const previous = process.env.NETPLAY_METRICS;
    if (flag === undefined) delete process.env.NETPLAY_METRICS; else process.env.NETPLAY_METRICS = flag;
    const cpu = spyOn(process, "cpuUsage");
    const output = spyOn(console, "log").mockImplementation(() => {});
    const intervals = spyOn(globalThis, "setInterval");
    const clears = spyOn(globalThis, "clearInterval");
    const rooms = new Rooms(() => 0);
    const app = createApp({ rooms, scheduled: false }).listen({ hostname: "127.0.0.1", port: 0 });
    try {
      await app.modules;
      expect(rooms.metrics !== undefined).toBe(flag === "1");
      expect(intervals.mock.calls.filter(args => args[1] === 10_000)).toHaveLength(flag === "1" ? 1 : 0);
      expect(cpu.mock.calls.length).toBe(flag === "1" ? 1 : 0);
      expect(output).toHaveBeenCalledTimes(0);
      const index = intervals.mock.calls.findIndex(args => args[1] === 10_000);
      const timer = index >= 0 ? intervals.mock.results[index].value : undefined;
      await app.stop(true);
      if (timer !== undefined) expect(clears.mock.calls.some(args => args[0] === timer)).toBe(true);
    } finally {
      await app.stop(true);
      cpu.mockRestore(); output.mockRestore(); intervals.mockRestore(); clears.mockRestore();
      if (previous === undefined) delete process.env.NETPLAY_METRICS; else process.env.NETPLAY_METRICS = previous;
    }
  });
});
