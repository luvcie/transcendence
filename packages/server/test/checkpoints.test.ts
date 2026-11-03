import { describe, expect, spyOn, test } from "bun:test";
import { DEFAULT_HANDLING, Input } from "@42tris/core";
import { Match } from "@42tris/match";
import type { Checkpoint } from "@42tris/protocol";
import { decodeReplayJson, isMatchReplay, verifyMatchReplayExecution } from "@42tris/replay";
import { NetHarness } from "../../web/netplay-harness";
import { useLegacyCheckpoints } from "./checkpoint-baseline";

function fixture(count = 2, firstTo = 7, mode: "competitive" | "practice" = "competitive") {
  const h = new NetHarness({ seed: 42, players: Array.from({ length: count }, () => ({})), diagnostics: true });
  h.startMatch({ firstTo, mode });
  return h;
}

function checkpoint(h: NetHarness, index = 0): Checkpoint {
  const send = spyOn(h.clients[index].peer!, "send");
  try {
    h.rooms.checkpoint(h.room!, h.room!.seats[index]);
    expect(send.mock.calls.at(-1)?.[1]).toBe(true);
    return send.mock.calls.at(-1)![0] as Checkpoint;
  } finally { send.mockRestore(); }
}

function releases(h: NetHarness, count: number): void {
  for (let i = 0; i < count; i++) h.rooms.receive(h.a.peer!.id, { type: "releaseControls" });
}

function resultReleases(h: NetHarness): void {
  // Completed sets ignore user releases. Exercise valid authoritative releases
  // through the recorder, then let the room drain them through its normal path.
  for (let i = 0; i < 24; i++) h.room!.recorder!.releaseControls(h.room!.match!.roster[0]);
  releases(h, 1);
}

function expectOrdered(events: Checkpoint["events"]): void {
  const sequences = events.map(e => e.sequence);
  expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
  expect(new Set(sequences).size).toBe(sequences.length);
}

