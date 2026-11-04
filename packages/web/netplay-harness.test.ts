import { describe, expect, test } from "bun:test";
import { FRAME_MS, Input } from "@42tris/core";
import type { ClientCommand } from "@42tris/protocol";
import { verifyMatchReplayExecution } from "@42tris/replay";
import { NetHarness } from "./netplay-harness";
import { useLegacyCheckpoints } from "../server/test/checkpoint-baseline";

async function verify(h: NetHarness) {
  const replay = await h.room!.recorder!.buildIncompleteReplay();
  expect(replay).not.toBeNull();
  expect((await verifyMatchReplayExecution(replay!)).state).toEqual(h.room!.match!.saveState());
}

describe("N-player latency harness", () => {
  test("N3-A future admission leaves mixed-latency players on the same authoritative timeline", async () => {
    const run = (early: boolean) => {
      const h = new NetHarness({ seed: 42, diagnostics: true, messageHistory: 16,
        players: [10, 30, 60, 90].map(ms => ({ up: ms, down: ms })) });
      h.startMatch();
      const cp = h.aCheckpoint!;
      const command: ClientCommand = { type: "inputBatch", matchId: cp.matchId!, generation: cp.owner.generation, epoch: cp.owner.epoch,
        items: [{ seq: cp.owner.nextSeq, frame: Math.floor((cp.clock.simulationNow + 200) / FRAME_MS), subframe: 0.25, input: Input.RotateCw }] };
      if (early) h.a.session.send(command);
      h.advance(200);
      if (!early) h.a.session.send(command);
      h.advance(200);
      expect(h.aCheckpoint!.owner.rejections).toEqual([]);
      expect(h.aCheckpoint!.owner.pendingAccepted).toEqual([]);
      for (const [i, client] of h.clients.slice(1).entries()) h.playScript(client.key, 30_000, 200 + i);
      h.advance(30_000);
      return h;
    };
    const lead = run(true), normal = run(false);
    expect(lead.room!.match!.saveState()).toEqual(normal.room!.match!.saveState());
    for (let i = 1; i < lead.clients.length; i++) {
      const a = lead.clients[i], b = normal.clients[i];
      expect(a.commands).toEqual(b.commands);
      expect(a.control).toEqual(b.control);
      expect(a.diagnostics!.snapshot().rejections).toEqual(b.diagnostics!.snapshot().rejections);
      expect(a.session.checkpoint).toEqual(b.session.checkpoint);
    }
    await verify(lead);
    await verify(normal);
  }, 60_000);

  test("a/b aliases preserve the two-client API and reject unsupported player counts", () => {
    const h = new NetHarness();
    expect(h.clients).toEqual([h.a, h.b]);
    expect(() => new NetHarness({ players: [{}] })).toThrow(RangeError);
    expect(() => new NetHarness({ players: Array.from({ length: 9 }, () => ({})) })).toThrow(RangeError);
  });

  test("optional message retention stays bounded without dropping delivery or byte accounting", () => {
    const bounded = new NetHarness({ diagnostics: true, messageHistory: 4 });
    const complete = new NetHarness({ diagnostics: true });
    for (const h of [bounded, complete]) { h.startMatch(); h.playScript("a", 1000); h.advance(1200); }
    expect(bounded.a.messages).toHaveLength(4);
    expect(complete.a.messages.length).toBeGreaterThan(4);
    expect(bounded.a.traffic).toEqual(complete.a.traffic);
    expect(bounded.a.diagnostics!.snapshot()).toEqual(complete.a.diagnostics!.snapshot());
    expect(bounded.room!.match!.saveState()).toEqual(complete.room!.match!.saveState());
    expect(bounded.aCheckpoint).toEqual(complete.aCheckpoint);
    expect(() => new NetHarness({ messageHistory: -1 })).toThrow(RangeError);
  });

  test.each([3, 4, 8])("%i authoritative players run 30 seconds of scripted competitive play and verify", async count => {
    const h = new NetHarness({ seed: 42, diagnostics: true, messageHistory: 16,
      players: Array.from({ length: count }, (_, i) => ({ up: 10 + i * 2, down: 10 + i * 2 })) });
    h.startMatch();
    expect(h.room!.match!.roster).toEqual(h.clients.map(c => c.session.playerId));
    for (const [i, client] of h.clients.entries()) h.playScript(client.key, 30_000, 200 + i);
    h.advance(30_000);
    for (const client of h.clients) {
      expect(client.batches.length).toBeGreaterThan(10);
      expect(client.diagnostics!.snapshot().rejections.total).toBe(0);
      expect(client.traffic.downBytes).toBeGreaterThan(0);
    }
    expect(h.room!.match!.round).toBeGreaterThan(1);
    await verify(h);
  }, 60_000);

  test("four mixed RTTs retain separate rejection and transport evidence", async () => {
    const h = new NetHarness({ diagnostics: true, messageHistory: 16, players: [10, 30, 90, 150].map(ms => ({ up: ms, down: ms })) });
    h.startMatch();
    for (const client of h.clients) h.playScript(client.key, 30_000, 8);
    h.advance(30_000);
    expect(h.a.diagnostics!.snapshot().rejections.total).toBe(0);
    expect(h.clients[3].diagnostics!.snapshot().rejections.total).toBeGreaterThan(0);
    expect(h.clients[3].control.blockedMs).toBeGreaterThan(h.a.control.blockedMs);
    expect(h.clients.map(c => c.traffic.downBytes).every(bytes => bytes > 0)).toBe(true);
    await verify(h);
  }, 60_000);

  test("seeded jitter and spikes reproduce and one link never mutates another", async () => {
    const run = () => {
      const h = new NetHarness({ diagnostics: true, seed: 71, commandHistory: Infinity, players: [{ jitter: 5, spikeChance: 0.1, spikeMs: 120 }, {}, {}] });
      h.startMatch();
      h.setLink("c", { down: 150, up: 150 });
      h.playScript("a", 2000);
      h.advance(2000);
      return h;
    };
    const first = run(), second = run();
    expect(first.a.commands).toEqual(second.a.commands);
    expect(first.a.diagnostics!.snapshot()).toEqual(second.a.diagnostics!.snapshot());
    expect(first.room!.match!.saveState()).toEqual(second.room!.match!.saveState());
    expect(first.b.diagnostics!.snapshot().rtt.min).toBeCloseTo(20, 6);
    await verify(first);
  });

  test("upstream holds preserve ordered batches and downstream-only holds leave frames running", async () => {
    const h = new NetHarness({ diagnostics: true });
    h.startMatch();
    h.holdUpstream("a", 120);
    h.script("a", [[0, Input.LeftDown], [15, Input.LeftUp], [60, Input.RotateCw]]);
    h.advance(119);
    expect(h.a.session.pending.length).toBeGreaterThan(0);
    expect(h.aCheckpoint!.owner.pendingAccepted).toHaveLength(0);
    h.holdDownstream("a", 300);
    h.advance(350);
    expect(h.a.commands.filter(c => c.type === "inputBatch").flatMap(c => c.items.map(i => i.seq))).toEqual([1, 2, 3]);
    expect(h.a.diagnostics!.snapshot().frames.maxGapMs!).toBeLessThan(18);
    await verify(h);
  });

  test("bounded outage and browser stall have different frame-gap evidence", async () => {
    const h = new NetHarness({ diagnostics: true, heartbeat: true, players: [{}, {}, {}] });
    h.startMatch();
    h.stall("a", 1100);
    h.outage("b", 1100);
    h.advance(1200);
    expect(h.a.diagnostics!.snapshot().frames.maxGapMs!).toBeGreaterThan(1000);
    expect(h.b.diagnostics!.snapshot().frames.maxGapMs!).toBeLessThan(18);
    expect(h.a.diagnostics!.snapshot().checkpoints.maxGapMs!).toBeGreaterThan(1000);
    expect(h.b.diagnostics!.snapshot().checkpoints.maxGapMs!).toBeGreaterThan(1000);
    expect(h.clients.every(c => c.session.connected)).toBe(true);
    await verify(h);
  });

  test("native heartbeat survives browser stalls and a long path outage pauses the real room", () => {
    const h = new NetHarness({ diagnostics: true, heartbeat: true });
    h.startMatch();
    h.stall("a", 6500);
    h.advance(6500);
    expect(h.a.connections).toBe(1);
    expect(h.room!.phase).toBe("playing");
    h.outage("a", 6500);
    h.advance(6100);
    expect(h.room!.phase).toBe("paused");
    expect(h.b.session.checkpoint!.clock.frozen).toBe(true);
    h.advance(500);
    expect(h.a.diagnostics!.snapshot().events.some(e => e.type === "connection" && !e.connected)).toBe(true);
  });

  test.each([false, true])("bandwidth FIFO with backpressure %s bounds visible queues and separates clients", async backpressure => {
    const h = new NetHarness({ diagnostics: true });
    h.startMatch();
    const before = h.a.traffic.downBytes;
    h.setLink("a", { downBytesPerSec: 20_000, backpressure });
    h.advance(5000);
    expect(h.a.traffic.downBytes - before).toBeLessThan(110_000);
    expect(h.b.traffic.downBytes).toBeGreaterThan(h.a.traffic.downBytes);
    expect(h.a.traffic.skippedCheckpoints > 0).toBe(backpressure);
    expect(h.b.traffic.skippedCheckpoints).toBe(0);
    await verify(h);
  });

  test("practice still creates no competitive recorder", () => {
    const h = new NetHarness({ players: [{}, {}, {}] });
    h.startMatch({ mode: "practice" });
    h.playScript("c", 2000);
    h.advance(2000);
    expect(h.room!.recorder).toBeUndefined();
  });
});

