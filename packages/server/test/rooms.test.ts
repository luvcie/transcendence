import { describe, expect, test } from "bun:test";
import { DEFAULT_HANDLING, FRAME_MS, Input } from "@42tris/core";
import { Match, OwnerPrediction } from "@42tris/match";
import { MAX_INPUT_LEAD_MS, type Checkpoint, type ClientCommand, type InputItem, type ServerMessage } from "@42tris/protocol";
import { Rooms, type Peer } from "../src/rooms";
import { createApp } from "../src/app";
import { CURRENT_REPLAY_VERSIONS, decodeReplayJson, MatchPlayback, verifyMatchReplayExecution, type MatchRecorderOptions } from "@42tris/replay";

interface TestClient {
  peer: Peer;
  send(command: ClientCommand): void;
  messages: ServerMessage[];
  closed: number[];
  welcome: Extract<ServerMessage, { type: "welcome" }> | undefined;
  checkpoint(): Checkpoint;
}

function fixture(count = 2, mode: "competitive" | "practice" = "competitive", firstTo = 2, width?: number, replayOptions?: MatchRecorderOptions) {
  let now = 0;
  const rooms = new Rooms(() => now, replayOptions);
  const clients: TestClient[] = [];
  function client(token?: string, skin?: string): TestClient {
    const messages: ServerMessage[] = [];
    const closed: number[] = [];
    const peer: Peer = { id: crypto.randomUUID(), send: m => messages.push(m), close: code => { closed.push(code); } };
    rooms.connect(peer);
    const send = (command: ClientCommand) => rooms.receive(peer.id, command);
    send({ type: "hello", name: "Guest", guestProfileId: "same-profile", ...(token ? { resumeToken: token } : {}), ...(skin ? { skin } : {}) });
    const welcome = messages.find(m => m.type === "welcome");
    const checkpoint = () => { send({ type: "resync" }); return [...messages].reverse().find(m => m.type === "checkpoint") as Checkpoint; };
    const c = { peer, send, messages, closed, welcome, checkpoint };
    clients.push(c);
    return c;
  }
  const a = client();
  a.send({ type: "create", requestId: "one", options: { firstTo, mode, attacksEnabled: true, maxPlayers: 8, ...(width === undefined ? {} : { width }) } });
  const room = [...rooms.rooms.values()][0];
  for (let i = 1; i < count; i++) client().send({ type: "join", code: room.code });
  function elapse(ms: number) { now += ms; }
  function advance(ms: number) { elapse(ms); rooms.tick(); }
  function prepared() {
    for (const c of clients) if (room.seats.some(s => s.peer?.id === c.peer.id)) c.send({ type: "prepared", matchId: room.matchId!, preparationId: room.preparationId });
    advance(3000);
  }
  function start() { for (const c of clients) c.send({ type: "ready", ready: true, handling: DEFAULT_HANDLING }); prepared(); }
  return { rooms, clients, a, room, client, elapse, advance, start, prepared };
}