describe("checkpoint events", () => {
  test.each([2, 8, 16, 17])("selects the newest events from a %i-event history without mutating it", count => {
    const h = fixture();
    releases(h, count - h.room!.events.length);
    const history = structuredClone(h.room!.events), original = h.room!.events;
    const cp = checkpoint(h);
    expect(cp.events).toEqual(history.slice(-1));
    expect(cp.events).not.toBe(original);
    expect(cp.events[0].event).not.toBe(original.at(-1)!.event);
    expect(h.room!.events).toBe(original);
    expect(h.room!.events).toEqual(history);
    expectOrdered(cp.events);
  });

  test("retains an old round result through a paused countdown and drops it in the next round", () => {
    const h = fixture();
    h.dropOut("b");
    expect(h.room!.phase).toBe("roundResult");
    const result = h.room!.events.find(e => e.event.type === "roundEnd")!;
    releases(h, 24);
    expect(h.room!.events.indexOf(result)).toBeLessThan(h.room!.events.length - 16);
    const history = structuredClone(h.room!.events);
    const cp = checkpoint(h);
    expect(cp.events.filter(e => e.event.type === "roundEnd")).toEqual([result]);
    expect(cp.events).toHaveLength(2);
    expectOrdered(cp.events);
    expect(h.room!.events).toEqual(history);
    h.a.session.retry();
    h.runUntil(() => h.a.connections === 2 && h.a.session.connected);
    expect(h.room!.phase).toBe("roundResult");
    expect(checkpoint(h).events).toContainEqual(result);
    h.runUntil(() => h.room!.match!.round === 2, 5000);
    expect(checkpoint(h).events.some(e => e.event.type === "roundEnd" || e.event.type === "setEnd")).toBe(false);
    expect(h.room!.events).toContainEqual(result);
  });

  test.each(["firstTo", "forfeit"] as const)("keeps old %s results, without duplicates, then clears them for a rematch", reason => {
    const h = fixture(reason === "forfeit" ? 3 : 2, 1);
    if (reason === "firstTo") h.dropOut("b");
    else {
      h.b.session.send({ type: "leave" });
      h.clients[2].session.send({ type: "leave" });
      h.advance(100);
    }
    expect(h.room!.phase).toBe("setResult");
    const results = h.room!.events.filter(e => e.event.type === "roundEnd" || e.event.type === "setEnd");
    expect(results.at(-1)!.event).toMatchObject({ type: "setEnd", winner: h.a.session.playerId, reason });
    expect(checkpoint(h).events.filter(e => e.event.type === "roundEnd" || e.event.type === "setEnd")).toEqual(results);
    resultReleases(h);
    expect(results.every(e => h.room!.events.indexOf(e) < h.room!.events.length - 16)).toBe(true);
    const history = structuredClone(h.room!.events);
    const cp = checkpoint(h);
    expect(cp.events.filter(e => e.event.type === "roundEnd" || e.event.type === "setEnd")).toEqual(results);
    expectOrdered(cp.events);
    expect(cp.events).toHaveLength(3);
    expect(h.room!.events).toEqual(history);
    if (reason === "forfeit") {
      h.b.session.send({ type: "join", code: h.room!.code });
      h.advance(50);
    }
    const oldMatchId = h.room!.matchId;
    for (const c of h.clients.slice(0, 2)) c.session.send({ type: "ready", ready: true, handling: DEFAULT_HANDLING });
    h.runUntil(() => h.room!.matchId !== oldMatchId);
    const rematch = checkpoint(h);
    expect(rematch.state!.round).toBe(1);
    expect(rematch.events.some(e => e.event.type === "roundEnd" || e.event.type === "setEnd")).toBe(false);
    expect(h.room!.events.some(e => e.event.type === "roundEnd" || e.event.type === "setEnd")).toBe(false);
  });

  test("simultaneous expiry supersedes a provisional forfeit with aborted while preserving recorder history", async () => {
    const h = fixture(3);
    h.clients.forEach(c => h.rooms.disconnect(c.peer!.id));
    h.advance(40_000);
    expect(h.room!.phase).toBe("setResult");
    const sets = h.room!.events.filter(e => e.event.type === "setEnd");
    expect(sets).toHaveLength(1);
    expect(sets[0].event).toMatchObject({ winner: null, reason: "aborted" });
    // A late joiner can see the completed result without joining the old Match roster.
    h.a.session.anotherGuest();
    h.runUntil(() => h.a.session.connected);
    h.a.session.send({ type: "join", code: h.room!.code });
    h.runUntil(() => h.room!.seats.length === 1);
    resultReleases(h);
    const cp = checkpoint(h);
    expect(cp.state!.roster).not.toContain(h.a.session.playerId);
    expect(cp.events.filter(e => e.event.type === "setEnd")).toEqual(sets);
    expect(cp.owner.epoch).toBe(0);
    const replay = await h.room!.recorder!.finish();
    expect(replay!.summary).toMatchObject({ winner: null, reason: "aborted" });
    expect((await verifyMatchReplayExecution(replay!)).complete).toBe(true);
  });

  test.each([2, 8])("%i-player mature gameplay retains the internal 256-event history and sends a pruned full snapshot", async count => {
    const h = fixture(count, 100);
    for (let chunk = 0; h.room!.eventSequence < 320 || h.room!.phase !== "playing"; chunk++) {
      expect(chunk).toBeLessThan(36);
      h.clients.forEach((c, i) => h.playScript(c.key, 5000, 200 + i + chunk * 101));
      h.advance(5000);
    }
    expect(h.room!.events).toHaveLength(256);
    const original = h.room!.events, history = structuredClone(original);
    const state = h.room!.match!.saveState();
    const cp = checkpoint(h);
    expect(cp.events).toEqual(history.filter(e => e.event.type !== "roundEnd" && e.event.type !== "setEnd").slice(-1));
    expectOrdered(cp.events);
    expect(h.room!.events).toBe(original);
    expect(h.room!.events).toEqual(history);
    expect(cp.state).toEqual(state);
    expect(Match.fromState(cp.state!).saveState()).toEqual(state);
    const bytes = new TextEncoder().encode(JSON.stringify(cp)).byteLength;
    const legacyBytes = new TextEncoder().encode(JSON.stringify({ ...cp, events: history })).byteLength;
    expect(bytes).toBeLessThan(legacyBytes / 4);
    expect(bytes).toBeLessThan(count === 2 ? 8000 : 30_000);
    const replay = await h.room!.recorder!.buildIncompleteReplay();
    expect(replay).not.toBeNull();
    expect((await verifyMatchReplayExecution(replay!)).state).toEqual(state);
  }, 120_000);
});

