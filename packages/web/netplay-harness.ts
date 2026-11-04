import { DEFAULT_HANDLING, Input, type InputId } from "@42tris/core";
import type { ClientCommand, RoomOptions, ServerMessage } from "@42tris/protocol";
import { Rooms, type Peer, type Room } from "../server/src/rooms";
import { Session, type SessionOptions, type Transport } from "./src/session";
import { SessionDiagnostics } from "./src/session-diagnostics";

/**
 * Deterministic in-process netplay harness.
 *
 * Uses the real Rooms/Match authority and the real web Session, with a fake
 * clock and an ordered transport. It models independent upstream/downstream delays, seeded jitter, ordered bursts,
 * browser-like stalls (timers, frames, inbound messages and input handling all
 * pause), FIFO bandwidth, spikes, and directional holds. No real sockets and no real sleeping.
 */
const CLIENT_KEYS = ["a", "b", "c", "d", "e", "f", "g", "h"] as const;
export type ClientKey = typeof CLIENT_KEYS[number];

export interface LinkProfile {
  /** One-way client -> server delay in milliseconds. */
  up?: number;
  /** One-way server -> client delay in milliseconds. */
  down?: number;
  /** Symmetric per-message jitter; seeded and deterministic. */
  jitter?: number;
  /** Per-message chance of a head-of-line spike. */
  spikeChance?: number;
  spikeMs?: number;
  /** Application bytes/sec, independent FIFO links. Zero means unlimited. */
  upBytesPerSec?: number;
  downBytesPerSec?: number;
  /** Model bytes hidden from the server's buffered-amount check. Default zero. */
  hiddenBufferBytes?: number;
  /** Model app.ts's ephemeral checkpoint skip when the visible queue exceeds 64 KiB. */
  backpressure?: boolean;
  /** Browser monotonic clock rate in parts per million, for diagnostic experiments. */
  clockDriftPpm?: number;
  clockOffsetMs?: number;
}

export interface NetHarnessOptions {
  seed?: number;
  /** 2–8 profiles. Omit to retain the a/b API and its defaults. */
  players?: readonly LinkProfile[];
  diagnostics?: boolean;
  /** Actual Session configuration, independent of clock offsets and link profiles. */
  inputLeadMs?: Partial<Record<ClientKey, number | "auto">>;
  /** Inspection caps: players API defaults to 16/256/128; legacy a/b API keeps complete capture.
   * Set a cap to Infinity for complete history, or zero to retain none. Delivery is unaffected. */
  messageHistory?: number;
  commandHistory?: number;
  batchHistory?: number;
  a?: LinkProfile;
  b?: LinkProfile;
  connectMs?: number;
  frameMs?: number;
  serverTickMs?: number;
  snapshotMs?: number;
  /** Dispatch a stalled physical input before timers and animation frames. */
  inputFirst?: boolean;
  /** Model app.ts native ping/pong leases independently of browser tasks. */
  heartbeat?: boolean;
}

type Callbacks = Parameters<SessionOptions["connect"]>[0];
type Kind = "server" | "snapshot" | "message" | "service" | "timer" | "frame" | "action";
type Direction = "up" | "down";
interface Transmission {
  remaining: number;
  delay: number;
  browser: boolean;
  run(): void;
}
interface ByteQueue {
  pending: Transmission[];
  bytes: number;
  at: number;
  arrival: number;
  service?: Scheduled;
}
interface HarnessSocket {
  id: string;
  key: ClientKey;
  closed: boolean;
  up: ByteQueue;
  down: ByteQueue;
}
interface Scheduled {
  at: number;
  priority: number;
  order: number;
  kind: Kind;
  client?: ClientKey;
  socket?: HarnessSocket;
  path?: { key: ClientKey; direction: Direction };
  run(): void;
}

const FRAME_MS = 1000 / 60;
const PRIORITY = { server: 0, snapshot: 1, message: 2, timer: 3, frame: 4, action: 5 } as const;
const EPSILON = 1e-9;

function retain<T>(history: T[], item: T, limit: number): void {
  if (limit === 0) return;
  if (history.length >= limit) history.shift();
  history.push(item);
}

function seeded(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    return value / 0x1_0000_0000;
  };
}

