import { DEFAULT_HANDLING, FRAME_MS, type Handling } from "@42tris/core";
import { Match } from "@42tris/match";
import { MatchRecorder, type MatchRecorderOptions, type MatchReplay } from "@42tris/replay";
import { ClientCommandSchema, type Checkpoint, type ClientCommand, type ErrorCode, type InputItem, type RoomOptions, type RoomPhase, type RoomState, type ServerMessage } from "@42tris/protocol";
import { Value } from "@sinclair/typebox/value";

export interface Peer {
  id: string;
  send(message: ServerMessage, ephemeral?: boolean): void;
  close(code: number, reason: string): void;
}
class Bucket {
  private tokens: number;
  private at: number;
  constructor(private rate: number, private burst: number, now: number) { this.tokens = burst; this.at = now; }
  take(now: number, count = 1): boolean {
    this.tokens = Math.min(this.burst, this.tokens + Math.max(0, now - this.at) * this.rate / 1000);
    this.at = now;
    if (this.tokens < count) return false;
    this.tokens -= count;
    return true;
  }
}
interface Seat {
  id: string;
  token: string;
  name: string;
  skin: string;
  profileId?: string;
  peer?: Peer;
  room?: Room;
  ready: boolean;
  prepared: boolean;
  handling: Handling;
  deadline: number | null;
  lastSeen: number;
  generation: number;
  nextSeq: number;
  pending: Map<number, InputItem & { order: number }>;
  history: Map<number, string>;
  rejections: { seq: number; code: ErrorCode }[];
  inputs: Bucket;
  lastCreate?: { requestId: string; code: string; options: string };
}
export interface Room {
  code: string;
  ownerId: string;
  options: RoomOptions;
  seats: Seat[];
  revision: number;
  phase: RoomPhase;
  match?: Match;
  recorder?: MatchRecorder;
  matchId: string | null;
  preparationId: number;
  startsAt: number | null;
  prepareDeadline: number | null;
  origin: number | null;
  pausedAt: number | null;
  pausedTotal: number;
  frozenTime: number;
  roundCountdownRemaining: number | null;
  order: number;
  eventSequence: number;
  events: Checkpoint["events"];
  roundDurations: Checkpoint["roundDurations"];
  touchedAt: number;
  emptyAt: number | null;
}
interface Connection { peer: Peer; seat?: Seat; commands: Bucket; openedAt: number }
const opaque = () => crypto.randomUUID();
const seed = () => crypto.getRandomValues(new Int32Array(1))[0];
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export class Rooms {
  readonly rooms = new Map<string, Room>();
  private sessions = new Map<string, Seat>();
  private connections = new Map<string, Connection>();
  private serverSequence = 0;
  constructor(readonly now: () => number = () => performance.now(), private readonly replayOptions: MatchRecorderOptions = {}) {}

  completedReplay(code: string): MatchReplay | null {
    return this.rooms.get(code)?.recorder?.replay ?? null;
  }

  connect(peer: Peer): boolean {
    if (this.connections.size >= 128) { peer.close(1013, "CAPACITY"); return false; }
    this.connections.set(peer.id, { peer, commands: new Bucket(40, 80, this.now()), openedAt: this.now() });
    return true;
  }

  private error(peer: Peer, code: ErrorCode, message: string = code, requestId?: string): void {
    peer.send({ type: "error", code, message, ...(requestId ? { requestId } : {}) });
  }

  receive(peerId: string, command: unknown): void {
    const connection = this.connections.get(peerId);
    if (!connection) return;
    const { peer } = connection;
    if (!connection.commands.take(this.now())) { this.error(peer, "RATE_LIMIT"); return; }
    if (!Value.Check(ClientCommandSchema, command)) { this.error(peer, "INVALID_MESSAGE"); return; }
    if (command.type === "hello") { this.hello(connection, command); return; }
    const seat = connection.seat;
    if (!seat) { this.error(peer, "HELLO_REQUIRED"); return; }
    seat.lastSeen = this.now();
    if (command.type === "ping") { peer.send({ type: "pong", nonce: command.nonce, serverNow: this.now() }); return; }
    if (command.type === "create") { this.create(seat, command); return; }
    if (command.type === "join") { this.join(seat, command.code); return; }
    if (command.type === "leave") { if (seat.room) this.remove(seat); peer.send({ type: "left" }); return; }
    if (command.type === "rename") {
      seat.name = command.name.trim() || "Guest";
      if (seat.room) this.changed(seat.room);
      else peer.send({ type: "welcome", guestSessionId: seat.id, playerId: seat.id, resumeToken: seat.token, name: seat.name, room: null, generation: seat.generation, serverNow: this.now() });
      return;
    }
    if (command.type === "skin") {
      seat.skin = command.skin;
      if (seat.room) this.changed(seat.room);
      return;
    }
    const room = seat.room;
    if (!room) { this.error(peer, "NOT_IN_ROOM"); return; }
    if (command.type === "configure") {
      if (room.ownerId !== seat.id) { this.error(peer, "NOT_OWNER"); return; }
      if (room.phase !== "waiting" && room.phase !== "setResult") { this.error(peer, "WRONG_PHASE"); return; }
      if ((command.options.maxPlayers ?? 4) < room.seats.length || command.options.mode === "competitive" && !command.options.attacksEnabled) {
        this.error(peer, "INVALID_OPTIONS"); return;
      }
      room.options = { ...command.options, maxPlayers: command.options.maxPlayers ?? 4, width: command.options.width ?? 10 };
      for (const s of room.seats) s.ready = false;
      room.touchedAt = this.now();
      this.changed(room);
      return;
    }
    if (command.type === "resync") { this.checkpoint(room, seat); return; }
    if (command.type === "ready") {
      if (!["waiting", "setResult"].includes(room.phase)) { this.error(peer, "WRONG_PHASE"); return; }
      seat.ready = command.ready;
      seat.handling = { ...command.handling };
      room.touchedAt = this.now();
      this.changed(room);
      const eligible = this.eligible(room);
      if (eligible.length >= 2 && eligible.every(s => s.peer && s.ready)) {
        const activeRooms = [...this.rooms.values()].filter(r => !["waiting", "setResult"].includes(r.phase)).length;
        if (["waiting", "setResult"].includes(room.phase) && activeRooms >= 8) {
          seat.ready = false;
          this.error(peer, "CAPACITY", "Eight sets are already active");
          this.changed(room);
        } else this.prepare(room, false);
      }
      return;
    }
    if (command.type === "prepared") {
      if (room.phase !== "preparing" || command.matchId !== room.matchId || command.preparationId !== room.preparationId) { this.error(peer, "WRONG_PHASE"); return; }
      seat.prepared = true;
      if (this.eligible(room).every(s => s.peer && s.prepared)) {
        room.phase = "countdown";
        room.startsAt = this.now() + 3000;
        room.prepareDeadline = null;
      }
      this.changed(room);
      return;
    }
    if (command.type === "releaseControls") {
      this.invalidate(seat);
      this.collect(room);
      this.checkpoint(room, seat);
      return;
    }
    if (command.type === "inputBatch") { this.input(seat, command); return; }
    if (!room.match || room.phase !== "playing" || room.options.mode !== "practice") { this.error(peer, "WRONG_PHASE"); return; }
    if (command.type === "toggleAttacks") {
      if (room.ownerId !== seat.id) { this.error(peer, "NOT_OWNER"); return; }
      room.match.setAttacksEnabled(command.enabled);
      room.options.attacksEnabled = command.enabled;
      this.changed(room);
    } else {
      if (command.type === "practiceUndo") room.match.practiceUndo(seat.id);
      else room.match.practiceReset(seat.id);
      this.invalidate(seat);
    }
    this.collect(room);
    this.broadcastCheckpoint(room);
  }

  private hello(connection: Connection, command: Extract<ClientCommand, { type: "hello" }>): void {
    const { peer } = connection;
    if (connection.seat) { this.error(peer, "ALREADY_CONNECTED"); return; }
    const now = this.now();
    let seat: Seat;
    if (command.resumeToken) {
      const existing = this.sessions.get(command.resumeToken);
      if (!existing) { this.error(peer, "SESSION_EXPIRED"); return; }
      if (existing.peer) { this.error(peer, "ALREADY_CONNECTED"); return; }
      if (existing.deadline !== null && existing.deadline <= now && existing.room) this.remove(existing);
      seat = existing;
    } else {
      if (this.sessions.size >= 256) { this.error(peer, "CAPACITY"); return; }
      seat = { id: opaque(), token: opaque() + opaque(), name: command.name.trim() || "Guest", skin: "classic", profileId: command.guestProfileId,
        ready: false, prepared: false, handling: { ...DEFAULT_HANDLING }, deadline: null, lastSeen: now,
        generation: 0, nextSeq: 1, pending: new Map(), history: new Map(), rejections: [], inputs: new Bucket(240, 64, now) };
      this.sessions.set(seat.token, seat);
    }
    seat.name = command.name.trim() || "Guest";
    // Cosmetic only: a reconnect may refresh the skin, while older clients keep the stored one.
    seat.skin = command.skin ?? seat.skin;
    seat.peer = peer;
    seat.deadline = null;
    seat.lastSeen = now;
    connection.seat = seat;
    this.invalidate(seat);
    peer.send({ type: "welcome", guestSessionId: seat.id, playerId: seat.id, resumeToken: seat.token, name: seat.name,
      room: seat.room ? this.view(seat.room) : null, generation: seat.generation, serverNow: now });
    if (seat.room) {
      const room = seat.room;
      room.emptyAt = null;
      this.changed(room);
      if (room.phase === "paused" && this.eligible(room).every(s => s.peer)) this.resume(room);
      this.broadcastCheckpoint(room);
    }
  }

  private create(seat: Seat, command: Extract<ClientCommand, { type: "create" }>): void {
    const peer = seat.peer!;
    const optionsKey = JSON.stringify([command.options.firstTo, command.options.maxPlayers ?? 4, command.options.width ?? 10, command.options.mode, command.options.attacksEnabled]);
    if (seat.lastCreate?.requestId === command.requestId) {
      if (seat.lastCreate.options !== optionsKey) this.error(peer, "INVALID_OPTIONS", "requestId reused", command.requestId);
      else if (seat.room?.code === seat.lastCreate.code) peer.send({ type: "roomState", room: this.view(seat.room), serverNow: this.now(), requestId: command.requestId });
      else this.error(peer, "ROOM_NOT_FOUND", "Creation already completed", command.requestId);
      return;
    }
    if (seat.room) { this.error(peer, "ROOM_BUSY"); return; }
    if (this.rooms.size >= 32) { this.error(peer, "CAPACITY"); return; }
    if (command.options.mode === "competitive" && !command.options.attacksEnabled) { this.error(peer, "INVALID_OPTIONS"); return; }
    let code: string;
    do { code = Array.from(crypto.getRandomValues(new Uint8Array(6)), n => CODE_ALPHABET[n % 32]).join(""); } while (this.rooms.has(code));
    const room: Room = { code, ownerId: seat.id, options: { ...command.options, maxPlayers: command.options.maxPlayers ?? 4, width: command.options.width ?? 10 }, seats: [seat], revision: 0,
      phase: "waiting", matchId: null, preparationId: 0, startsAt: null, prepareDeadline: null, origin: null,
      pausedAt: null, pausedTotal: 0, frozenTime: 0, roundCountdownRemaining: null, order: 0, eventSequence: 0, events: [], roundDurations: [], touchedAt: this.now(), emptyAt: null };
    seat.room = room;
    seat.ready = false;
    seat.lastCreate = { requestId: command.requestId, code, options: optionsKey };
    this.rooms.set(code, room);
    this.changed(room, command.requestId);
  }

  private join(seat: Seat, code: string): void {
    const room = this.rooms.get(code);
    if (seat.room?.code === code) { this.changed(seat.room); return; }
    if (seat.room) { this.error(seat.peer!, "ROOM_BUSY"); return; }
    if (!room) { this.error(seat.peer!, "ROOM_NOT_FOUND"); return; }
    if (room.phase !== "waiting" && room.phase !== "setResult") { this.error(seat.peer!, "ROOM_BUSY"); return; }
    if (room.seats.length >= room.options.maxPlayers) { this.error(seat.peer!, "ROOM_FULL"); return; }
    room.seats.push(seat);
    seat.room = room;
    seat.ready = false;
    seat.prepared = false;
    room.emptyAt = null;
    room.touchedAt = this.now();
    if (!room.seats.some(s => s.id === room.ownerId && s.peer)) room.ownerId = seat.id;
    this.changed(room);
  }

  private eligible(room: Room): Seat[] {
    return room.seats.filter(s => !room.match || room.match.complete || room.match.activePlayers.includes(s.id));
  }

  private prepare(room: Room, resume: boolean): void {
    if (!resume) {
      room.recorder?.abandon();
      room.recorder = undefined;
      const seats = room.seats;
      room.match = new Match({ players: seats.map(s => s.id), seed: seed(), firstTo: room.options.firstTo, width: room.options.width, mode: room.options.mode,
        attacksEnabled: room.options.attacksEnabled, handlingByPlayer: Object.fromEntries(seats.map(s => [s.id, s.handling])) });
      room.matchId = opaque();
      if (room.options.mode === "competitive") {
        try { room.recorder = new MatchRecorder(room.match, room.matchId, { ...this.replayOptions, manualCompletion: true }); }
        catch (error) { console.error("Replay recorder initialization failed", error); }
      }
      room.events = [];
      room.roundDurations = [];
      room.eventSequence = 0;
      room.origin = null;
      room.pausedTotal = 0;
      room.pausedAt = null;
      room.frozenTime = 0;
      room.roundCountdownRemaining = null;
    }
    for (const s of room.seats) { s.ready = false; s.prepared = false; this.invalidate(s); }
    room.phase = "preparing";
    room.preparationId++;
    room.prepareDeadline = this.now() + 10_000;
    room.startsAt = null;
    this.collect(room);
    this.changed(room);
    this.broadcastCheckpoint(room);
  }

  private invalidate(seat: Seat, allowCompleted = false): void {
    const room = seat.room;
    const match = room?.match;
    if (match?.roster.includes(seat.id) && (!match.complete || allowCompleted)) {
      if (room?.recorder) room.recorder.releaseControls(seat.id);
      else match.releaseControls(seat.id);
    }
    seat.generation++;
    seat.nextSeq = 1;
    seat.pending.clear();
    seat.history.clear();
    seat.rejections = [];
  }

  private simulationNow(room: Room): number {
    if (room.phase !== "playing" || room.origin === null) return room.frozenTime;
    return Math.max(0, this.now() - room.origin - room.pausedTotal);
  }

  private input(seat: Seat, command: Extract<ClientCommand, { type: "inputBatch" }>): void {
    const room = seat.room!;
    const match = room.match;
    const peer = seat.peer!;
    if (!match || room.phase !== "playing" || !match.activePlayers.includes(seat.id)) { this.error(peer, "WRONG_PHASE"); return; }
    if (command.matchId !== room.matchId || command.generation !== seat.generation || command.epoch !== match.playerEpoch(seat.id)) { this.error(peer, "STALE_INPUT"); return; }
    if (!seat.inputs.take(this.now(), command.items.length)) { this.error(peer, "RATE_LIMIT"); return; }
    for (const item of command.items) {
      const fingerprint = JSON.stringify([item.frame, item.subframe, item.input]);
      if (item.seq < seat.nextSeq) {
        const previous = seat.history.get(item.seq);
        if (previous === undefined) this.error(peer, "SEQ_EXPIRED");
        else if (previous !== fingerprint) { this.error(peer, "SEQ_CONFLICT"); peer.close(1008, "SEQ_CONFLICT"); this.disconnect(peer.id); return; }
        continue;
      }
      if (item.seq > seat.nextSeq) { this.error(peer, "SEQ_GAP"); break; }
      seat.nextSeq++;
      seat.history.set(item.seq, fingerprint);
      if (seat.history.size > 256) seat.history.delete(seat.history.keys().next().value!);
      let rejected = item.frame < match.frame || item.frame > Math.floor(this.simulationNow(room) / FRAME_MS) + 2 || seat.pending.size >= 128;
      if (!rejected) {
        const order = room.order++;
        try {
          const input = { player: seat.id, frame: item.frame, subframe: item.subframe, input: item.input, epoch: command.epoch, order };
          if (room.recorder) room.recorder.submit(input);
          else match.submit(input);
          seat.pending.set(item.seq, { ...item, order });
        } catch (error) {
          if (!(error instanceof RangeError)) throw error;
          rejected = true;
        }
      }
      if (rejected) {
        seat.rejections.push({ seq: item.seq, code: "INPUT_REJECTED" });
        if (seat.rejections.length > 256) seat.rejections.shift();
      }
    }
    this.checkpoint(room, seat);
  }

  disconnect(peerId: string): void {
    const connection = this.connections.get(peerId);
    if (!connection) return;
    this.connections.delete(peerId);
    const seat = connection.seat;
    if (!seat || seat.peer?.id !== peerId) return;
    seat.peer = undefined;
    seat.lastSeen = this.now();
    seat.ready = false;
    seat.prepared = false;
    seat.deadline = this.now() + 40_000;
    const room = seat.room;
    if (!room) return;
    if (["playing", "countdown", "preparing", "roundResult"].includes(room.phase) && this.eligible(room).includes(seat)) this.pause(room);
    if (!room.seats.some(s => s.peer)) room.emptyAt = this.now();
    this.changed(room);
    this.broadcastCheckpoint(room);
  }

  private pause(room: Room): void {
    if (room.phase === "roundResult" && room.startsAt !== null) room.roundCountdownRemaining = Math.max(0, room.startsAt - this.now());
    room.frozenTime = this.simulationNow(room);
    room.pausedAt ??= this.now();
    room.phase = "paused";
    room.startsAt = null;
    room.prepareDeadline = null;
    for (const s of room.seats) this.invalidate(s);
    this.collect(room);
  }

  private resume(room: Room): void {
    if (room.roundCountdownRemaining === null) { this.prepare(room, true); return; }
    room.phase = "roundResult";
    room.startsAt = this.now() + room.roundCountdownRemaining;
    room.roundCountdownRemaining = null;
    room.pausedAt = null;
    this.changed(room);
  }

  private remove(seat: Seat, deferPublish = false, allowForfeit = !seat.room?.match?.complete): void {
    const room = seat.room!;
    this.invalidate(seat, allowForfeit);
    if (room.match?.roster.includes(seat.id)) {
      if (room.match.mode === "competitive") {
        if (allowForfeit) {
          if (room.recorder) room.recorder.forfeit(seat.id);
          else room.match.forfeit(seat.id);
        }
      }
      else {
        room.match = undefined;
        room.matchId = null;
        room.phase = "waiting";
        room.origin = null;
        room.pausedAt = null;
        room.pausedTotal = 0;
        room.frozenTime = 0;
        room.events = [];
        room.roundDurations = [];
        room.startsAt = null;
        room.prepareDeadline = null;
        for (const s of room.seats) { s.ready = false; this.invalidate(s); }
      }
    }
    room.seats = room.seats.filter(s => s !== seat);
    seat.room = undefined;
    seat.deadline = null;
    seat.ready = false;
    if (room.ownerId === seat.id) room.ownerId = (room.seats.find(s => s.peer) ?? room.seats[0])?.id ?? "";
    if (!room.seats.some(s => s.peer)) room.emptyAt ??= this.now();
    room.touchedAt = this.now();
    this.collect(room);
    if (deferPublish) return;
    this.result(room);
    if (["preparing", "countdown"].includes(room.phase) && !room.match?.ended) this.pause(room);
    this.changed(room);
    this.broadcastCheckpoint(room);
  }

  private result(room: Room): void {
    if (!room.match?.ended) return;
    const phase = room.match.complete ? "setResult" : "roundResult";
    if (room.phase === phase || phase === "roundResult" && room.phase === "paused" && room.roundCountdownRemaining !== null) return;
    room.frozenTime = room.match.frame * FRAME_MS;
    room.phase = phase;
    room.startsAt = phase === "roundResult" ? this.now() + 3000 : null;
    room.roundCountdownRemaining = null;
    room.prepareDeadline = null;
    room.touchedAt = this.now();
    for (const s of room.seats) { s.ready = false; this.invalidate(s, phase === "setResult"); }
    if (phase === "setResult") void room.recorder?.finish();
    if (phase === "roundResult" && this.eligible(room).some(s => !s.peer)) this.pause(room);
    this.collect(room);
    this.changed(room);
  }

  tick(): void {
    const now = this.now();
    for (const connection of this.connections.values()) {
      if (!connection.seat && now - connection.openedAt > 5000) { connection.peer.close(1008, "HELLO_REQUIRED"); this.disconnect(connection.peer.id); }
    }
    for (const room of this.rooms.values()) {
      // Process every expired seat before resuming or publishing the final set result.
      const expired = room.seats.filter(s => !s.peer && s.deadline !== null && s.deadline <= now);
      // A first forfeit can finish an unfinished set; the rest of that batch must
      // still withdraw so simultaneous expiry can produce an aborted result.
      const allowForfeit = !room.match?.complete;
      for (const s of expired) this.remove(s, true, allowForfeit);
      if (expired.length) {
        const latestSetEnd = [...room.events].reverse().find(e => e.event.type === "setEnd");
        if (latestSetEnd?.event.type === "setEnd" && latestSetEnd.event.reason === "aborted") {
          room.events = room.events.filter(e => e.event.type !== "setEnd" || e === latestSetEnd);
        }
        this.result(room);
        this.changed(room);
        this.broadcastCheckpoint(room);
      }
      if (room.phase === "paused" && this.eligible(room).length && this.eligible(room).every(s => s.peer)) this.resume(room);
      if (room.phase === "preparing" && room.prepareDeadline !== null && now >= room.prepareDeadline) {
        for (const s of this.eligible(room)) if (!s.prepared && s.peer) { const peer = s.peer; peer.close(1008, "PREPARE_TIMEOUT"); this.disconnect(peer.id); }
      }
      if (room.phase === "countdown" && room.startsAt !== null && now >= room.startsAt) {
        if (room.origin === null) { room.origin = room.startsAt; room.pausedAt = null; }
        else if (room.pausedAt !== null) { room.pausedTotal += room.startsAt - room.pausedAt; room.pausedAt = null; }
        room.phase = "playing";
        room.startsAt = null;
        this.changed(room);
      }
      if (room.phase === "roundResult" && room.startsAt !== null && now >= room.startsAt && room.match && !room.match.complete && room.match.ended) {
        let nextSeed = seed();
        while (nextSeed === room.match.seed) nextSeed = seed();
        if (room.recorder) room.recorder.nextRound(nextSeed);
        else room.match.nextRound(nextSeed);
        room.origin = room.startsAt;
        room.pausedTotal = 0;
        room.pausedAt = null;
        room.frozenTime = 0;
        room.startsAt = null;
        room.phase = "playing";
        for (const s of room.seats) this.invalidate(s);
        this.collect(room);
        this.broadcastCheckpoint(room);
        this.changed(room);
      }
      if (room.phase === "playing" && room.match) {
        const target = Math.max(room.match.frame, Math.floor(Math.max(0, this.simulationNow(room) - 100) / FRAME_MS));
        if (room.recorder) room.recorder.advanceToFrame(target);
        else room.match.advanceToFrame(target);
        for (const s of room.seats) for (const [seq, input] of s.pending) if (input.frame < room.match.frame) s.pending.delete(seq);
        this.collect(room);
        this.result(room);
      }
      const emptyExpired = room.emptyAt !== null && now - room.emptyAt >= 60_000;
      const idleExpired = ["waiting", "roundResult", "setResult"].includes(room.phase) && now - room.touchedAt >= 15 * 60_000;
      if (emptyExpired || idleExpired) {
        for (const s of room.seats) { s.room = undefined; s.ready = false; s.peer?.send({ type: "left" }); }
        room.recorder?.abandon();
        room.recorder = undefined;
        this.rooms.delete(room.code);
      }
    }
    for (const [token, s] of this.sessions) if (!s.peer && !s.room && now - s.lastSeen >= 15 * 60_000) this.sessions.delete(token);
  }

  private collect(room: Room): void {
    const events = room.recorder ? room.recorder.drainEvents() : room.match?.drainEvents() ?? [];
    for (const event of events) {
      room.events.push({ sequence: ++room.eventSequence, event });
      if (event.type === "roundEnd") room.roundDurations.push({ round: event.round, durationMs: event.atMs });
    }
    if (room.events.length > 256) room.events.splice(0, room.events.length - 256);
  }

  view(room: Room): RoomState {
    return { code: room.code, revision: room.revision, ownerId: room.ownerId, options: { ...room.options }, phase: room.phase,
      matchId: room.matchId, preparationId: room.preparationId, startsAt: room.startsAt, prepareDeadline: room.prepareDeadline,
      players: room.seats.map(s => ({ playerId: s.id, name: s.name, skin: s.skin, connected: !!s.peer, ready: s.ready, prepared: s.prepared,
        deadline: s.deadline, withdrawn: !!room.match?.roster.includes(s.id) && !room.match.activePlayers.includes(s.id) })) };
  }

  private changed(room: Room, requestId?: string): void {
    room.revision++;
    const message: ServerMessage = { type: "roomState", room: this.view(room), serverNow: this.now(), ...(requestId ? { requestId } : {}) };
    for (const s of room.seats) s.peer?.send(message);
  }

  checkpoint(room: Room, seat: Seat): void {
    if (!seat.peer) return;
    const pendingAccepted = [...seat.pending.values()];
    const simulationNow = this.simulationNow(room);
    seat.peer.send({ type: "checkpoint", serverSequence: ++this.serverSequence, serverNow: this.now(), room: this.view(room), matchId: room.matchId,
      state: room.match?.saveState() ?? null,
      owner: { generation: seat.generation, epoch: room.match?.roster.includes(seat.id) ? room.match.playerEpoch(seat.id) : 0,
        nextSeq: seat.nextSeq, resolvedThroughSeq: pendingAccepted.length ? Math.min(...pendingAccepted.map(i => i.seq)) - 1 : seat.nextSeq - 1,
        pendingAccepted, rejections: [...seat.rejections] },
      clock: { currentTargetFrame: Math.floor(simulationNow / FRAME_MS), simulationNow, origin: room.origin, pausedTotal: room.pausedTotal,
        commitDelayMs: 100, frozen: room.phase !== "playing" }, roundDurations: room.roundDurations.map(duration => ({ ...duration })), events: [...room.events] }, true);
  }

  broadcastCheckpoint(room: Room): void { for (const s of room.seats) this.checkpoint(room, s); }
  snapshots(): void { for (const room of this.rooms.values()) this.broadcastCheckpoint(room); }
}