describe("shared authoritative checkpoints", () => {
  test("one eight-player broadcast saves once and keeps pending, resolved, rejected, generation and epoch acknowledgments per seat", () => {
    const h = fixture(8, 7, "practice"), room = h.room!, match = room.match!;
    h.advance(500);
    // Each seat consumes a different number of sequences and receives a distinct rejection.
    room.seats.forEach((seat, i) => {
      if (i % 2) h.rooms.receive(h.clients[i].peer!.id, { type: "practiceReset" });
      h.rooms.receive(h.clients[i].peer!.id, { type: "inputBatch", matchId: room.matchId!, generation: seat.generation,
        epoch: match.playerEpoch(seat.id), items: [
          ...Array.from({ length: i + 1 }, (_, j) => ({ seq: j + 1, frame: match.frame, subframe: 0, input: Input.RotateCw })),
          { seq: i + 2, frame: 0, subframe: 0, input: Input.HardDrop },
        ] });
    });
    const expected = room.seats.map((_, i) => checkpoint(h, i).owner);
    const sends = h.clients.map(c => spyOn(c.peer!, "send")), save = spyOn(match, "saveState");
    try {
      h.rooms.snapshots();
      expect(save).toHaveBeenCalledTimes(1);
      const checkpoints = sends.map(s => s.mock.calls.at(-1)![0] as Checkpoint);
      const first = checkpoints[0];
      for (const [i, cp] of checkpoints.entries()) {
        expect(cp.owner).toEqual(expected[i]);
        expect(cp.owner.pendingAccepted).toHaveLength(i + 1);
        expect(cp.owner.rejections).toEqual([{ seq: i + 2, code: "INPUT_REJECTED" }]);
        expect(cp.owner.resolvedThroughSeq).toBe(0);
        expect(cp.owner.nextSeq).toBe(i + 3);
        expect(cp.owner.epoch).toBe(i % 2);
        expect(cp.state).toBe(first.state);
        expect(cp.room).toBe(first.room);
        expect(cp.clock).toBe(first.clock);
        expect(cp.events).toBe(first.events);
        expect(cp.serverNow).toBe(first.serverNow);
        expect(cp.serverSequence).toBe(first.serverSequence + i);
        expect(sends[i].mock.calls.at(-1)![1]).toBe(true);
        if (i) expect(cp.owner).not.toBe(first.owner);
      }
      const before = structuredClone(checkpoints);
      h.rooms.receive(h.a.peer!.id, { type: "releaseControls" });
      h.advance(250);
      expect(checkpoints).toEqual(before);
      for (let i = 1; i < 8; i++) {
        expect(checkpoint(h, i).owner).toMatchObject({ pendingAccepted: [], resolvedThroughSeq: i + 2 });
      }
      expect(checkpoint(h).serverSequence).toBeGreaterThan(checkpoints.at(-1)!.serverSequence);
    } finally { sends.forEach(s => s.mockRestore()); save.mockRestore(); }
  });

  test("single-seat resync and release use the shared builder and keep complete state; disconnected rooms do no snapshot work", () => {
    const h = fixture(), room = h.room!, match = room.match!;
    const save = spyOn(match, "saveState"), send = spyOn(h.a.peer!, "send");
    try {
      h.rooms.receive(h.a.peer!.id, { type: "resync" });
      expect(save).toHaveBeenCalledTimes(1);
      const cp = send.mock.calls.at(-1)![0] as Checkpoint;
      expect(cp.state).toEqual(save.mock.results[0].value as Checkpoint["state"]);
      expect(cp.events).toEqual(room.events.slice(-1));
      h.rooms.receive(h.a.peer!.id, { type: "releaseControls" });
      expect(save).toHaveBeenCalledTimes(2);
      const released = send.mock.calls.at(-1)![0] as Checkpoint;
      expect(released.owner.generation).toBe(cp.owner.generation + 1);
      expect(released.owner.epoch).toBe(cp.owner.epoch);
      expect(released.serverSequence).toBeGreaterThan(cp.serverSequence);
      h.clients.forEach(c => h.rooms.disconnect(c.peer!.id));
      save.mockClear();
      h.rooms.snapshots();
      h.rooms.checkpoint(room, room.seats[0]);
      expect(save).not.toHaveBeenCalled();
    } finally { save.mockRestore(); send.mockRestore(); }
  });

  test("waiting rooms keep null authoritative state and separate acknowledgments", () => {
    const h = new NetHarness();
    h.runUntil(() => h.a.session.connected && h.b.session.connected);
    h.a.session.send({ type: "create", requestId: "waiting", options: { firstTo: 2, mode: "competitive", attacksEnabled: true } });
    h.runUntil(() => !!h.room);
    h.b.session.send({ type: "join", code: h.room!.code });
    h.runUntil(() => h.room!.seats.length === 2);
    h.rooms.receive(h.a.peer!.id, { type: "releaseControls" });
    const a = checkpoint(h), b = checkpoint(h, 1);
    for (const cp of [a, b]) {
      expect(cp).toMatchObject({ state: null, matchId: null, events: [], roundDurations: [], clock: { frozen: true, simulationNow: 0 } });
      expect(cp.owner.epoch).toBe(0);
    }
    expect(a.owner.generation).toBe(b.owner.generation + 1);
    expect(b.serverSequence).toBeGreaterThan(a.serverSequence);
  });

  test("legacy and optimized checkpoints preserve authority, client inputs and byte-identical verified replay journals", async () => {
    const optimized = fixture(), baseline = new NetHarness({ seed: 42, players: [{}, {}], diagnostics: true });
    useLegacyCheckpoints(baseline.rooms);
    baseline.startMatch();
    for (const h of [baseline, optimized]) {
      h.clients.forEach((c, i) => h.playScript(c.key, 4000, 21 + i));
      h.advance(4200);
      h.a.session.retry();
      h.runUntil(() => h.a.session.canPlay, 8000);
      h.dropOut("b");
      h.runUntil(() => h.room!.phase === "playing", 5000);
      h.b.session.send({ type: "leave" });
      h.advance(100);
    }
    expect(optimized.room!.match!.saveState()).toEqual(baseline.room!.match!.saveState());
    expect(optimized.room!.events).toEqual(baseline.room!.events);
    optimized.clients.forEach((c, i) => expect(c.commands).toEqual(baseline.clients[i].commands));
    const oldReplay = await baseline.room!.recorder!.finish(), replay = await optimized.room!.recorder!.finish();
    expect(replay).not.toBeNull();
    expect(replay).toEqual(oldReplay);
    expect(optimized.room!.recorder!.json).toBe(baseline.room!.recorder!.json);
    const decoded = await decodeReplayJson(baseline.room!.recorder!.json!);
    expect(isMatchReplay(decoded)).toBe(true);
    if (!isMatchReplay(decoded)) throw new Error("Expected a competitive Match replay");
    expect((await verifyMatchReplayExecution(decoded)).state).toEqual(optimized.room!.match!.saveState());
  });
});