export class HarnessClient {
  readonly commands: ClientCommand[] = [];
  readonly batches: Extract<ClientCommand, { type: "inputBatch" }>[] = [];
  readonly messages: ServerMessage[] = [];
  readonly session: Session;
  readonly diagnostics?: SessionDiagnostics;
  peer?: Peer;
  connections = 0;
  lastCheckpointAt = -Infinity;
  readonly traffic = { upBytes: 0, upMessages: 0, inputBatches: 0, inputItems: 0,
    downBytes: 0, downMessages: 0, skippedCheckpoints: 0 };
  /** Independent event-interval integration, not derived from browser diagnostics. */
  readonly control = { eligibleMs: 0, blockedMs: 0 };
  keysCleared = 0;

  constructor(net: NetHarness, readonly key: ClientKey, diagnostics: boolean, inputLeadMs?: number | "auto") {
    this.diagnostics = diagnostics ? new SessionDiagnostics() : undefined;
    const values = new Map<string, string>([["42tris.profile", `harness-${key}`]]);
    const store = {
      getItem: (name: string) => values.get(name) ?? null,
      setItem: (name: string, value: string) => { values.set(name, value); },
      removeItem: (name: string) => { values.delete(name); },
    };
    this.session = new Session({
      now: () => net.clientTime(key),
      storage: store,
      profile: store,
      clearKeys: () => { this.keysCleared++; },
      diagnostics: this.diagnostics,
      inputLeadMs,
      schedule: (callback, delay) => net.scheduleTimer(this.key, callback, delay),
      connect: callbacks => net.connectClient(this, callbacks),
    });
    this.session.start();
  }
}

export class NetHarness {
  readonly rooms: Rooms;
  readonly a: HarnessClient;
  readonly b: HarnessClient;
  readonly clients: readonly HarnessClient[];
  private now = 0;
  private events: Scheduled[] = [];
  private order = 0;
  private readonly links = new Map<ClientKey, {
    profile: LinkProfile & { up: number; down: number; jitter: number };
    random(): number;
    stallUntil: number; upHoldUntil: number; downHoldUntil: number;
    socket?: HarnessSocket;
  }>();
  private readonly connectMs: number;
  private readonly frameMs: number;
  private readonly inputPriority: number;
  private readonly heartbeat: boolean;
  private readonly messageHistory: number;
  private readonly commandHistory: number;
  private readonly batchHistory: number;