describe("N3-A bounded future input admission", () => {
  function batch(cp: Checkpoint, items: InputItem[]): Extract<ClientCommand, { type: "inputBatch" }> {
    return { type: "inputBatch", matchId: cp.matchId!, generation: cp.owner.generation, epoch: cp.owner.epoch, items };
  }

  test.each([0, FRAME_MS - 0.001, FRAME_MS, FRAME_MS + 0.001])("uses the current simulation clock and exact frame rounding at offset %f", offset => {
    const f = fixture();
    f.start();
    f.advance(1000);
    f.elapse(200 + offset); // Admission must also work between simulation ticks.
    const cp = f.a.checkpoint();
    const current = Math.floor(cp.clock.simulationNow / FRAME_MS);
    const nominalLead = Math.floor((cp.clock.simulationNow + MAX_INPUT_LEAD_MS) / FRAME_MS);
    const maximum = current + Math.ceil(MAX_INPUT_LEAD_MS / FRAME_MS) + 2;
    expect(MAX_INPUT_LEAD_MS).toBe(250);
    expect(maximum).toBeGreaterThan(cp.state!.frame + Math.ceil(MAX_INPUT_LEAD_MS / FRAME_MS) + 2);
    expect(maximum).toBeLessThan(Math.floor(cp.serverNow / FRAME_MS));
    const frames = [current, nominalLead, maximum, maximum + 1, nominalLead + 3];
    f.a.send(batch(cp, frames.map((frame, i) => ({ seq: i + 1, frame, subframe: 0.75, input: Input.RotateCw }))));
    const ack = f.a.checkpoint().owner;
    expect(ack.nextSeq).toBe(6);
    expect(ack.pendingAccepted.map(i => i.frame)).toEqual(frames.slice(0, 3));
    expect(ack.rejections).toEqual([4, 5].map(seq => ({ seq, code: "INPUT_REJECTED" })));
    expect(f.room.match!.frame).toBe(cp.state!.frame);
  });

  test("the round-origin boundary uses the specified ceil allowance despite floating-point division", () => {
    const f = fixture();
    f.start();
    const cp = f.a.checkpoint();
    expect(cp.clock.simulationNow).toBe(0);
    const maximum = Math.floor(cp.clock.simulationNow / FRAME_MS) + Math.ceil(MAX_INPUT_LEAD_MS / FRAME_MS) + 2;
    f.a.send(batch(cp, [maximum, maximum + 1].map((frame, i) => ({ seq: i + 1, frame, subframe: 0.75, input: Input.RotateCw }))));
    expect(f.a.checkpoint().owner.pendingAccepted.map(i => i.frame)).toEqual([maximum]);
    expect(f.a.checkpoint().owner.rejections).toEqual([{ seq: 2, code: "INPUT_REJECTED" }]);
  });

  test("keeps the committed lower bound, including partial batch admission", () => {
    const f = fixture();
    f.start();
    f.advance(1000);
    const cp = f.a.checkpoint();
    f.a.send(batch(cp, [cp.state!.frame - 1, cp.state!.frame, cp.clock.currentTargetFrame + 15].map((frame, i) =>
      ({ seq: i + 1, frame, subframe: 0, input: Input.RotateCw }))));
    const ack = f.a.checkpoint().owner;
    expect(ack.nextSeq).toBe(4);
    expect(ack.rejections).toEqual([{ seq: 1, code: "INPUT_REJECTED" }]);
    expect(ack.pendingAccepted.map(i => i.seq)).toEqual([2, 3]);
  });

  test.each([Input.LeftDown, Input.RotateCw, Input.SoftDropDown, Input.HardDrop])("queues input %i without advancing any player's simulation and matches normal scheduling", input => {
    const f = fixture(3);
    f.start();
    f.advance(1000);
    const cp = f.a.checkpoint();
    const reference = Match.fromState(cp.state!);
    const item = { seq: 1, frame: Math.floor((cp.clock.simulationNow + 200) / FRAME_MS), subframe: 0.25, input };
    f.a.send(batch(cp, [item]));
    const accepted = f.a.checkpoint();
    expect(accepted.owner.pendingAccepted).toHaveLength(1);
    expect(accepted.owner.rejections).toEqual([]);
    expect({ ...accepted.state!, inputs: [] }).toEqual({ ...cp.state!, inputs: [] });
    const queued = accepted.state!.inputs[0];
    for (const elapsed of [50, 100, 50]) {
      f.advance(elapsed);
      reference.advanceToFrame(f.room.match!.frame);
      reference.drainEvents();
      expect(f.room.match!.frame).toBe(Math.floor((f.a.checkpoint().clock.simulationNow - 100) / FRAME_MS));
      expect({ ...f.room.match!.saveState(), inputs: [] }).toEqual({ ...reference.saveState(), inputs: [] });
    }
    // The reference receives the identical stamp at its normal physical send time.
    reference.submit(queued);
    const untilFrame = item.frame * FRAME_MS + 100 + 0.1 - f.a.checkpoint().clock.simulationNow;
    f.advance(untilFrame);
    reference.advanceToFrame(item.frame);
    expect(f.room.match!.frame).toBe(item.frame);
    expect(f.room.match!.saveState()).toEqual(reference.saveState());
    expect(f.a.checkpoint().owner.pendingAccepted).toHaveLength(1);
    const before = f.room.match!.playerState(f.a.welcome!.playerId).state;
    f.advance(FRAME_MS);
    reference.advanceToFrame(item.frame + 1);
    reference.drainEvents();
    expect(f.room.match!.saveState()).toEqual(reference.saveState());
    expect(f.a.checkpoint().owner.pendingAccepted).toEqual([]);
    expect(f.room.match!.saveState().inputs).toEqual([]);
    const after = f.room.match!.playerState(f.a.welcome!.playerId).state;
    if (input === Input.LeftDown) expect(after.leftHeld).toBe(true);
    if (input === Input.RotateCw) expect(after.rot).not.toBe(before.rot);
    if (input === Input.SoftDropDown) expect(after.softHeld).toBe(true);
    if (input === Input.HardDrop) {
      expect(after.sequence).toBe(before.sequence + 1);
      expect(f.room.events.filter(e => e.event.type === "lock").at(-1)!.event.atMs).toBe((item.frame + item.subframe) * FRAME_MS);
    }
    f.advance(500);
    reference.advanceToFrame(f.room.match!.frame);
    reference.drainEvents();
    expect(f.room.match!.saveState()).toEqual(reference.saveState());
  });

  test("T-A4 rejects a client clock advancing at twice server time and bounds its backlog", () => {
    const f = fixture();
    f.start();
    let accepted = 0, rejected = 0;
    for (let step = 1; step <= 30; step++) {
      f.advance(20);
      const cp = f.a.checkpoint();
      const frame = Math.floor(step * 40 / FRAME_MS);
      const maximum = Math.floor(cp.clock.simulationNow / FRAME_MS) + Math.ceil(MAX_INPUT_LEAD_MS / FRAME_MS) + 2;
      const item = { seq: step, frame, subframe: 0.25, input: Input.RotateCw };
      const before = f.room.match!.frame;
      f.a.send(batch(cp, [item]));
      const ack = f.a.checkpoint().owner;
      expect(f.room.match!.frame).toBe(before);
      expect(before).toBe(Math.floor(Math.max(0, cp.clock.simulationNow - 100) / FRAME_MS));
      if (frame > maximum) {
        rejected++;
        expect(ack.rejections).toContainEqual({ seq: step, code: "INPUT_REJECTED" });
        expect(ack.pendingAccepted.some(i => i.seq === step)).toBe(false);
      } else {
        accepted++;
        expect(ack.pendingAccepted.some(i => i.seq === step)).toBe(true);
      }
      expect(ack.pendingAccepted.length).toBeLessThanOrEqual(128);
      expect(f.room.match!.saveState().inputs.every(i => i.frame <= maximum)).toBe(true);
    }
    expect(accepted).toBeGreaterThan(0);
    expect(rejected).toBeGreaterThan(0);
    f.advance(1000);
    expect(f.a.checkpoint().owner.pendingAccepted).toEqual([]);
  });

  test("the 128 pending cap applies within batches of lead-stamped inputs", () => {
    const f = fixture();
    f.start();
    const cp = f.a.checkpoint();
    const frame = Math.ceil(MAX_INPUT_LEAD_MS / FRAME_MS) + 2;
    const items = (seq: number, count: number) => Array.from({ length: count }, (_, i) =>
      ({ seq: seq + i, frame, subframe: i / 64, input: Input.RotateCw }));
    f.a.send(batch(cp, items(1, 32)));
    f.a.send(batch(cp, items(33, 32)));
    f.advance(140);
    f.a.send(batch(cp, items(65, 32)));
    f.advance(140);
    f.a.send(batch(cp, items(97, 31)));
    expect(f.a.checkpoint().owner.pendingAccepted).toHaveLength(127);
    f.a.send(batch(cp, items(128, 2)));
    const full = f.a.checkpoint();
    expect(full.owner.pendingAccepted).toHaveLength(128);
    expect(full.state!.inputs).toHaveLength(128);
    expect(full.owner.nextSeq).toBe(130);
    expect(full.owner.rejections).toEqual([{ seq: 129, code: "INPUT_REJECTED" }]);
    f.a.send(batch(cp, items(128, 2)));
    expect(f.a.checkpoint().owner).toEqual(full.owner);
    f.advance(200);
    expect(f.a.checkpoint().owner.pendingAccepted).toEqual([]);
    expect(f.room.match!.saveState().inputs).toEqual([]);
  });

  test.each([false, true])("retransmission fingerprints remain owned for rejected=%s future inputs", rejected => {
    const f = fixture();
    f.start();
    const cp = f.a.checkpoint();
    const item = { seq: 1, frame: Math.ceil(MAX_INPUT_LEAD_MS / FRAME_MS) + (rejected ? 3 : 0), subframe: 0.25, input: Input.RotateCw };
    const command = batch(cp, [item]);
    f.a.send(command);
    const ack = f.a.checkpoint().owner;
    expect(ack.nextSeq).toBe(2);
    expect(ack.pendingAccepted).toHaveLength(rejected ? 0 : 1);
    f.a.send(command);
    expect(f.a.checkpoint().owner).toEqual(ack);
    if (rejected) {
      f.advance(350);
      f.a.send(command);
      expect(f.a.checkpoint().owner).toEqual(ack);
      expect(f.room.match!.saveState().inputs).toEqual([]);
    }
    f.a.send(batch(cp, [{ ...item, input: Input.HardDrop }]));
    expect(f.a.messages.some(m => m.type === "error" && m.code === "SEQ_CONFLICT")).toBe(true);
    expect(f.a.closed).toEqual([1008]);
  });

  test("future batches retain input and command rate limits without extra checkpoints", () => {
    const f = fixture();
    f.start();
    const cp = f.a.checkpoint();
    const frame = Math.ceil(MAX_INPUT_LEAD_MS / FRAME_MS);
    const command = (seq: number, count: number) => batch(cp, Array.from({ length: count }, (_, i) =>
      ({ seq: seq + i, frame, subframe: 0.25, input: Input.RotateCw })));
    f.a.send(command(1, 32));
    f.a.send(command(33, 32));
    const checkpoints = () => f.a.messages.filter(m => m.type === "checkpoint").length;
    const before = checkpoints();
    f.a.send(command(65, 1));
    expect(f.a.messages.at(-1)).toMatchObject({ code: "RATE_LIMIT" });
    expect(checkpoints()).toBe(before);
    expect(f.a.checkpoint().owner.nextSeq).toBe(65);
    for (let i = 0; i < 100; i++) f.a.send(command(1, 1));
    expect(f.a.messages.at(-1)).toMatchObject({ code: "RATE_LIMIT" });
    const limited = checkpoints();
    f.a.send({ type: "resync" });
    expect(f.a.messages.at(-1)).toMatchObject({ code: "RATE_LIMIT" });
    expect(checkpoints()).toBe(limited);
  });

  test("pause, preparation and countdown reject input; reconnect clears lead and excludes paused time", () => {
    const f = fixture(3);
    f.start();
    f.advance(1000);
    const cp = f.a.checkpoint();
    const command = batch(cp, [{ seq: 1, frame: cp.clock.currentTargetFrame + 15, subframe: 0.25, input: Input.HardDrop }]);
    f.a.send(command);
    expect(f.a.checkpoint().owner.pendingAccepted).toHaveLength(1);
    f.rooms.disconnect(f.clients[1].peer.id);
    const frozen = f.a.checkpoint();
    expect(frozen.owner.pendingAccepted).toEqual([]);
    expect(frozen.state!.inputs).toEqual([]);
    f.advance(10_000);
    f.a.send(command);
    expect(f.a.messages.at(-1)).toMatchObject({ code: "WRONG_PHASE" });
    expect(f.a.checkpoint().clock.simulationNow).toBe(cp.clock.simulationNow);
    f.client(f.clients[1].welcome!.resumeToken);
    expect(f.room.phase).toBe("preparing");
    f.a.send(command);
    expect(f.a.messages.at(-1)).toMatchObject({ code: "WRONG_PHASE" });
    for (const c of f.clients) if (f.room.seats.some(s => s.peer?.id === c.peer.id))
      c.send({ type: "prepared", matchId: f.room.matchId!, preparationId: f.room.preparationId });
    expect(f.room.phase).toBe("countdown");
    f.a.send(command);
    expect(f.a.messages.at(-1)).toMatchObject({ code: "WRONG_PHASE" });
    f.advance(3000);
    f.a.send(command);
    expect(f.a.messages.at(-1)).toMatchObject({ code: "STALE_INPUT" });
    const resumed = f.a.checkpoint();
    expect(resumed.clock.simulationNow).toBe(cp.clock.simulationNow);
    expect(resumed.state!.frame).toBe(cp.state!.frame);
    const maximum = resumed.clock.currentTargetFrame + Math.ceil(MAX_INPUT_LEAD_MS / FRAME_MS) + 2;
    f.a.send(batch(resumed, [maximum, maximum + 1].map((frame, i) => ({ seq: i + 1, frame, subframe: 0.25, input: Input.RotateCw }))));
    expect(f.a.checkpoint().owner.pendingAccepted.map(i => i.seq)).toEqual([1]);
    expect(f.a.checkpoint().owner.rejections).toEqual([{ seq: 2, code: "INPUT_REJECTED" }]);
    f.a.send({ type: "releaseControls" });
    f.advance(1000);
    expect(f.room.match!.saveState().inputs).toEqual([]);
    expect(f.room.match!.playerState(f.a.welcome!.playerId).state.sequence).toBe(0);
  });

  test.each([1, 2])("round/set results discard unexecuted lead inputs before the next start (firstTo=%i)", firstTo => {
    const f = fixture(2, "competitive", firstTo);
    f.start();
    const cp = f.a.checkpoint();
    const future = batch(cp, [{ seq: 1, frame: 15, subframe: 0.25, input: Input.HardDrop }]);
    f.a.send(future);
    const loser = f.clients[1];
    loser.send(batch(loser.checkpoint(), Array.from({ length: 25 }, (_, i) =>
      ({ seq: i + 1, frame: 0, subframe: i / 32, input: Input.HardDrop }))));
    f.advance(120);
    expect(f.room.phase).toBe(firstTo === 1 ? "setResult" : "roundResult");
    expect(f.a.checkpoint().owner.pendingAccepted).toEqual([]);
    expect(f.room.match!.saveState().inputs).toEqual([]);
    expect(f.room.match!.playerState(f.a.welcome!.playerId).state.sequence).toBe(0);
    f.a.send(future);
    expect(f.a.messages.at(-1)).toMatchObject({ code: "WRONG_PHASE" });
    if (firstTo === 1) f.start();
    else f.advance(3000);
    expect(f.room.phase).toBe("playing");
    f.a.send(future);
    expect(f.a.messages.at(-1)).toMatchObject({ code: "STALE_INPUT" });
    f.advance(500);
    expect(f.room.match!.playerState(f.a.welcome!.playerId).state.sequence).toBe(0);
    expect(f.room.match!.saveState().inputs).toEqual([]);
  });

  test("an earlier sequence with a future frame cannot block other inputs or another player's acknowledgments", () => {
    const f = fixture(3);
    f.start();
    const cp = f.a.checkpoint();
    f.a.send(batch(cp, [
      { seq: 1, frame: 15, subframe: 0.25, input: Input.LeftUp },
      { seq: 2, frame: 0, subframe: 0.25, input: Input.LeftDown },
    ]));
    const b = f.clients[1], other = b.checkpoint();
    expect(other.owner.pendingAccepted).toEqual([]);
    expect(other.owner.nextSeq).toBe(1);
    b.send(batch(other, [{ seq: 1, frame: 0, subframe: 0.25, input: Input.HardDrop }]));
    f.advance(120);
    expect(f.a.checkpoint().owner).toMatchObject({ nextSeq: 3, resolvedThroughSeq: 0, pendingAccepted: [{ seq: 1 }] });
    expect(b.checkpoint().owner).toMatchObject({ nextSeq: 2, resolvedThroughSeq: 1, pendingAccepted: [], rejections: [] });
    expect(f.room.match!.playerState(f.a.welcome!.playerId).state.leftHeld).toBe(true);
    expect(f.room.match!.playerState(b.welcome!.playerId).state.sequence).toBe(1);
    f.rooms.snapshots();
    const latest = f.clients.map(c => c.messages.filter(m => m.type === "checkpoint").at(-1) as Checkpoint);
    expect(latest[0].state).toBe(latest[1].state);
    expect(latest[0].owner.pendingAccepted).toHaveLength(1);
    expect(latest[1].owner.pendingAccepted).toEqual([]);
    f.advance(300);
    expect(f.a.checkpoint().owner.resolvedThroughSeq).toBe(2);
    expect(f.room.match!.playerState(f.a.welcome!.playerId).state.leftHeld).toBe(false);
  });

  test("lead-stamped competitive journals seal and verify with unchanged replay versions", async () => {
    const f = fixture(2, "competitive", 1);
    f.start();
    const recorder = f.room.recorder!;
    for (let i = 0; i < 25 && f.room.phase === "playing"; i++) {
      const cp = f.clients[1].checkpoint();
      f.clients[1].send(batch(cp, [{ seq: cp.owner.nextSeq,
        frame: Math.floor((cp.clock.simulationNow + MAX_INPUT_LEAD_MS) / FRAME_MS), subframe: 0.25, input: Input.HardDrop }]));
      expect(f.clients[1].checkpoint().owner.rejections).toEqual([]);
      f.advance(400);
    }
    expect(f.room.phase).toBe("setResult");
    const replay = await recorder.completion;
    expect(replay).not.toBeNull();
    expect(replay!.versions).toEqual(CURRENT_REPLAY_VERSIONS);
    expect(await decodeReplayJson(recorder.json!)).toEqual(replay!);
    expect((await verifyMatchReplayExecution(replay!)).state).toEqual(f.room.match!.saveState());
    const submits = replay!.records.filter(r => r.op.type === "submit");
    expect(submits.length).toBeGreaterThan(0);
    expect(submits[0]).toMatchObject({ before: { frame: 0 },
      op: { input: { frame: Math.floor(MAX_INPUT_LEAD_MS / FRAME_MS) } } });
    f.a.send(batch(f.a.checkpoint(), [{ seq: 1, frame: 15, subframe: 0, input: Input.HardDrop }]));
    expect(f.a.messages.at(-1)).toMatchObject({ code: "WRONG_PHASE" });
    f.start();
    expect(f.room.matchId).not.toBe(replay!.id);
    expect(f.room.match!.saveState().inputs).toEqual([]);
  });

  test("practice reset clears future inputs and preserves generation, epoch and match identity checks", () => {
    const f = fixture(2, "practice");
    f.start();
    const cp = f.a.checkpoint();
    const command = batch(cp, [{ seq: 1, frame: 15, subframe: 0.25, input: Input.HardDrop }]);
    f.a.send(command);
    expect(f.a.checkpoint().owner.pendingAccepted).toHaveLength(1);
    f.a.send({ type: "practiceReset" });
    const reset = f.a.checkpoint();
    expect(reset.owner.pendingAccepted).toEqual([]);
    expect(reset.state!.inputs).toEqual([]);
    expect(reset.owner.generation).toBeGreaterThan(cp.owner.generation);
    expect(reset.owner.epoch).toBeGreaterThan(cp.owner.epoch);
    for (const stale of [command, { ...command, generation: reset.owner.generation },
      { ...command, generation: reset.owner.generation, epoch: reset.owner.epoch, matchId: "old-match" }]) {
      f.a.send(stale);
      expect(f.a.messages.at(-1)).toMatchObject({ code: "STALE_INPUT" });
    }
    f.advance(500);
    expect(f.room.match!.playerState(f.a.welcome!.playerId).state.sequence).toBe(0);
    expect(f.room.recorder).toBeUndefined();
    expect(f.rooms.completedReplay(f.room.code)).toBeNull();
  });
});