/** Real Sessions/Rooms with no room or frame-generated pings, for exact transport measurements. */
function quietLink() {
  const h = new NetHarness({ frameMs: 1_000_000, a: { up: 0, down: 0 }, b: { up: 0, down: 0 } });
  h.runUntil(() => h.clients.every(c => c.session.connected));
  return h;
}

function packet(bytes: number, tag: string, serverNow: number) {
  const overhead = Buffer.byteLength(JSON.stringify({ type: "pong", nonce: "", serverNow }));
  const message = { type: "pong" as const, nonce: tag.padEnd(bytes - overhead, "x"), serverNow };
  expect(Buffer.byteLength(JSON.stringify(message))).toBe(bytes);
  return message;
}

function delivered(h: NetHarness, nonce: string): number {
  return h.a.messages.filter(m => m.type === "pong" && m.nonce === nonce).length;
}

describe("socket byte queues and bounded inspection", () => {
  test("five seconds of hold do not turn a 48-byte pong into 500 KB of backlog", () => {
    const h = new NetHarness();
    h.startMatch();
    h.setLink("a", { downBytesPerSec: 100_000, backpressure: true });
    h.holdDownstream("a", 5000);
    const message = { type: "pong" as const, nonce: "probe", serverNow: h.time };
    const bytes = Buffer.byteLength(JSON.stringify(message));
    expect(bytes).toBe(48);
    h.a.peer!.send(message);
    expect(h.queuedBytes("a")).toBe(bytes);
    expect(h.bufferedBytes("a")).toBe(bytes);
    const skips = h.a.traffic.skippedCheckpoints;
    h.rooms.checkpoint(h.room!, h.room!.seats[0]);
    expect(h.a.traffic.skippedCheckpoints).toBe(skips);
    const remaining = 65_536 - h.queuedBytes("a");
    h.a.peer!.send(packet(remaining, "fill", h.time));
    expect(h.bufferedBytes("a")).toBe(65_536);
    h.rooms.checkpoint(h.room!, h.room!.seats[0]); // exactly 64 KiB still admits
    expect(h.a.traffic.skippedCheckpoints).toBe(skips);
    const queued = h.queuedBytes("a");
    expect(queued).toBeGreaterThan(65_536);
    h.rooms.checkpoint(h.room!, h.room!.seats[0]);
    expect(h.a.traffic.skippedCheckpoints).toBe(skips + 1);
    expect(h.queuedBytes("a")).toBe(queued);
  });

  test("an already scheduled 1043-byte transfer gets no service during a three-second hold", () => {
    const h = quietLink();
    h.setLink("a", { downBytesPerSec: 1000, backpressure: true });
    const message = packet(1043, "queued", h.time);
    h.a.peer!.send(message);
    h.holdDownstream("a", 3000);
    h.advance(3000);
    expect(delivered(h, message.nonce)).toBe(0);
    expect(h.queuedBytes("a")).toBe(1043);
    h.advance(1042);
    expect(delivered(h, message.nonce)).toBe(0);
    expect(h.queuedBytes("a")).toBeCloseTo(1, 6);
    h.advance(1);
    expect(delivered(h, message.nonce)).toBe(1);
    expect(h.queuedBytes("a")).toBe(0);
    h.advance(1000);
    expect(delivered(h, message.nonce)).toBe(1);
  });

  test("partial service, extended outages and multiple payloads resume in FIFO order with correct spacing", () => {
    const h = quietLink();
    h.setLink("a", { downBytesPerSec: 1000, backpressure: true, hiddenBufferBytes: 100 });
    const first = packet(1043, "first", h.time), second = packet(500, "second", h.time);
    h.a.peer!.send(first);
    h.advance(400);
    expect(h.queuedBytes("a")).toBeCloseTo(643, 6);
    h.outage("a", 2000);
    h.a.peer!.send(second);
    expect(h.bufferedBytes("a")).toBeCloseTo(1043, 6);
    h.advance(1000);
    h.outage("a", 2000); // extend the same unavailable interval by one second
    h.advance(2000);
    expect(h.queuedBytes("a")).toBeCloseTo(1143, 6);
    expect(delivered(h, first.nonce)).toBe(0);
    h.advance(643);
    expect(delivered(h, first.nonce)).toBe(1);
    expect(delivered(h, second.nonce)).toBe(0);
    expect(h.queuedBytes("a")).toBeCloseTo(500, 6);
    h.advance(499);
    expect(delivered(h, second.nonce)).toBe(0);
    h.advance(1);
    expect(h.a.messages.filter(m => m.type === "pong").map(m => m.nonce)).toEqual([first.nonce, second.nonce]);
    expect(h.bufferedBytes("a")).toBe(0);
    h.advance(4000);
    expect(delivered(h, first.nonce)).toBe(1);
    expect(delivered(h, second.nonce)).toBe(1);
  });

  test("upstream service pauses too, and queued pings reach real Rooms in order after recovery", () => {
    const h = quietLink();
    h.setLink("a", { upBytesPerSec: 1000 });
    const one = { type: "ping" as const, nonce: "first" }, two = { type: "ping" as const, nonce: "second" };
    const firstBytes = Buffer.byteLength(JSON.stringify(one)), secondBytes = Buffer.byteLength(JSON.stringify(two));
    h.a.session.send(one);
    h.advance(10);
    h.holdUpstream("a", 1000);
    h.a.session.send(two);
    h.advance(1000);
    expect(h.queuedBytes("a", "up")).toBeCloseTo(firstBytes - 10 + secondBytes, 6);
    expect(delivered(h, "first")).toBe(0);
    h.advance(firstBytes - 10);
    expect(delivered(h, "first")).toBe(1);
    expect(delivered(h, "second")).toBe(0);
    h.advance(secondBytes);
    expect(h.a.messages.filter(m => m.type === "pong").map(m => m.nonce)).toEqual(["first", "second"]);
    expect(h.queuedBytes("a", "up")).toBe(0);
  });

  test("browser stalls gate delivery without suspending bandwidth, and propagation does not count as queued bytes", () => {
    const h = quietLink();
    h.setLink("a", { down: 100, downBytesPerSec: 1000, backpressure: true });
    const first = packet(1000, "first", h.time), second = packet(500, "second", h.time);
    h.a.peer!.send(first); h.a.peer!.send(second);
    h.stall("a", 2000);
    h.advance(1500);
    expect(h.bufferedBytes("a")).toBe(0);
    expect(delivered(h, first.nonce)).toBe(0);
    h.holdDownstream("a", 1000); // both payloads have already completed byte service
    h.advance(1000);
    expect(h.a.messages.filter(m => m.type === "pong").map(m => m.nonce)).toEqual([first.nonce, second.nonce]);
    expect(h.queuedBytes("a")).toBe(0);
  });

  test("rate changes settle old service before changing rate, without inventing bytes", () => {
    const h = quietLink();
    h.setLink("a", { downBytesPerSec: 1000, backpressure: true });
    const message = packet(2000, "rate", h.time);
    h.a.peer!.send(message);
    h.advance(500);
    h.setLink("a", { downBytesPerSec: 2000 });
    expect(h.queuedBytes("a")).toBeCloseTo(1500, 6);
    h.advance(749);
    expect(delivered(h, message.nonce)).toBe(0);
    h.advance(1);
    expect(delivered(h, message.nonce)).toBe(1);
  });

  test("sub-millisecond completions settle exactly without residual-byte scheduler loops", () => {
    const h = quietLink();
    h.advance(10_000);
    h.setLink("a", { downBytesPerSec: 100_000_000, backpressure: true });
    const messages = Array.from({ length: 8 }, (_, i) => packet(1043 + i, `tiny-${i}`, h.time));
    for (const message of messages) h.a.peer!.send(message);
    h.advance(1);
    expect(h.a.messages.filter(m => m.type === "pong").map(m => m.nonce)).toEqual(messages.map(m => m.nonce));
    expect(h.queuedBytes("a")).toBe(0);
  });

  test.each([[69_673, true], [69_504, false]] as const)("retry discards a %i-byte old backlog and delivers a new welcome without another attempt", async (expectedBytes, legacy) => {
    const h = new NetHarness({ messageHistory: 0 });
    if (legacy) useLegacyCheckpoints(h.rooms);
    h.startMatch();
    const player = h.a.session.playerId;
    h.setLink("a", { downBytesPerSec: 1000, backpressure: true });
    h.advance(1000);
    expect(h.bufferedBytes("a")).toBeCloseTo(expectedBytes, 3);
    const oldPeer = h.a.peer!;
    const retryAt = h.time;
    h.a.session.retry();
    expect(h.queuedBytes("a")).toBe(0);
    oldPeer.send(packet(100_000, "obsolete", h.time));
    expect(h.queuedBytes("a")).toBe(0);
    let welcomeBytes = 0;
    const send = h.a.peer!.send;
    h.a.peer!.send = (message, ephemeral) => {
      if (message.type === "welcome") welcomeBytes = Buffer.byteLength(JSON.stringify(message));
      send(message, ephemeral);
    };
    h.runUntil(() => h.a.session.connected, 2000);
    // 5 ms open + 10 ms upstream + payload service at 1000 B/s + 10 ms downstream.
    expect(welcomeBytes).toBeGreaterThan(0);
    expect(h.time - retryAt).toBeGreaterThanOrEqual(25 + welcomeBytes);
    expect(h.time - retryAt).toBeLessThan(30 + welcomeBytes);
    h.advance(7000 - (h.time - retryAt));
    expect(h.a.connections).toBe(2);
    expect(h.a.session.connected).toBe(true);
    expect(h.a.session.playerId).toBe(player);
    h.setLink("a", { downBytesPerSec: 10_000_000 });
    h.runUntil(() => h.clients.every(c => c.session.canPlay), 8000);
    h.press("a", Input.RotateCw); h.advance(100);
    expect(h.a.connections).toBe(2);
    await verify(h);
  });

  test("closing cancels both unsent and already serviced in-flight messages belonging to the old socket", () => {
    const h = quietLink();
    h.setLink("a", { down: 500 });
    const oldPeer = h.a.peer!, old = packet(1000, "old-inflight", h.time);
    oldPeer.send(old); // service is complete, delivery is still pending
    h.setLink("a", { upBytesPerSec: 1000, downBytesPerSec: 1000 });
    oldPeer.send(packet(100_000, "old-unsent", h.time));
    h.a.session.send({ type: "ping", nonce: "old-upstream" });
    h.a.session.retry();
    expect(h.queuedBytes("a")).toBe(0);
    expect(h.queuedBytes("a", "up")).toBe(0);
    h.runUntil(() => h.a.session.connected, 2000);
    h.a.session.send({ type: "ping", nonce: "replacement" });
    h.advance(2000);
    expect(h.a.connections).toBe(2);
    expect(h.a.messages.filter(m => m.type === "welcome")).toHaveLength(2);
    expect(h.a.messages.filter(m => m.type === "pong").map(m => m.nonce)).toEqual(["replacement"]);
    expect(h.queuedBytes("a")).toBe(0);
    h.advance(101_000); // cross the abandoned transfer's former completion deadline
    expect(h.a.messages.filter(m => m.type === "pong").map(m => m.nonce)).toEqual(["replacement"]);
    expect(h.a.connections).toBe(2);
  });

  test("reconnect clears socket queues while preserving a two-way path outage, then resumes and verifies", async () => {
    const h = new NetHarness({ diagnostics: true, heartbeat: true });
    h.startMatch();
    h.setLink("a", { upBytesPerSec: 1000, downBytesPerSec: 1000, backpressure: true });
    h.outage("a", 3000);
    const oldPeer = h.a.peer!, old = packet(10_000, "old", h.time);
    oldPeer.send(old);
    h.a.session.retry();
    expect(h.queuedBytes("a")).toBe(0);
    h.advance(2999);
    expect(h.a.session.connected).toBe(false);
    expect(h.a.connections).toBe(2);
    expect(h.queuedBytes("a", "up")).toBeGreaterThan(0);
    expect(h.queuedBytes("a")).toBe(0);
    h.advance(1);
    h.runUntil(() => h.a.session.connected, 2000);
    expect(delivered(h, old.nonce)).toBe(0);
    h.setLink("a", { upBytesPerSec: 10_000_000, downBytesPerSec: 10_000_000 });
    h.runUntil(() => h.clients.every(c => c.session.canPlay), 8000);
    expect(h.a.connections).toBe(2);
    await verify(h);
  });

  test("players API has bounded defaults and sustained eight-player traffic keeps all histories within them", async () => {
    const h = new NetHarness({ diagnostics: true, players: Array.from({ length: 8 }, () => ({})) });
    h.startMatch();
    const errors = h.clients.map(client => {
      const counts: Record<string, number> = {};
      const send = client.peer!.send;
      client.peer!.send = (message, ephemeral) => {
        if (message.type === "error") counts[message.code] = (counts[message.code] ?? 0) + 1;
        send(message, ephemeral);
      };
      return counts;
    });
    h.clients.forEach((client, i) => h.playScript(client.key, 15_000, i + 1));
    for (let i = 0; i < 300; i++) {
      for (const client of h.clients) h.press(client.key, Input.RotateCw);
      h.advance(50);
    }
    h.advance(100); // drain final input/error deliveries before comparing cumulative evidence
    for (const [index, client] of h.clients.entries()) {
      expect(client.messages).toHaveLength(16);
      expect(client.commands.length).toBeLessThanOrEqual(256);
      expect(client.batches.length).toBeLessThanOrEqual(128);
      expect(client.traffic.downMessages).toBeGreaterThan(client.messages.length);
      expect(client.commands.length).toBe(Math.min(256, client.traffic.upMessages));
      expect(client.batches.length).toBe(Math.min(128, client.traffic.inputBatches));
      expect(client.traffic.inputItems).toBe(client.diagnostics!.snapshot().inputs.sent);
      // A final press can race an authoritative round end; retain that real rejection evidence.
      expect(Object.keys(errors[index]).every(code => code === "WRONG_PHASE")).toBe(true);
      expect(client.diagnostics!.snapshot().rejections.byCode).toEqual(errors[index]);
    }
    expect(h.clients.some(c => c.traffic.upMessages > c.commands.length)).toBe(true);
    expect(h.clients.some(c => c.traffic.inputBatches > c.batches.length)).toBe(true);
    expect(h.room!.match!.round).toBeGreaterThan(1);
    await verify(h);
  }, 60_000);

  test("zero/small inspection caps and explicit complete capture preserve delivery, diagnostics, authority and journals", async () => {
    const run = (limit: number) => {
      const h = new NetHarness({ diagnostics: true, players: [{}, {}],
        messageHistory: limit, commandHistory: limit, batchHistory: limit });
      h.startMatch();
      h.setLink("a", { upBytesPerSec: 20_000, downBytesPerSec: 100_000, backpressure: true });
      h.outage("a", 500);
      h.clients.forEach(c => h.playScript(c.key, 2000));
      h.advance(200);
      h.a.session.retry(); // close during the outage with both inspection caps and live queues in use
      h.advance(2300);
      h.runUntil(() => h.clients.every(c => c.session.canPlay), 8000);
      h.clients.forEach(c => h.playScript(c.key, 500));
      h.advance(600);
      expect(h.a.connections).toBe(2);
      return h;
    };
    const complete = run(Infinity);
    const replay = await complete.room!.recorder!.buildIncompleteReplay();
    for (const limit of [0, 3]) {
      const h = run(limit);
      for (let i = 0; i < 2; i++) {
        const client = h.clients[i], other = complete.clients[i];
        expect(client.messages.length).toBeLessThanOrEqual(limit);
        expect(client.commands.length).toBeLessThanOrEqual(limit);
        expect(client.batches.length).toBeLessThanOrEqual(limit);
        expect(client.traffic).toEqual(other.traffic);
        expect(client.diagnostics!.snapshot()).toEqual(other.diagnostics!.snapshot());
        expect(client.session.checkpoint).toEqual(other.session.checkpoint);
        expect(client.session.pending).toEqual(other.session.pending);
      }
      expect(h.room!.match!.saveState()).toEqual(complete.room!.match!.saveState());
      expect(await h.room!.recorder!.buildIncompleteReplay()).toEqual(replay);
      await verify(h);
    }
    for (const c of complete.clients) {
      expect(c.messages.length).toBe(c.traffic.downMessages);
      expect(c.commands.length).toBe(c.traffic.upMessages);
      expect(c.batches.length).toBe(c.traffic.inputBatches);
    }
  });

  test("legacy a/b defaults keep complete capture and invalid limits fail explicitly", () => {
    const h = new NetHarness();
    h.startMatch();
    h.clients.forEach((client, i) => h.playScript(client.key, 15_000, i + 1));
    for (let i = 0; i < 300; i++) {
      for (const client of h.clients) {
        client.session.send({ type: "ping", nonce: String(i) });
        h.press(client.key, Input.RotateCw);
      }
      h.advance(50);
    }
    expect(h.a.traffic.upMessages).toBeGreaterThan(256);
    expect(h.a.traffic.inputBatches).toBeGreaterThan(128);
    expect(h.a.messages.length).toBe(h.a.traffic.downMessages);
    expect(h.a.commands.length).toBe(h.a.traffic.upMessages);
    expect(h.a.batches.length).toBe(h.a.traffic.inputBatches);
    expect(() => new NetHarness({ commandHistory: -1 })).toThrow(RangeError);
    expect(() => new NetHarness({ batchHistory: NaN })).toThrow(RangeError);
    expect(() => new NetHarness({ messageHistory: 1.5 })).toThrow(RangeError);
  });
});