  constructor(options: NetHarnessOptions = {}) {
    const legacy = options.players === undefined;
    this.messageHistory = options.messageHistory ?? (legacy ? Infinity : 16);
    this.commandHistory = options.commandHistory ?? (legacy ? Infinity : 256);
    this.batchHistory = options.batchHistory ?? (legacy ? Infinity : 128);
    for (const limit of [this.messageHistory, this.commandHistory, this.batchHistory]) {
      if (limit !== Infinity && (!Number.isInteger(limit) || limit < 0)) {
        throw new RangeError("History limits must be nonnegative integers or Infinity");
      }
    }
    const profiles = options.players ?? [options.a ?? {}, options.b ?? {}];
    if (profiles.length < 2 || profiles.length > 8) throw new RangeError("NetHarness requires 2–8 players");
    profiles.forEach((profile, index) => this.links.set(CLIENT_KEYS[index], {
      profile: { up: 10, down: 10, jitter: 0, ...profile },
      random: seeded((options.seed ?? 1) + index * 7919),
      stallUntil: 0, upHoldUntil: 0, downHoldUntil: 0,
    }));
    this.heartbeat = options.heartbeat ?? false;
    this.connectMs = options.connectMs ?? 5;
    this.frameMs = options.frameMs ?? FRAME_MS;
    this.inputPriority = options.inputFirst ? PRIORITY.message + 0.5 : PRIORITY.action;
    const random = seeded(options.seed ?? 1);
    let id = 0;
    this.rooms = new Rooms(() => this.now, {}, {
      id: () => `00000000-0000-4000-8000-${(++id).toString(16).padStart(12, "0")}`,
      seed: () => (random() * 0x1_0000_0000) | 0,
      code: () => Array.from({ length: 6 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[Math.floor(random() * 32)]).join(""),
    });
    this.clients = profiles.map((_, index) => new HarnessClient(this, CLIENT_KEYS[index], !!options.diagnostics,
      options.inputLeadMs?.[CLIENT_KEYS[index]]));
    [this.a, this.b] = this.clients;
    const tick = () => {
      this.rooms.tick();
      this.schedule(this.now + (options.serverTickMs ?? 10), PRIORITY.server, "server", undefined, tick);
    };
    const snapshot = () => {
      this.rooms.snapshots();
      this.schedule(this.now + (options.snapshotMs ?? 50), PRIORITY.snapshot, "snapshot", undefined, snapshot);
    };
    this.schedule(0, PRIORITY.server, "server", undefined, tick);
    this.schedule(0, PRIORITY.snapshot, "snapshot", undefined, snapshot);
    for (const client of this.clients) {
      const key = client.key;
      const frame = () => {
        client.diagnostics?.frame(this.clientTime(key));
        client.session.tick();
        this.schedule(this.now + this.frameMs, PRIORITY.frame, "frame", key, frame);
      };
      this.schedule(this.frameMs, PRIORITY.frame, "frame", key, frame);
    }
  }

  get time(): number { return this.now; }
  get room(): Room | undefined { return [...this.rooms.rooms.values()][0]; }
  get aCheckpoint() { return this.a.session.checkpoint; }
  get bCheckpoint() { return this.b.session.checkpoint; }

  setLink(key: ClientKey, profile: LinkProfile): void {
    const link = this.link(key);
    if (link.socket) {
      this.settle(link.socket, "up");
      this.settle(link.socket, "down");
    }
    link.profile = { ...link.profile, ...profile };
    if (link.socket) {
      this.service(link.socket, "up");
      this.service(link.socket, "down");
    }
  }

  /** Browser stall: no frames, timers, inbound messages, or input handling until it ends. */
  stall(key: ClientKey, durationMs: number): void {
    this.link(key).stallUntil = Math.max(this.link(key).stallUntil, this.now + durationMs);
  }

  /** Suspend downstream byte service/delivery; browser frames and timers continue. */
  holdDownstream(key: ClientKey, durationMs: number): void {
    this.hold(key, "down", durationMs);
  }

  /** Queue an input now, or at stall end when the browser cannot run its handler. */
  press(key: ClientKey, input: InputId): void {
    if (this.now < this.link(key).stallUntil) {
      this.schedule(this.link(key).stallUntil, this.inputPriority, "action", key, () => this.client(key).session.input(input));
      return;
    }
    this.client(key).session.input(input);
  }

  advance(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      let best: Scheduled | null = null;
      let bestAt = Infinity;
      for (const event of this.events) {
        const at = this.effectiveAt(event);
        if (at > end + EPSILON) continue;
        if (!best || at < bestAt - EPSILON
          || Math.abs(at - bestAt) <= EPSILON && (event.priority < best.priority
            || event.priority === best.priority && event.order < best.order)) {
          best = event;
          bestAt = at;
        }
      }
      if (!best) break;
      this.events.splice(this.events.indexOf(best), 1);
      this.measureControl(Math.max(this.now, bestAt));
      this.now = Math.max(this.now, bestAt);
      best.run();
    }
    this.measureControl(end);
    this.now = end;
  }

  runUntil(predicate: () => boolean, limit = 5000): void {
    const end = this.now + limit;
    while (!predicate() && this.now < end) this.advance(Math.min(5, end - this.now));
    if (!predicate()) throw new Error(`NetHarness timed out at ${this.now.toFixed(1)}ms`);
  }

  startMatch(options: Partial<RoomOptions> = {}): void {
    this.runUntil(() => this.clients.every(c => c.session.connected), 2000);
    const roomOptions: RoomOptions = {
      firstTo: 7, maxPlayers: Math.max(4, this.clients.length), mode: "competitive", attacksEnabled: true, width: 10, ...options,
    };
    this.a.session.send({ type: "create", requestId: "harness", options: roomOptions });
    this.runUntil(() => !!this.a.session.room, 2000);
    const code = this.a.session.room!.code;
    for (const client of this.clients.slice(1)) client.session.send({ type: "join", code });
    this.runUntil(() => this.clients.every(c => c.session.room?.code === code), 2000);
    for (const client of this.clients) {
      client.session.send({ type: "ready", ready: true, handling: DEFAULT_HANDLING });
    }
    this.runUntil(() => this.clients.every(c => c.session.canPlay), 8000);
  }

  /** Drop pieces until the match leaves the playing phase or the budget expires. */
  dropOut(key: ClientKey, limit = 20_000): void {
    const end = this.now + limit;
    while (this.now < end && this.room?.phase === "playing") {
      this.press(key, Input.HardDrop);
      this.advance(120);
    }
    if (this.room?.phase === "playing") throw new Error(`Could not drop out ${key} within ${limit}ms`);
  }