describe("room authority", () => {
  function completedSet() {
    const f = fixture(2, "competitive", 1);
    f.start();
    const loser = f.clients[1];
    for (let i = 0; i < 25 && f.room.phase === "playing"; i++) {
      const cp = loser.checkpoint();
      loser.send({ type: "inputBatch", matchId: cp.matchId!, generation: cp.owner.generation, epoch: cp.owner.epoch,
        items: [{ seq: cp.owner.nextSeq, frame: cp.clock.currentTargetFrame, subframe: 0.25, input: Input.HardDrop }] });
      f.advance(120);
    }
    expect(f.room.phase).toBe("setResult");
    const results = f.room.events.filter(e => e.event.type === "setEnd");
    expect(results).toHaveLength(1);
    expect(results[0].event).toMatchObject({ winner: f.a.welcome!.playerId, reason: "firstTo" });
    return { ...f, results, scores: f.room.match!.scores };
  }

  test("a published FT winner leaving does not award the set to the loser", () => {
    const f = completedSet();
    f.a.send({ type: "leave" });
    expect(f.room.seats).toHaveLength(1);
    const checkpoint = f.clients[1].checkpoint();
    expect(checkpoint.events.filter(e => e.event.type === "setEnd")).toEqual(f.results);
    expect(f.room.match!.scores).toEqual(f.scores);
    expect(f.room.phase).toBe("setResult");
  });

  test("a published FT winner's reservation expiring preserves the result", () => {
    const f = completedSet();
    f.rooms.disconnect(f.a.peer.id);
    f.advance(40_000);
    expect(f.room.seats).toHaveLength(1);
    expect(f.clients[1].checkpoint().events.filter(e => e.event.type === "setEnd")).toEqual(f.results);
    expect(f.room.match!.scores).toEqual(f.scores);
  });

  test("all subsequent departures cannot rewrite or abort a completed published set", () => {
    const f = completedSet();
    for (const client of f.clients) {
      client.send({ type: "leave" });
      expect(f.room.events.filter(e => e.event.type === "setEnd")).toEqual(f.results);
      expect(f.room.match!.scores).toEqual(f.scores);
    }
    expect(f.room.seats).toHaveLength(0);
    expect(f.room.match!.complete).toBe(true);
  });

  test("simultaneous expiry after a published result cannot abort that completed set", () => {
    const f = completedSet();
    for (const client of f.clients) f.rooms.disconnect(client.peer.id);
    f.advance(40_000);
    expect(f.room.seats).toHaveLength(0);
    expect(f.room.events.filter(e => e.event.type === "setEnd")).toEqual(f.results);
    expect(f.room.match!.scores).toEqual(f.scores);
  });

  test("separate sessions for one profile, stable token, no live takeover", () => {
    const f = fixture();
    const [a, b] = f.clients;
    expect(a.welcome!.playerId).not.toBe(b.welcome!.playerId);
    const duplicate = f.client(a.welcome!.resumeToken);
    expect(duplicate.welcome).toBeUndefined();
    expect(duplicate.messages.at(-1)).toMatchObject({ code: "ALREADY_CONNECTED" });
    f.rooms.disconnect(a.peer.id);
    const resumed = f.client(a.welcome!.resumeToken);
    expect(resumed.welcome!.playerId).toBe(a.welcome!.playerId);
    expect(resumed.welcome!.resumeToken).toBe(a.welcome!.resumeToken);
    expect(f.room.seats.length).toBe(2);
  });

  test("prepared acknowledgement gates countdown; input order, duplicate, rejection and gap dispositions", () => {
    const f = fixture();
    f.a.send({ type: "ready", ready: true, handling: DEFAULT_HANDLING });
    f.advance(5000);
    expect(f.room.phase).toBe("waiting");
    expect(f.room.match).toBeUndefined();
    f.clients[1].send({ type: "ready", ready: true, handling: DEFAULT_HANDLING });
    expect(f.room.phase).toBe("preparing");
    f.advance(1000);
    expect(f.room.match!.frame).toBe(0);
    f.prepared();
    const checkpoint = f.a.checkpoint();
    const batch: ClientCommand = { type: "inputBatch", matchId: f.room.matchId!, generation: checkpoint.owner.generation, epoch: checkpoint.owner.epoch,
      items: [{ seq: 1, frame: 0, subframe: 0.25, input: Input.LeftDown }] };
    f.a.send(batch);
    f.a.send(batch);
    expect(f.a.checkpoint().owner.pendingAccepted).toHaveLength(1);
    f.a.send({ ...batch, items: [{ seq: 3, frame: 0, subframe: 0.5, input: Input.LeftUp }] });
    expect(f.a.messages.at(-2)).toMatchObject({ code: "SEQ_GAP" });
    f.a.send({ ...batch, items: [{ seq: 2, frame: 100, subframe: 0, input: Input.LeftUp }] });
    expect(f.a.checkpoint().owner.rejections).toEqual([{ seq: 2, code: "INPUT_REJECTED" }]);
    f.advance(200);
    const committed = f.a.checkpoint();
    expect(committed.state!.frame).toBe(6);
    expect(committed.owner.resolvedThroughSeq).toBe(2);
    expect(committed.owner.pendingAccepted).toHaveLength(0);
    f.a.send({ ...batch, items: [{ seq: 1, frame: 0, subframe: 0.25, input: Input.RightDown }] });
    expect(f.a.closed).toEqual([1008]);
  });

  test("disconnect freezes everyone, invalidates queued inputs and preserves exact Match through resume", () => {
    const f = fixture(3);
    f.start();
    f.advance(500);
    const match = f.room.match!;
    const before = f.a.checkpoint();
    f.a.send({ type: "inputBatch", matchId: f.room.matchId!, generation: before.owner.generation, epoch: before.owner.epoch,
      items: [{ seq: 1, frame: before.clock.currentTargetFrame, subframe: 0, input: Input.LeftDown }] });
    const b = f.clients[1];
    f.rooms.disconnect(b.peer.id);
    expect(f.room.phase).toBe("paused");
    expect(f.a.checkpoint().owner.pendingAccepted).toHaveLength(0);
    expect(f.a.checkpoint().owner.generation).toBeGreaterThan(before.owner.generation);
    const frame = match.frame;
    const frozen = f.a.checkpoint().clock.simulationNow;
    f.advance(20_000);
    expect(match.frame).toBe(frame);
    expect(f.a.checkpoint().clock.simulationNow).toBe(frozen);
    f.client(b.welcome!.resumeToken);
    f.prepared();
    expect(f.room.phase).toBe("playing");
    expect(f.room.match).toBe(match);
    expect(f.a.checkpoint().clock.simulationNow).toBe(frozen);
    f.advance(500);
    expect(match.frame).toBeGreaterThan(frame);
  });

  test("authoritative finesse survives disconnect and reconnect", () => {
    const f = fixture();
    f.start();
    const cp = f.a.checkpoint();
    f.a.send({ type: "inputBatch", matchId: cp.matchId!, generation: cp.owner.generation, epoch: cp.owner.epoch,
      items: [{ seq: 1, frame: cp.clock.currentTargetFrame, subframe: 0.1, input: Input.HardDrop }] });
    f.advance(500);
    const before = f.room.match!.playerState(f.a.welcome!.playerId).lastResult!.finesse;
    expect(before).toEqual({ evaluated: 1, faults: 0, points: 5 });
    f.rooms.disconnect(f.a.peer.id);
    const resumed = f.client(f.a.welcome!.resumeToken);
    f.prepared();
    const snapshot = resumed.checkpoint().state!;
    const index = snapshot.roster.indexOf(f.a.welcome!.playerId);
    expect(snapshot.players[index].game.lastResult!.finesse).toEqual(before);
    f.advance(500);
    expect(f.room.match!.playerState(f.a.welcome!.playerId).lastResult!.finesse).toEqual(before);
  });

  test("additional disconnect does not extend the first deadline; FFA withdrawal survives next round", () => {
    const f = fixture(3);
    f.start();
    const [, b, c] = f.clients;
    f.rooms.disconnect(b.peer.id);
    f.advance(20_000);
    f.rooms.disconnect(c.peer.id);
    const cDeadline = f.room.seats.find(s => s.id === c.welcome!.playerId)!.deadline;
    f.advance(20_000);
    expect(f.room.match!.activePlayers).not.toContain(b.welcome!.playerId);
    expect(f.room.match!.complete).toBe(false);
    expect(f.room.phase).toBe("paused");
    expect(f.room.seats.find(s => s.id === c.welcome!.playerId)!.deadline).toBe(cDeadline);
    f.advance(20_000);
    expect(f.room.phase).toBe("setResult");
    expect(f.room.match!.activePlayers).toEqual([f.a.welcome!.playerId]);
    expect(f.a.checkpoint().events.at(-1)?.event.type).toBe("controlsReleased");
    expect(f.a.checkpoint().events.some(e => e.event.type === "setEnd" && e.event.winner === f.a.welcome!.playerId)).toBe(true);
  });

  test("all disconnected seats expire to aborted, never a surviving absent winner", () => {
    const f = fixture(3);
    f.start();
    for (const c of f.clients) f.rooms.disconnect(c.peer.id);
    f.advance(40_000);
    const result = f.room.events.filter(e => e.event.type === "setEnd").at(-1);
    expect(result?.event).toMatchObject({ winner: null, reason: "aborted" });
    expect(f.room.match!.activePlayers).toEqual([]);
    f.advance(20_000);
    expect(f.rooms.rooms.size).toBe(0);
  });

  test("practice undo history survives resume and reset invalidates board epoch", () => {
    const f = fixture(2, "practice");
    f.start();
    const first = f.a.checkpoint();
    f.a.send({ type: "inputBatch", matchId: f.room.matchId!, generation: first.owner.generation, epoch: first.owner.epoch,
      items: [{ seq: 1, frame: 0, subframe: 0.5, input: Input.HardDrop }] });
    f.advance(200);
    f.rooms.disconnect(f.a.peer.id);
    const resumed = f.client(f.a.welcome!.resumeToken);
    f.prepared();
    const before = resumed.checkpoint();
    resumed.send({ type: "practiceUndo" });
    expect(resumed.checkpoint().owner.epoch).toBe(before.owner.epoch + 1);
    resumed.send({ type: "practiceReset" });
    expect(resumed.checkpoint().owner.epoch).toBe(before.owner.epoch + 2);
    const b = f.clients[1];
    b.send({ type: "toggleAttacks", enabled: false });
    expect(b.messages.at(-1)).toMatchObject({ code: "NOT_OWNER" });
    resumed.send({ type: "toggleAttacks", enabled: false });
    expect(f.room.match!.attacksEnabled).toBe(false);
  });

  test("lobby reservation expires, owner transfers to oldest connected guest, idle TTL releases room", () => {
    const f = fixture(3);
    f.rooms.disconnect(f.a.peer.id);
    f.advance(39_999);
    expect(f.room.seats.length).toBe(3);
    f.advance(1);
    expect(f.room.seats.length).toBe(2);
    expect(f.room.ownerId).toBe(f.clients[1].welcome!.playerId);
    f.advance(15 * 60_000);
    expect(f.rooms.rooms.size).toBe(0);
    expect(f.clients[1].messages.at(-1)).toEqual({ type: "left" });
  });

  test("schemas reject forged player, unsafe names and handling before Match allocation", () => {
    const f = fixture();
    f.rooms.receive(f.a.peer.id, { type: "ready", ready: true, handling: { ...DEFAULT_HANDLING, sdarr: 5 } });
    expect(f.a.messages.at(-1)).toMatchObject({ code: "INVALID_MESSAGE" });
    f.rooms.receive(f.a.peer.id, { type: "releaseControls", playerId: f.clients[1].welcome!.playerId });
    expect(f.a.messages.at(-1)).toMatchObject({ code: "INVALID_MESSAGE" });
    expect(f.room.match).toBeUndefined();
  });

  test("room and socket limits, capacity and command spam are enforced", () => {
    let now = 0;
    const rooms = new Rooms(() => now);
    const messages: ServerMessage[] = [];
    let closed = 0;
    for (let i = 0; i < 129; i++) {
      const peer = { id: String(i), send: (m: ServerMessage) => messages.push(m), close: () => { closed++; } };
      rooms.connect(peer);
      rooms.receive(peer.id, { type: "hello", name: "Guest" });
      if (i < 33) rooms.receive(peer.id, { type: "create", requestId: String(i), options: { firstTo: 1, mode: "competitive", attacksEnabled: true } });
    }
    expect(closed).toBe(1);
    expect(rooms.rooms.size).toBe(32);
    expect(messages.some(m => m.type === "error" && m.code === "CAPACITY")).toBe(true);
    for (let i = 0; i < 100; i++) rooms.receive("0", { type: "ping", nonce: "spam" });
    expect(messages.at(-1)).toMatchObject({ code: "RATE_LIMIT" });
    now += 1000;
    rooms.receive("0", { type: "ping", nonce: "ok" });
    expect(messages.at(-1)).toMatchObject({ type: "pong", nonce: "ok" });
  });

  test("rounds start automatically after three seconds; rematch still requires readiness", async () => {
    const f = fixture(2, "competitive", 2);
    f.start();
    const match = f.room.match!;
    const b = f.clients[1];
    function loseRound() {
      for (let i = 0; i < 25 && f.room.phase === "playing"; i++) {
        const cp = b.checkpoint();
        b.send({ type: "inputBatch", matchId: cp.matchId!, generation: cp.owner.generation, epoch: cp.owner.epoch,
          items: [{ seq: cp.owner.nextSeq, frame: cp.clock.currentTargetFrame, subframe: 0.25, input: Input.HardDrop }] });
        f.advance(120);
      }
    }
    loseRound();
    expect(f.room.phase).toBe("roundResult");
    expect(match.scores[f.a.welcome!.playerId]).toBe(1);
    const oldSeed = match.seed;
    const recorder = f.room.recorder!;
    const deadline = f.room.startsAt!;
    const old = f.a.checkpoint();
    const stale: ClientCommand = { type: "inputBatch", matchId: old.matchId!, generation: old.owner.generation, epoch: old.owner.epoch,
      items: [{ seq: old.owner.nextSeq, frame: 0, subframe: 0, input: Input.HardDrop }] };
    f.a.send(stale);
    expect(f.a.messages.at(-1)).toMatchObject({ code: "WRONG_PHASE" });
    f.a.send({ type: "ready", ready: true, handling: DEFAULT_HANDLING });
    expect(f.a.messages.at(-1)).toMatchObject({ code: "WRONG_PHASE" });
    expect(deadline - old.serverNow).toBe(3000);
    f.advance(1000);
    expect(deadline - f.a.checkpoint().serverNow).toBe(2000);
    f.advance(1999);
    expect(f.room.phase).toBe("roundResult");
    expect(match.round).toBe(1);
    f.advance(1);
    expect(f.room.match).toBe(match);
    expect(match.round).toBe(2);
    expect(f.clients.map(c => c.checkpoint().room.phase)).toEqual(["playing", "playing"]);
    expect(f.clients.map(c => c.checkpoint().state!.round)).toEqual([2, 2]);
    f.a.send(stale);
    expect(f.a.messages.at(-1)).toMatchObject({ code: "STALE_INPUT" });
    f.advance(0);
    expect(match.round).toBe(2);
    expect(match.seed).not.toBe(oldSeed);
    expect(match.handlingByPlayer[b.welcome!.playerId]).toEqual(DEFAULT_HANDLING);
    loseRound();
    expect(f.room.phase).toBe("setResult");
    expect(match.scores[f.a.welcome!.playerId]).toBe(2);
    const replay = await recorder.completion;
    expect(replay).not.toBeNull();
    expect(replay!.records.some(r => r.op.type === "nextRound" && r.op.seed === match.seed)).toBe(true);
    expect(f.a.checkpoint().roundDurations.map(result => result.round)).toEqual([1, 2]);
    f.advance(5000);
    expect(match.round).toBe(2);
    expect(f.room.phase).toBe("setResult");
    f.start();
    expect(f.room.match).not.toBe(match);
    expect(f.room.match!.scores[f.a.welcome!.playerId]).toBe(0);
    expect(f.a.checkpoint().roundDurations).toEqual([]);
  });

  test("eight-player countdown freezes across whole-room disconnect and resumes on reconnect", () => {
    const f = fixture(8, "competitive", 2, 12);
    f.start();
    for (const c of f.clients.slice(1)) {
      const cp = c.checkpoint();
      for (let i = 0; i < 25 && f.room.phase === "playing"; i++) {
        const current = c.checkpoint();
        c.send({ type: "inputBatch", matchId: cp.matchId!, generation: current.owner.generation, epoch: current.owner.epoch,
          items: [{ seq: current.owner.nextSeq, frame: current.clock.currentTargetFrame, subframe: 0, input: Input.HardDrop }] });
        f.advance(120);
        const state = f.room.match!.saveState();
        if (state.players[state.roster.indexOf(c.welcome!.playerId)].eliminated) break;
      }
    }
    expect(f.room.phase).toBe("roundResult");
    f.advance(1000);
    for (const c of [...f.clients]) f.rooms.disconnect(c.peer.id);
    expect(f.room.phase).toBe("paused");
    f.advance(5000);
    const resumed = f.clients.slice(0, 8).map(c => f.client(c.welcome!.resumeToken));
    expect(f.room.phase).toBe("roundResult");
    expect(resumed.at(-1)!.checkpoint().room.startsAt! - resumed.at(-1)!.checkpoint().serverNow).toBe(2000);
    f.advance(1999);
    expect(f.room.match!.round).toBe(1);
    f.advance(1);
    expect(resumed.map(c => c.checkpoint().state!.round)).toEqual(Array(8).fill(2));
    expect(f.room.match!.width).toBe(12);
  });

  test("round durations use simulation frames, exclude pauses and countdowns, and survive reconnects", () => {
    const f = fixture(2, "competitive", 2);
    for (const c of f.clients) c.send({ type: "ready", ready: true, handling: DEFAULT_HANDLING });
    expect(f.a.checkpoint().state!.frame).toBe(0);
    f.prepared();
    expect(f.a.checkpoint().state!.frame).toBe(0);
    f.advance(1100);
    const beforePause = f.a.checkpoint().state!.frame;
    expect(beforePause).toBe(Math.floor(1000 / FRAME_MS));
    const b = f.clients[1];
    f.rooms.disconnect(b.peer.id);
    f.advance(10_000);
    expect(f.a.checkpoint().state!.frame).toBe(beforePause);
    const resumed = f.client(b.welcome!.resumeToken);
    expect(resumed.checkpoint().state!.frame).toBe(beforePause);
    f.prepared();
    expect(resumed.checkpoint().state!.frame).toBe(beforePause);
    for (let i = 0; i < 25 && f.room.phase === "playing"; i++) {
      const cp = resumed.checkpoint();
      resumed.send({ type: "inputBatch", matchId: cp.matchId!, generation: cp.owner.generation, epoch: cp.owner.epoch,
        items: [{ seq: cp.owner.nextSeq, frame: cp.clock.currentTargetFrame, subframe: 0, input: Input.HardDrop }] });
      f.advance(120);
    }
    const finished = f.a.checkpoint();
    expect(finished.room.phase).toBe("roundResult");
    const roundEnd = finished.events.find(e => e.event.type === "roundEnd")!.event;
    expect(finished.roundDurations).toEqual([{ round: 1, durationMs: roundEnd.atMs }]);
    expect(roundEnd.atMs).toBeCloseTo(finished.state!.frame * FRAME_MS);
    expect(roundEnd.atMs).toBeLessThan(10_000);
    f.advance(2999);
    expect(f.a.checkpoint().roundDurations).toEqual(finished.roundDurations);
    f.advance(1);
    const next = resumed.checkpoint();
    expect(next.state!.round).toBe(2);
    expect(next.state!.frame).toBe(0);
    expect(next.roundDurations).toEqual(finished.roundDurations);
  });

  test("eight active sets limit allows a ninth lobby without allocating its Match", () => {
    const rooms = new Rooms(() => 0);
    const messages: ServerMessage[] = [];
    for (let i = 0; i < 9; i++) {
      for (const id of [`${i}a`, `${i}b`]) {
        rooms.connect({ id, send: m => messages.push(m), close() {} });
        rooms.receive(id, { type: "hello", name: id });
      }
      rooms.receive(`${i}a`, { type: "create", requestId: String(i), options: { firstTo: 2, mode: "competitive", attacksEnabled: true } });
      const room = [...rooms.rooms.values()].at(-1)!;
      rooms.receive(`${i}b`, { type: "join", code: room.code });
      for (const id of [`${i}a`, `${i}b`]) rooms.receive(id, { type: "ready", ready: true, handling: DEFAULT_HANDLING });
    }
    expect([...rooms.rooms.values()].filter(r => r.match).length).toBe(8);
    expect([...rooms.rooms.values()].at(-1)!.phase).toBe("waiting");
    expect(messages.some(m => m.type === "error" && m.code === "CAPACITY")).toBe(true);
  });

  test("release resets sequence generation and held controls; stale generation cannot reassert keys", () => {
    const f = fixture();
    f.start();
    const cp = f.a.checkpoint();
    const batch: ClientCommand = { type: "inputBatch", matchId: cp.matchId!, generation: cp.owner.generation, epoch: cp.owner.epoch,
      items: [{ seq: 1, frame: 0, subframe: 0, input: Input.LeftDown }] };
    f.a.send(batch);
    f.advance(200);
    expect(f.room.match!.playerState(f.a.welcome!.playerId).state.leftHeld).toBe(true);
    f.a.send({ type: "releaseControls" });
    const released = f.a.checkpoint();
    expect(released.owner.generation).toBeGreaterThan(cp.owner.generation);
    expect(released.owner.nextSeq).toBe(1);
    expect(f.room.match!.playerState(f.a.welcome!.playerId).state.leftHeld).toBe(false);
    f.a.send(batch);
    expect(f.a.messages.at(-1)).toMatchObject({ code: "STALE_INPUT" });
  });

  test("input burst cap and future horizon bound pending work; oversize batches are schema errors", () => {
    const f = fixture();
    f.start();
    const cp = f.a.checkpoint();
    const batch = (start: number): ClientCommand => ({ type: "inputBatch", matchId: cp.matchId!, generation: cp.owner.generation, epoch: cp.owner.epoch,
      items: Array.from({ length: 32 }, (_, i) => ({ seq: start + i, frame: 2, subframe: i / 32, input: Input.RotateCw })) });
    f.a.send(batch(1));
    f.a.send(batch(33));
    f.a.send(batch(65));
    expect(f.a.messages.at(-1)).toMatchObject({ code: "RATE_LIMIT" });
    expect(f.a.checkpoint().owner.pendingAccepted).toHaveLength(64);
    const oversized = batch(65) as Extract<ClientCommand, { type: "inputBatch" }>;
    oversized.items.push({ seq: 97, frame: 2, subframe: 0.99, input: Input.HardDrop });
    f.a.send(oversized);
    expect(f.a.messages.at(-1)).toMatchObject({ code: "INVALID_MESSAGE" });
  });

  test("a missing prepared acknowledgement closes the lease and starts the 40-second reservation", () => {
    const f = fixture();
    for (const c of f.clients) c.send({ type: "ready", ready: true, handling: DEFAULT_HANDLING });
    f.a.send({ type: "prepared", matchId: f.room.matchId!, preparationId: f.room.preparationId });
    f.advance(10_000);
    expect(f.room.phase).toBe("paused");
    expect(f.clients[1].closed).toEqual([1008]);
    expect(f.room.seats.find(s => s.id === f.clients[1].welcome!.playerId)!.deadline).toBe(50_000);
    f.advance(40_000);
    expect(f.room.phase).toBe("setResult");
  });

  test("acknowledgement identifies settled inputs even when sequence and frame order differ", () => {
    const f = fixture();
    f.start();
    const cp = f.a.checkpoint();
    f.a.send({ type: "inputBatch", matchId: cp.matchId!, generation: cp.owner.generation, epoch: cp.owner.epoch,
      items: [{ seq: 1, frame: 2, subframe: 0, input: Input.LeftUp }, { seq: 2, frame: 0, subframe: 0, input: Input.LeftDown }] });
    f.advance(120);
    const ack = f.a.checkpoint().owner;
    expect(ack.resolvedThroughSeq).toBe(0);
    expect(ack.nextSeq).toBe(3);
    expect(ack.pendingAccepted.map(i => i.seq)).toEqual([1]);
    expect(f.room.match!.playerState(f.a.welcome!.playerId).state.leftHeld).toBe(true);
    f.advance(50);
    expect(f.a.checkpoint().owner.resolvedThroughSeq).toBe(2);
    expect(f.room.match!.playerState(f.a.welcome!.playerId).state.leftHeld).toBe(false);
  });

  test("renamed guests are broadcast to the room and keep their name on reconnect", () => {
    const f = fixture();
    f.a.send({ type: "rename", name: "New Name" });
    for (const client of f.clients) {
      const state = [...client.messages].reverse().find(m => m.type === "roomState");
      expect(state?.type === "roomState" && state.room.players.find(p => p.playerId === f.a.welcome!.playerId)?.name).toBe("New Name");
    }
    f.rooms.disconnect(f.a.peer.id);
    const messages: ServerMessage[] = [];
    const peer: Peer = { id: crypto.randomUUID(), send: m => messages.push(m), close() {} };
    f.rooms.connect(peer);
    f.rooms.receive(peer.id, { type: "hello", name: "New Name", guestProfileId: "same-profile", resumeToken: f.a.welcome!.resumeToken });
    expect(messages.find(m => m.type === "welcome")).toMatchObject({ name: "New Name", playerId: f.a.welcome!.playerId });
    expect(f.rooms.view(f.room).players.find(p => p.playerId === f.a.welcome!.playerId)?.name).toBe("New Name");
  });

  test("per-player skins are validated, broadcast by stable id, and survive reconnect and replacement", () => {
    const f = fixture(2);
    const [a, b] = f.clients;
    const aId = a.welcome!.playerId, bId = b.welcome!.playerId;
    a.send({ type: "skin", skin: "tetrio" });
    b.send({ type: "skin", skin: "four" });
    expect(f.rooms.view(f.room).players.map(player => [player.playerId, player.skin]))
      .toEqual([[aId, "tetrio"], [bId, "four"]]);
    for (const client of f.clients) {
      const state = [...client.messages].reverse().find(message => message.type === "roomState");
      expect(state?.type === "roomState" && state.room.players.find(player => player.playerId === aId)?.skin).toBe("tetrio");
    }
    const joined = f.client(undefined, "ppt");
    joined.send({ type: "join", code: f.room.code });
    expect(f.rooms.view(f.room).players.find(player => player.playerId === joined.welcome!.playerId)?.skin).toBe("ppt");
    for (const skin of ["https://example.com/skin.png", "custom:0", "x".repeat(33), ""]) {
      f.rooms.receive(a.peer.id, { type: "skin", skin });
      expect(a.messages.at(-1)).toMatchObject({ code: "INVALID_MESSAGE" });
    }
    expect(f.rooms.view(f.room).players.find(player => player.playerId === aId)?.skin).toBe("tetrio");
    f.rooms.disconnect(a.peer.id);
    const resumed = f.client(a.welcome!.resumeToken, "emoji");
    expect(f.rooms.view(f.room).players.find(player => player.playerId === aId)?.skin).toBe("emoji");
    f.rooms.disconnect(resumed.peer.id);
    const restored = f.client(a.welcome!.resumeToken);
    expect(f.rooms.view(f.room).players.find(player => player.playerId === aId)?.skin).toBe("emoji");
    restored.send({ type: "leave" });
    expect(f.rooms.view(f.room).players.some(player => player.playerId === aId)).toBe(false);
    const replacement = f.client(undefined, "n3base");
    replacement.send({ type: "join", code: f.room.code });
    const replacementId = replacement.welcome!.playerId;
    expect(replacementId).not.toBe(aId);
    expect(f.rooms.view(f.room).players.find(player => player.playerId === replacementId)?.skin).toBe("n3base");
  });

  test("skin changes never enter deterministic Match state, scores or events", () => {
    const f = fixture(2);
    f.start();
    f.advance(200);
    const before = structuredClone(f.room.match!.saveState());
    const scores = { ...f.room.match!.scores };
    f.a.send({ type: "skin", skin: "tetrio" });
    f.clients[1].send({ type: "skin", skin: "ppt" });
    expect(f.room.match!.saveState()).toEqual(before);
    expect(f.room.match!.scores).toEqual(scores);
    expect(JSON.stringify(f.room.match!.saveState())).not.toContain("tetrio");
    expect(f.rooms.view(f.room).players.map(player => player.skin)).toEqual(["tetrio", "ppt"]);
  });

  test("creator settings, capacity and idempotent create cannot bypass room authority", () => {
    const f = fixture(2);
    const options = { firstTo: 2, maxPlayers: 2, mode: "competitive" as const, attacksEnabled: true };
    f.clients[1].send({ type: "configure", options });
    expect(f.clients[1].messages.at(-1)).toMatchObject({ code: "NOT_OWNER" });
    f.a.send({ type: "configure", options });
    const third = f.client();
    third.send({ type: "join", code: f.room.code });
    expect(third.messages.at(-1)).toMatchObject({ code: "ROOM_FULL" });
    f.a.send({ type: "create", requestId: "one", options: { mode: "competitive", attacksEnabled: true, maxPlayers: 8, firstTo: 2 } });
    expect(f.a.messages.at(-1)).toMatchObject({ type: "roomState", requestId: "one" });
    expect(f.rooms.rooms.size).toBe(1);
    for (const c of f.clients.slice(0, 2)) c.send({ type: "ready", ready: true, handling: DEFAULT_HANDLING });
    f.prepared();
    f.a.send({ type: "configure", options });
    expect(f.a.messages.at(-1)).toMatchObject({ code: "WRONG_PHASE" });
    f.a.send({ type: "rename", name: "New Name" });
    expect(f.rooms.view(f.room).players[0].name).toBe("New Name");
    f.rooms.receive(third.peer.id, { type: "rename", name: "<script>" });
    expect(third.messages.at(-1)).toMatchObject({ code: "INVALID_MESSAGE" });
  });

  test("FFA continues with two connected seats after a third expires", () => {
    const f = fixture(3);
    f.start();
    const match = f.room.match!;
    f.rooms.disconnect(f.clients[2].peer.id);
    f.advance(40_000);
    expect(f.room.phase).toBe("preparing");
    f.prepared();
    expect(f.room.phase).toBe("playing");
    expect(f.room.match).toBe(match);
    expect(match.activePlayers.length).toBe(2);
    f.advance(200);
    expect(match.frame).toBeGreaterThan(0);
  });

  test("server checkpoint restores OwnerPrediction backlog and replays only additional unresolved inputs", () => {
    const f = fixture();
    f.start();
    const initial = f.a.checkpoint();
    const header = { type: "inputBatch" as const, matchId: initial.matchId!, generation: initial.owner.generation, epoch: initial.owner.epoch };
    f.a.send({ ...header, items: [{ seq: 1, frame: 0, subframe: 0.25, input: Input.HardDrop }] });
    const checkpoint = f.a.checkpoint();
    expect(checkpoint.owner.pendingAccepted.map(i => i.seq)).toEqual([1]);
    expect(checkpoint.state!.inputs).toHaveLength(1);
    const owner = f.a.welcome!.playerId;
    const prediction = new OwnerPrediction(checkpoint.state!, owner);
    const additional = { seq: 2, frame: 1, subframe: 0.5, input: Input.RotateCw };
    prediction.submit({ player: owner, frame: additional.frame, subframe: additional.subframe, input: additional.input,
      epoch: checkpoint.owner.epoch, order: checkpoint.owner.pendingAccepted[0].order + 1 });
    prediction.advanceToTime(2 * FRAME_MS);
    f.a.send({ ...header, items: [additional] });
    f.advance(140);
    const actual = f.room.match!.playerState(owner);
    const predicted = prediction.gameState();
    expect(predicted.board).toEqual(actual.board);
    expect(predicted.state.piece).toBe(actual.state.piece);
    expect(predicted.state.rot).toBe(actual.state.rot);
    expect(predicted.state.x).toBe(actual.state.x);
    expect(prediction.drainEvents().filter(e => e.type === "lock")).toHaveLength(1);
    expect(f.a.checkpoint().owner.resolvedThroughSeq).toBe(2);
  });
});

