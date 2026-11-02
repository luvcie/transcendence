import { describe, expect, test } from "bun:test";
import { DEFAULT_HANDLING, FRAME_MS, Input } from "@42tris/core";
import { OwnerPrediction } from "@42tris/match";
import type { Checkpoint, ClientCommand, ServerMessage } from "@42tris/protocol";
import { Rooms, type Peer } from "../src/rooms";

interface TestClient {
  peer: Peer;
  send(command: ClientCommand): void;
  messages: ServerMessage[];
  closed: number[];
  welcome: Extract<ServerMessage, { type: "welcome" }> | undefined;
  checkpoint(): Checkpoint;
}

function fixture(count = 2, mode: "competitive" | "practice" = "competitive", firstTo = 2) {
  let now = 0;
  const rooms = new Rooms(() => now);
  const clients: TestClient[] = [];
  function client(token?: string): TestClient {
    const messages: ServerMessage[] = [];
    const closed: number[] = [];
    const peer: Peer = { id: crypto.randomUUID(), send: m => messages.push(m), close: code => { closed.push(code); } };
    rooms.connect(peer);
    const send = (command: ClientCommand) => rooms.receive(peer.id, command);
    send({ type: "hello", name: "Guest", guestProfileId: "same-profile", ...(token ? { resumeToken: token } : {}) });
    const welcome = messages.find(m => m.type === "welcome");
    const checkpoint = () => { send({ type: "resync" }); return [...messages].reverse().find(m => m.type === "checkpoint") as Checkpoint; };
    const c = { peer, send, messages, closed, welcome, checkpoint };
    clients.push(c);
    return c;
  }
  const a = client();
  a.send({ type: "create", requestId: "one", options: { firstTo, mode, attacksEnabled: true, maxPlayers: 8 } });
  const room = [...rooms.rooms.values()][0];
  for (let i = 1; i < count; i++) client().send({ type: "join", code: room.code });
  function advance(ms: number) { now += ms; rooms.tick(); }
  function prepared() {
    for (const c of clients) if (room.seats.some(s => s.peer?.id === c.peer.id)) c.send({ type: "prepared", matchId: room.matchId!, preparationId: room.preparationId });
    advance(3000);
  }
  function start() { for (const c of clients) c.send({ type: "ready", ready: true, handling: DEFAULT_HANDLING }); prepared(); }
  return { rooms, clients, a, room, client, advance, start, prepared };
}

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
    for (const c of f.clients) c.send({ type: "ready", ready: true, handling: DEFAULT_HANDLING });
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

  test("next-round readiness preserves Match, score and frozen handling; rematch replaces Match", () => {
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
    for (const c of f.clients) c.send({ type: "ready", ready: true, handling: { ...DEFAULT_HANDLING, arr: 0 } });
    f.prepared();
    expect(f.room.match).toBe(match);
    expect(match.round).toBe(2);
    expect(match.seed).not.toBe(oldSeed);
    expect(match.handlingByPlayer[b.welcome!.playerId]).toEqual(DEFAULT_HANDLING);
    loseRound();
    expect(f.room.phase).toBe("setResult");
    expect(match.scores[f.a.welcome!.playerId]).toBe(2);
    f.start();
    expect(f.room.match).not.toBe(match);
    expect(f.room.match!.scores[f.a.welcome!.playerId]).toBe(0);
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