  scheduleTimer(key: ClientKey, callback: () => void, delay: number): () => void {
    const event: Scheduled = {
      at: this.now + delay / (1 + (this.link(key).profile.clockDriftPpm ?? 0) / 1e6), priority: PRIORITY.timer, order: ++this.order, kind: "timer", client: key,
      run: () => callback(),
    };
    this.events.push(event);
    return () => {
      const index = this.events.indexOf(event);
      if (index >= 0) this.events.splice(index, 1);
    };
  }

  scheduledTimers(key: ClientKey): ReadonlyArray<{ at: number; run(): void }> {
    return this.events.filter(event => event.client === key && event.kind === "timer")
      .map(({ at, run }) => ({ at, run }));
  }

  connectClient(client: HarnessClient, callbacks: Callbacks): Transport {
    const id = `${client.key}:${++client.connections}`;
    const queue = (): ByteQueue => ({ pending: [], bytes: 0, at: this.now, arrival: this.now });
    const socket: HarnessSocket = { id, key: client.key, closed: false, up: queue(), down: queue() };
    this.link(client.key).socket = socket;
    const peer: Peer = {
      id,
      send: (message, ephemeral = false) => {
        if (socket.closed) return;
        if (ephemeral && this.bufferedBytes(client.key) > 64 * 1024) {
          client.traffic.skippedCheckpoints++;
          if (this.rooms.metrics) this.rooms.recordTransmission(id, 0, message.type === "checkpoint", true);
          return;
        }
        // Capture once at send time; inspection histories retain only the decoded delivery.
        const payload = JSON.stringify(message);
        const bytes = new TextEncoder().encode(payload).byteLength;
        if (this.rooms.metrics) this.rooms.recordTransmission(id, bytes, message.type === "checkpoint");
        this.transmit(socket, "down", bytes, () => {
          client.traffic.downBytes += bytes;
          client.traffic.downMessages++;
          const received = JSON.parse(payload) as ServerMessage;
          retain(client.messages, received, this.messageHistory);
          if (received.type === "checkpoint") client.lastCheckpointAt = this.now;
          callbacks.message(received);
          client.diagnostics?.receivedMessage(this.clientTime(client.key), payload);
        });
      },
      close: () => {
        if (socket.closed) return;
        this.closeSocket(socket);
        this.schedule(this.now, PRIORITY.server, "server", undefined, () => this.rooms.disconnect(id));
        this.notify(client.key, "down", () => callbacks.close());
      },
    };
    client.peer = peer;
    this.rooms.connect(peer);
    if (this.heartbeat) this.startHeartbeat(socket, peer);
    const open = this.schedule(this.now + this.connectMs, PRIORITY.message, "server", undefined, () => {
      if (!socket.closed && client.peer === peer) callbacks.open();
    });
    open.socket = socket;
    return {
      send: command => {
        if (socket.closed) return;
        retain(client.commands, command, this.commandHistory);
        client.traffic.upMessages++;
        if (command.type === "inputBatch") {
          retain(client.batches, command, this.batchHistory);
          client.traffic.inputBatches++;
          client.traffic.inputItems += command.items.length;
        }
        const payload = JSON.stringify(command);
        const bytes = new TextEncoder().encode(payload).byteLength;
        client.traffic.upBytes += bytes;
        this.transmit(socket, "up", bytes, () => this.rooms.receive(id, JSON.parse(payload)));
      },
      close: () => {
        if (socket.closed) return;
        this.closeSocket(socket);
        this.notify(client.key, "up", () => this.rooms.disconnect(id));
        callbacks.close();
      },
    };
  }

  private closeSocket(socket: HarnessSocket): void {
    socket.closed = true;
    this.events = this.events.filter(event => event.socket !== socket);
    for (const direction of ["up", "down"] as const) {
      const queue = socket[direction];
      queue.pending.length = 0;
      queue.bytes = 0;
      queue.service = undefined;
    }
    const link = this.link(socket.key);
    if (link.socket === socket) link.socket = undefined;
  }

  /** Close notifications carry no payload reservation and still obey path availability. */
  private notify(key: ClientKey, direction: Direction, run: () => void): void {
    const event = this.schedule(this.now + this.jittered(key, direction), PRIORITY.message,
      "message", direction === "down" ? key : undefined, run);
    event.path = { key, direction };
  }