test("four-wide room configuration survives join, reconnect, and a rematch", () => {
  const f = fixture(2, "competitive", 1);
  f.a.send({ type: "configure", options: { firstTo: 1, mode: "competitive", attacksEnabled: true, maxPlayers: 8, width: 4 } });
  expect(f.room.options.width).toBe(4);
  expect(f.clients[1].messages.filter(m => m.type === "roomState").at(-1)).toMatchObject({ room: { options: { width: 4 } } });
  f.start();
  expect(f.room.match!.saveState().players.every(p => p.game.config.width === 4)).toBe(true);
  f.a.send({ type: "configure", options: { firstTo: 1, mode: "competitive", attacksEnabled: true, maxPlayers: 8, width: 10 } });
  expect(f.room.options.width).toBe(4);
  expect(f.a.messages.at(-1)).toMatchObject({ code: "WRONG_PHASE" });
  f.rooms.disconnect(f.clients[1].peer.id);
  const resumed = f.client(f.clients[1].welcome!.resumeToken);
  expect(resumed.checkpoint().state!.width).toBe(4);
  f.prepared();
  for (let i = 0; i < 25 && f.room.phase === "playing"; i++) {
    const cp = resumed.checkpoint();
    resumed.send({ type: "inputBatch", matchId: cp.matchId!, generation: cp.owner.generation, epoch: cp.owner.epoch,
      items: [{ seq: cp.owner.nextSeq, frame: cp.clock.currentTargetFrame, subframe: 0.25, input: Input.HardDrop }] });
    f.advance(120);
  }
  expect(f.room.phase).toBe("setResult");
  f.a.send({ type: "ready", ready: true, handling: DEFAULT_HANDLING });
  resumed.send({ type: "ready", ready: true, handling: DEFAULT_HANDLING });
  expect(f.room.match!.saveState().width).toBe(4);
});