  private startHeartbeat(socket: HarnessSocket, peer: Peer): void {
    let lastPong = this.now;
    let lastPing = this.now;
    const sweep = () => {
      if (socket.closed) return;
      if (this.now - lastPong >= 6000) { peer.close(1001, "HEARTBEAT_TIMEOUT"); return; }
      if (this.now - lastPing >= 2000) {
        lastPing = this.now;
        this.transmit(socket, "down", 0, () => {
          this.transmit(socket, "up", 0, () => { lastPong = this.now; }, false);
        }, false);
      }
      const event = this.schedule(this.now + 250, PRIORITY.server, "server", undefined, sweep);
      event.socket = socket;
    };
    const event = this.schedule(this.now + 250, PRIORITY.server, "server", undefined, sweep);
    event.socket = socket;
  }

  private transmit(socket: HarnessSocket, direction: Direction, bytes: number, run: () => void, browser = true): void {
    if (socket.closed) return;
    this.settle(socket, direction);
    const queue = socket[direction];
    queue.pending.push({ remaining: bytes, delay: this.jittered(socket.key, direction), browser, run });
    queue.bytes += bytes;
    this.service(socket, direction);
  }

  /** Settle only actual head-payload service, excluding every millisecond of a hold. */
  private settle(socket: HarnessSocket, direction: Direction): void {
    const queue = socket[direction];
    const link = this.link(socket.key);
    const rate = direction === "up" ? link.profile.upBytesPerSec : link.profile.downBytesPerSec;
    const hold = direction === "up" ? link.upHoldUntil : link.downHoldUntil;
    const head = queue.pending[0];
    if (head && rate) {
      const elapsed = Math.max(0, this.now - Math.max(queue.at, hold));
      const bytes = Math.min(head.remaining, elapsed * rate / 1000);
      head.remaining -= bytes;
      queue.bytes = Math.max(0, queue.bytes - bytes);
    }
    queue.at = this.now;
  }

  private service(socket: HarnessSocket, direction: Direction): void {
    if (socket.closed) return;
    const queue = socket[direction];
    this.cancel(queue.service);
    queue.service = undefined;
    this.settle(socket, direction);
    const link = this.link(socket.key);
    const rate = direction === "up" ? link.profile.upBytesPerSec : link.profile.downBytesPerSec;
    const hold = direction === "up" ? link.upHoldUntil : link.downHoldUntil;
    while (queue.pending.length && (!rate || queue.pending[0].remaining <= EPSILON)) {
      const item = queue.pending.shift()!;
      queue.bytes = Math.max(0, queue.bytes - item.remaining);
      queue.arrival = Math.max(this.now + item.delay, queue.arrival);
      const delivery = this.schedule(queue.arrival, PRIORITY.message, "message",
        direction === "down" && item.browser ? socket.key : undefined, () => {
          if (!socket.closed) item.run();
        });
      delivery.socket = socket;
      delivery.path = { key: socket.key, direction };
    }
    if (!queue.pending.length) { queue.bytes = 0; return; }
    const head = queue.pending[0];
    const event = this.schedule(Math.max(this.now, hold) + head.remaining * 1000 / rate!,
      PRIORITY.message, "service", undefined, () => {
        if (socket.closed || queue.service !== event) return;
        queue.service = undefined;
        // The current completion event settles the remainder exactly. Recomputing
        // tiny residuals from elapsed time can schedule endlessly at the same float timestamp.
        queue.bytes = Math.max(0, queue.bytes - head.remaining);
        head.remaining = 0;
        queue.at = this.now;
        this.service(socket, direction);
      });
    event.socket = socket;
    queue.service = event;
  }

  private hold(key: ClientKey, direction: Direction, durationMs: number): void {
    const link = this.link(key);
    if (link.socket) this.settle(link.socket, direction);
    if (direction === "up") link.upHoldUntil = Math.max(link.upHoldUntil, this.now + durationMs);
    else link.downHoldUntil = Math.max(link.downHoldUntil, this.now + durationMs);
    if (link.socket) this.service(link.socket, direction);
  }

  /** Actual unsent application bytes; propagation and browser-delivery delays add no bytes. */
  queuedBytes(key: ClientKey, direction: Direction = "down"): number {
    const socket = this.link(key).socket;
    if (!socket) return 0;
    this.settle(socket, direction);
    return socket[direction].bytes;
  }

  /** Visible socket backlog after the configured hidden-buffer allowance. */
  bufferedBytes(key: ClientKey): number {
    const profile = this.link(key).profile;
    if (!profile.backpressure) return 0;
    return Math.max(0, this.queuedBytes(key) - (profile.hiddenBufferBytes ?? 0));
  }

  private jittered(key: ClientKey, direction: "up" | "down"): number {
    const link = this.link(key);
    const profile = link.profile;
    const offset = (link.random() * 2 - 1) * profile.jitter;
    const spike = profile.spikeChance && link.random() < profile.spikeChance ? profile.spikeMs ?? 0 : 0;
    return Math.max(0, profile[direction] + offset + spike);
  }

  private effectiveAt(event: Scheduled): number {
    const hold = event.path && this.link(event.path.key);
    const availableAt = hold ? (event.path!.direction === "up" ? hold.upHoldUntil : hold.downHoldUntil) : 0;
    return Math.max(event.at, availableAt, event.client ? this.link(event.client).stallUntil : 0);
  }

  private schedule(at: number, priority: number, kind: Kind, client: ClientKey | undefined, run: () => void): Scheduled {
    const event = { at, priority, order: ++this.order, kind, client, run };
    this.events.push(event);
    return event;
  }

  private cancel(event: Scheduled | undefined): void {
    if (!event) return;
    const index = this.events.indexOf(event);
    if (index >= 0) this.events.splice(index, 1);
  }

  client(key: ClientKey): HarnessClient {
    const client = this.clients.find(client => client.key === key);
    if (!client) throw new RangeError(`No harness client ${key}`);
    return client;
  }

  private link(key: ClientKey) {
    const link = this.links.get(key);
    if (!link) throw new RangeError(`No harness link ${key}`);
    return link;
  }

  clientTime(key: ClientKey): number {
    const profile = this.link(key).profile;
    return this.now * (1 + (profile.clockDriftPpm ?? 0) / 1e6) + (profile.clockOffsetMs ?? 0);
  }

  holdUpstream(key: ClientKey, durationMs: number): void {
    this.hold(key, "up", durationMs);
  }

  /** A bounded two-way path hold pauses bandwidth service; browser frames/timers continue. */
  outage(key: ClientKey, durationMs: number): void {
    this.holdUpstream(key, durationMs);
    this.holdDownstream(key, durationMs);
  }

  /** Script times are milliseconds relative to now. Inputs still pass through Session. */
  script(key: ClientKey, actions: readonly (readonly [number, InputId])[]): void {
    for (const [delay, input] of actions) {
      this.schedule(this.now + delay, this.inputPriority, "action", key, () => this.press(key, input));
    }
  }

  /** Deterministic taps, holds and one-shots, including bursts inside the 34 ms throttle. */
  playScript(key: ClientKey, durationMs: number, seed = 1): void {
    const random = seeded(seed);
    for (let at = 0; at < durationMs; at += 625) {
      const right = random() < 0.5;
      this.script(key, [
        [at, random() < 0.5 ? Input.RotateCw : Input.RotateCcw],
        [at + 15, right ? Input.RightDown : Input.LeftDown],
        [at + (random() < 0.3 ? 210 : 40), right ? Input.RightUp : Input.LeftUp],
        [at + 250, Input.HardDrop],
      ]);
    }
  }

  private measureControl(until: number): void {
    for (const client of this.clients) {
      const session = client.session;
      const cp = session.checkpoint;
      const state = cp?.state;
      const owner = state?.players[state.roster.indexOf(session.playerId)];
      if (!session.connected || session.room?.phase !== "playing" || !owner || owner.withdrawn
        || state?.mode === "competitive" && (owner.eliminated || owner.game.state.topOut)) continue;
      const duration = until - this.now;
      client.control.eligibleMs += duration;
      if (!session.canPlay) client.control.blockedMs += duration;
      // A checkpoint can expire between scheduled events.
      else if (cp) {
        // Receipt times come from the transport, independently of diagnostics.
        const expiry = client.lastCheckpointAt + 2000 / (1 + (this.link(client.key).profile.clockDriftPpm ?? 0) / 1e6);
        client.control.blockedMs += Math.max(0, until - Math.max(this.now, expiry));
      }
    }
  }
}