test("room commands reject unsupported widths and retain the ten-wide default", () => {
  const f = fixture();
  expect(f.room.options.width).toBe(10);
  for (const width of [3, 13, 4.5]) {
    f.a.send({ type: "configure", options: { firstTo: 2, mode: "competitive", attacksEnabled: true, width } });
    expect(f.a.messages.at(-1)).toMatchObject({ code: "INVALID_MESSAGE" });
    expect(f.room.options.width).toBe(10);
  }
});

test.each([11, 12])("%i-wide room settings reach joined and reconnecting players", width => {
  const f = fixture(2, "competitive", 2, width);
  expect(f.room.options.width).toBe(width);
  expect(f.clients[1].messages.filter(m => m.type === "roomState").at(-1)).toMatchObject({ room: { options: { width } } });
  f.start();
  expect(f.a.checkpoint().state!.players.every(p => p.game.config.width === width)).toBe(true);
  f.rooms.disconnect(f.clients[1].peer.id);
  const resumed = f.client(f.clients[1].welcome!.resumeToken);
  expect(resumed.checkpoint().state!.width).toBe(width);
});

describe("competitive replay integration", () => {
  test("records inputs, releases and a verified completed set; a new set owns a new journal", async () => {
    const f = fixture(2, "competitive", 1);
    f.start();
    const recorder = f.room.recorder!;
    const loser = f.clients[1];
    for (let i = 0; i < 25 && f.room.phase === "playing"; i++) {
      const cp = loser.checkpoint();
      loser.send({ type: "inputBatch", matchId: cp.matchId!, generation: cp.owner.generation, epoch: cp.owner.epoch,
        items: [{ seq: cp.owner.nextSeq, frame: cp.clock.currentTargetFrame, subframe: 0.25, input: Input.HardDrop }] });
      f.advance(120);
    }
    expect(f.room.phase).toBe("setResult");
    const replay = await recorder.completion;
    expect(replay).not.toBeNull();
    expect(f.rooms.completedReplay(f.room.code)).toBe(replay);
    expect(replay!.records.some(r => r.op.type === "submit")).toBe(true);
    expect(replay!.records.some(r => r.op.type === "advance")).toBe(true);
    expect(replay!.records.some(r => r.op.type === "release")).toBe(true);
    const state = f.room.match!.saveState();
    f.a.send({ type: "releaseControls" });
    expect(f.room.match!.saveState()).toEqual(state);
    f.start();
    expect(f.room.recorder).not.toBe(recorder);
    expect(f.rooms.completedReplay(f.room.code)).toBeNull();
  });

  test("records three-player disconnect, reconnect and forfeit", async () => {
    const f = fixture(3, "competitive", 2);
    f.start();
    const recorder = f.room.recorder!;
    const token = f.clients[1].welcome!.resumeToken;
    f.rooms.disconnect(f.clients[1].peer.id);
    const resumed = f.client(token);
    f.prepared();
    f.clients[2].send({ type: "leave" });
    resumed.send({ type: "leave" });
    const replay = await recorder.completion;
    expect(replay).not.toBeNull();
    expect(replay!.records.filter(r => r.op.type === "forfeit")).toHaveLength(2);
    expect(replay!.records.some(r => r.op.type === "release")).toBe(true);
  });

  test("simultaneous seat expiry records the final aborted outcome", async () => {
    const f = fixture(2, "competitive", 2);
    f.start();
    const recorder = f.room.recorder!;
    for (const c of f.clients) f.rooms.disconnect(c.peer.id);
    f.advance(40_000);
    const replay = await recorder.completion;
    expect(replay).not.toBeNull();
    expect(replay!.records.filter(r => r.op.type === "forfeit")).toHaveLength(2);
    expect(replay!.summary.reason).toBe("aborted");
  });

  test("resource failure retains events and gameplay; room cleanup drops the artifact", async () => {
    let now = 0;
    const rooms = new Rooms(() => now, { maxOperations: 1 });
    const clients = [0, 1].map(() => {
      const peer: Peer = { id: crypto.randomUUID(), send() {}, close() {} };
      rooms.connect(peer);
      rooms.receive(peer.id, { type: "hello", name: "Guest" });
      return peer;
    });
    rooms.receive(clients[0].id, { type: "create", requestId: "one", options: { firstTo: 1, mode: "competitive", attacksEnabled: true, maxPlayers: 4 } });
    const room = [...rooms.rooms.values()][0];
    rooms.receive(clients[1].id, { type: "join", code: room.code });
    for (const p of clients) rooms.receive(p.id, { type: "ready", ready: true, handling: DEFAULT_HANDLING });
    expect(room.recorder!.status).toBe("failed");
    expect(room.events.filter(e => e.event.type === "controlsReleased")).toHaveLength(2);
    for (const p of clients) rooms.receive(p.id, { type: "prepared", matchId: room.matchId!, preparationId: room.preparationId });
    now += 3200; rooms.tick();
    expect(room.match!.frame).toBeGreaterThan(0);
    rooms.receive(clients[1].id, { type: "leave" });
    expect(room.match!.complete).toBe(true);
    expect(room.events.some(e => e.event.type === "setEnd")).toBe(true);
    expect(await room.recorder!.completion).toBeNull();
    for (const p of clients) rooms.disconnect(p.id);
    now += 61_000; rooms.tick();
    expect(rooms.rooms.has(room.code)).toBe(false);
    expect(rooms.completedReplay(room.code)).toBeNull();
  });


  test("verification cannot republish a replay after a new set or room destruction", async () => {
    for (const destroy of [false, true]) {
      const f = fixture(2, "competitive", 1);
      f.start();
      const recorder = f.room.recorder!;
      f.rooms.disconnect(f.clients[1].peer.id);
      f.advance(40_000);
      expect(f.room.phase).toBe("setResult");
      expect(recorder.status).toBe("finalizing");
      if (destroy) {
        f.rooms.disconnect(f.a.peer.id);
        f.advance(60_000);
        expect(f.rooms.rooms.has(f.room.code)).toBe(false);
      } else {
        const replacement = f.client();
        replacement.send({ type: "join", code: f.room.code });
        f.a.send({ type: "ready", ready: true, handling: DEFAULT_HANDLING });
        replacement.send({ type: "ready", ready: true, handling: DEFAULT_HANDLING });
        expect(f.room.recorder).not.toBe(recorder);
      }
      expect(await recorder.completion).not.toBeNull();
      expect(f.rooms.completedReplay(f.room.code)).toBeNull();
    }
  });

  test("practice never creates a recorder through reconnect and restart", () => {
    const f = fixture(2, "practice");
    f.start();
    expect(f.room.recorder).toBeUndefined();
    f.rooms.disconnect(f.clients[1].peer.id);
    const resumed = f.client(f.clients[1].welcome!.resumeToken);
    f.prepared();
    resumed.send({ type: "practiceReset" });
    expect(f.room.recorder).toBeUndefined();
    f.a.send({ type: "leave" });
    const replacement = f.client();
    replacement.send({ type: "join", code: f.room.code });
    resumed.send({ type: "ready", ready: true, handling: DEFAULT_HANDLING });
    replacement.send({ type: "ready", ready: true, handling: DEFAULT_HANDLING });
    expect(f.room.match?.mode).toBe("practice");
    expect(f.room.recorder).toBeUndefined();
    expect(f.rooms.completedReplay(f.room.code)).toBeNull();
  });
});

describe("competitive replay retrieval", () => {
  function completed(replayOptions?: MatchRecorderOptions) {
    const f = fixture(2, "competitive", 1, undefined, replayOptions);
    f.start();
    f.clients[1].send({ type: "leave" });
    expect(f.room.phase).toBe("setResult");
    return f;
  }

  function request(f: ReturnType<typeof fixture>, token?: string, code = f.room.code, query = "") {
    const app = createApp({ rooms: f.rooms, scheduled: false });
    return app.handle(new Request(`http://localhost/api/rooms/${code}/replay${query}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }));
  }

  test("only the completed verified artifact is served; reads do not finalize or mutate it", async () => {
    const f = completed();
    const token = f.a.welcome!.resumeToken;
    const recorder = f.room.recorder!;
    expect(recorder.status).toBe("finalizing");
    expect(f.rooms.replayAccess(f.room.code, token)).toEqual({ status: "pending" });
    const pending = await request(f, token);
    expect(pending.status).toBe(202);
    expect(await pending.json()).toEqual({ status: "pending" });
    const replay = await recorder.completion;
    expect(replay).not.toBeNull();
    const state = f.room.match!.saveState();
    const response = await request(f, token);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("vary")).toBe("Authorization");
    const json = await response.text();
    expect(json).toBe(recorder.json!);
    expect(await decodeReplayJson(json)).toEqual(replay!);
    expect((await MatchPlayback.create(JSON.parse(json))).id).toBe(f.room.matchId!);
    expect((await request(f, token)).status).toBe(200);
    expect(recorder.replay).toBe(replay);
    expect(f.room.match!.saveState()).toEqual(state);
    expect(f.a.checkpoint()).not.toHaveProperty("replay");
  });

  test("room code, player id, profile id and another guest never authorize access", async () => {
    const f = completed();
    await f.room.recorder!.completion;
    const stranger = f.client(); // Same guestProfileId as every fixture participant.
    stranger.send({ type: "create", requestId: "other", options: { firstTo: 1, mode: "competitive", attacksEnabled: true } });
    for (const token of [undefined, "guessed", f.a.welcome!.playerId, stranger.welcome!.resumeToken]) {
      const response = await request(f, token);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ status: "unauthorized" });
    }
    const spoof = await request(f, undefined, f.room.code,
      `?playerId=${f.a.welcome!.playerId}&resumeToken=${f.a.welcome!.resumeToken}&guestProfileId=same-profile`);
    expect(spoof.status).toBe(403);
    expect(await spoof.json()).toEqual({ status: "unauthorized" });
    expect((await request(f, f.clients[1].welcome!.resumeToken)).status).toBe(403);
    const late = f.client();
    late.send({ type: "join", code: f.room.code });
    expect(late.checkpoint().room.code).toBe(f.room.code);
    expect((await request(f, late.welcome!.resumeToken)).status).toBe(403);
    expect((await request(f, late.welcome!.resumeToken, stranger.checkpoint().room.code)).status).toBe(403);
  });

  test("incomplete, abandoned, failed and practice recordings expose no journal", async () => {
    const f = fixture();
    const token = f.a.welcome!.resumeToken;
    expect((await request(f, token)).status).toBe(404);
    f.start();
    expect((await request(f, token)).status).toBe(404);
    f.room.recorder!.abandon();
    expect((await request(f, token)).status).toBe(404);
    for (const options of [{ maxOperations: 1 }, { maxBytes: 1 }]) {
      const failed = completed(options);
      expect(failed.room.recorder!.status).toBe("failed");
      const response = await request(failed, failed.a.welcome!.resumeToken);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ status: "failed" });
    }
    const practice = fixture(2, "practice");
    for (const start of [false, true]) {
      if (start) practice.start();
      const response = await request(practice, practice.a.welcome!.resumeToken);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ status: "unavailable" });
      expect(practice.room.recorder).toBeUndefined();
    }
    // Switching the lobby to practice also hides a retained competitive artifact.
    const changed = completed();
    await changed.room.recorder!.completion;
    changed.a.send({ type: "configure", options: { firstTo: 1, mode: "practice", attacksEnabled: true } });
    expect((await request(changed, changed.a.welcome!.resumeToken)).status).toBe(404);
  });

  test("reconnect preserves ownership; reservation expiry and room destruction revoke access", async () => {
    const f = completed();
    await f.room.recorder!.completion;
    const token = f.a.welcome!.resumeToken;
    f.rooms.disconnect(f.a.peer.id);
    expect((await request(f, token)).status).toBe(200);
    const resumed = f.client(token);
    expect(resumed.welcome!.playerId).toBe(f.a.welcome!.playerId);
    expect((await request(f, token)).status).toBe(200);
    f.rooms.disconnect(resumed.peer.id);
    f.advance(40_000);
    expect((await request(f, token)).status).toBe(403);
    f.advance(20_000);
    const response = await request(f, token);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ status: "unavailable" });
    expect((await request(f, token, "AAAAAA")).status).toBe(404);
  });

  test("a new set drops old access even if old verification finishes later", async () => {
    for (const finishFirst of [false, true]) {
      const f = completed();
      const old = f.room.recorder!;
      if (finishFirst) await old.completion;
      const replacement = f.client();
      replacement.send({ type: "join", code: f.room.code });
      for (const c of [f.a, replacement]) c.send({ type: "ready", ready: true, handling: DEFAULT_HANDLING });
      expect(f.room.recorder).not.toBe(old);
      await old.completion;
      const response = await request(f, f.a.welcome!.resumeToken);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ status: "unavailable" });
    }
  });

  test("reservation and room expiry apply before scheduler cleanup, and reads do not extend TTL", async () => {
    const f = completed();
    await f.room.recorder!.completion;
    const token = f.a.welcome!.resumeToken;
    f.rooms.disconnect(f.a.peer.id);
    f.elapse(40_000);
    expect(f.rooms.replayAccess(f.room.code, token)).toEqual({ status: "unauthorized" });
    f.elapse(20_000);
    expect(f.rooms.rooms.has(f.room.code)).toBe(true);
    expect(f.rooms.replayAccess(f.room.code, token)).toEqual({ status: "unavailable" });

    const idle = completed();
    await idle.room.recorder!.completion;
    const idleToken = idle.a.welcome!.resumeToken;
    idle.elapse(15 * 60_000 - 1);
    expect(idle.rooms.replayAccess(idle.room.code, idleToken).status).toBe("ready");
    idle.elapse(1);
    expect(idle.rooms.replayAccess(idle.room.code, idleToken)).toEqual({ status: "unavailable" });
    idle.advance(0);
    expect(idle.rooms.rooms.has(idle.room.code)).toBe(false);
  });
});

describe("original replay appearance", () => {
  test("snapshots skins and names at Match creation, authorizes metadata and never mutates replay JSON", async () => {
    const f = fixture(2, "competitive", 1);
    f.a.send({ type: "skin", skin: "four" });
    f.clients[1].send({ type: "skin", skin: "tetrio" });
    f.a.send({ type: "rename", name: "Ada" });
    f.start();
    const ids = [f.a.welcome!.playerId, f.clients[1].welcome!.playerId];
    expect(f.room.replayAppearance).toEqual({ matchId: f.room.matchId!,
      names: { [ids[0]]: "Ada", [ids[1]]: "Guest" }, skinIds: { [ids[0]]: "four", [ids[1]]: "tetrio" } });
    f.a.send({ type: "skin", skin: "ppt" });
    f.a.send({ type: "rename", name: "Changed" });
    f.clients[1].send({ type: "leave" });
    const app = createApp({ rooms: f.rooms, scheduled: false });
    const url = `http://localhost/api/rooms/${f.room.code}/replay/appearance`;
    const request = (token?: string) => app.handle(new Request(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} }));
    expect((await request()).status).toBe(403);
    await f.room.recorder!.completion;
    const json = f.room.recorder!.json;
    const response = await request(f.a.welcome!.resumeToken);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("vary")).toBe("Authorization");
    expect(await response.json()).toEqual(f.room.replayAppearance);
    expect(f.room.replayAppearance!.skinIds[ids[0]]).toBe("four");
    expect(f.room.replayAppearance!.names[ids[0]]).toBe("Ada");
    expect(f.room.recorder!.json).toBe(json);
    expect(json).not.toContain("skinIds");
    expect((await request(f.clients[1].welcome!.resumeToken)).status).toBe(403);
    const outsider = f.client();
    outsider.send({ type: "join", code: f.room.code });
    expect((await request(outsider.welcome!.resumeToken)).status).toBe(403);
    f.a.send({ type: "leave" });
    expect((await request(f.a.welcome!.resumeToken)).status).toBe(403);
  });

  test("practice has no appearance snapshot and cannot retrieve metadata", async () => {
    const f = fixture(2, "practice"); f.start();
    expect(f.room.replayAppearance).toBeUndefined();
    const app = createApp({ rooms: f.rooms, scheduled: false });
    const response = await app.handle(new Request(`http://localhost/api/rooms/${f.room.code}/replay/appearance`, {
      headers: { Authorization: `Bearer ${f.a.welcome!.resumeToken}` },
    }));
    expect(response.status).toBe(404);
    expect(f.room.recorder).toBeUndefined();
  });
});

test("completed authoritative room replay opens all original boards through the viewer client", async () => {
  const { requestCompetitiveReplay } = await import("../../web/src/replay-request");
  const { mountCompetitivePlayback } = await import("../../web/src/competitive-playback");
  const { FakeDocument } = await import("../../web/test-dom");
  const f = fixture(3, "competitive", 1);
  f.a.send({ type: "skin", skin: "four" });
  f.start();
  const recorder = f.room.recorder!;
  f.clients[1].send({ type: "leave" });
  f.clients[2].send({ type: "leave" });
  await recorder.completion;
  const app = createApp({ rooms: f.rooms, scheduled: false });
  const request = (async (url: string, init?: RequestInit) => app.handle(new Request(`http://localhost${url}`, init))) as typeof fetch;
  const result = await requestCompetitiveReplay(f.room.code, f.a.welcome!.resumeToken, new AbortController().signal, request);
  expect(result.appearance.skinIds[f.a.welcome!.playerId]).toBe("four");
  const document = new FakeDocument();
  const view = mountCompetitivePlayback(document.root as unknown as HTMLElement, result.playback, result.summary, result.appearance, async () => undefined);
  view.seek(view.durationFrames);
  expect(result.playback.state).toEqual(f.room.match!.saveState());
  expect(document.root.children[0].children[1].children.map(card => card.getAttribute("data-player-id"))).toEqual([...f.room.match!.roster]);
  expect(document.root.children[0].children[0].textContent).toContain("wins");
  expect(document.root.children[0].children[0].textContent).toContain("forfeit");
  view.dispose();
  expect(f.room.seats.some(seat => seat.id === f.a.welcome!.playerId)).toBe(true);
});
