import { DEFAULT_HANDLING, Input, type InputId } from "@42tris/core";
import type { ClientCommand, RoomOptions, ServerMessage } from "@42tris/protocol";
import { Rooms, type Peer, type Room } from "../server/src/rooms";
import { Session, type SessionOptions, type Transport } from "./src/session";
import { SessionDiagnostics } from "./src/session-diagnostics";

/**
 * Deterministic in-process netplay harness.
 *
 * Uses the real Rooms/Match authority and the real web Session, with a fake
 * clock and a tiny ordered transport. It is not a network simulator: it models
 * independent upstream/downstream delays, seeded jitter, ordered bursts,
 * browser-like stalls (timers, frames, inbound messages and input handling all
 * pause), and downstream-only holds. No real sockets and no real sleeping.
 */
export type ClientKey = "a" | "b";

export interface LinkProfile {
  /** One-way client -> server delay in milliseconds. */
  up?: number;
  /** One-way server -> client delay in milliseconds. */
  down?: number;
  /** Symmetric per-message jitter; seeded and deterministic. */
  jitter?: number;
}

export interface NetHarnessOptions {
  seed?: number;
  diagnostics?: boolean;
  a?: LinkProfile;
  b?: LinkProfile;
  connectMs?: number;
  frameMs?: number;
  serverTickMs?: number;
  snapshotMs?: number;
  /** Dispatch a stalled physical input before timers and animation frames. */
  inputFirst?: boolean;
}

type Callbacks = Parameters<SessionOptions["connect"]>[0];
type Kind = "server" | "snapshot" | "message" | "timer" | "frame" | "action";
interface Scheduled {
  at: number;
  priority: number;
  order: number;
  kind: Kind;
  client?: ClientKey;
  run(): void;
}

const FRAME_MS = 1000 / 60;
const PRIORITY = { server: 0, snapshot: 1, message: 2, timer: 3, frame: 4, action: 5 } as const;
const EPSILON = 1e-9;

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
  keysCleared = 0;

  constructor(private readonly net: NetHarness, readonly key: ClientKey, diagnostics: boolean) {
    this.diagnostics = diagnostics ? new SessionDiagnostics() : undefined;
    const values = new Map<string, string>();
    const store = {
      getItem: (name: string) => values.get(name) ?? null,
      setItem: (name: string, value: string) => { values.set(name, value); },
      removeItem: (name: string) => { values.delete(name); },
    };
    this.session = new Session({
      now: () => net.time,
      storage: store,
      profile: store,
      clearKeys: () => { this.keysCleared++; },
      diagnostics: this.diagnostics,
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
  private now = 0;
  private events: Scheduled[] = [];
  private order = 0;
  private readonly random: () => number;
  private readonly profiles: Record<ClientKey, Required<LinkProfile>>;
  private readonly stallUntil: Record<ClientKey, number> = { a: 0, b: 0 };
  private readonly downHoldUntil: Record<ClientKey, number> = { a: 0, b: 0 };
  private readonly closedPeers = new Set<string>();
  private readonly upNext: Record<ClientKey, number> = { a: 0, b: 0 };
  private readonly downNext: Record<ClientKey, number> = { a: 0, b: 0 };
  private readonly connectMs: number;
  private readonly frameMs: number;
  private readonly inputPriority: number;

  constructor(options: NetHarnessOptions = {}) {
    this.random = seeded(options.seed ?? 1);
    this.profiles = {
      a: { up: 10, down: 10, jitter: 0, ...options.a },
      b: { up: 10, down: 10, jitter: 0, ...options.b },
    };
    this.connectMs = options.connectMs ?? 5;
    this.frameMs = options.frameMs ?? FRAME_MS;
    this.inputPriority = options.inputFirst ? PRIORITY.message + 0.5 : PRIORITY.action;
    this.rooms = new Rooms(() => this.now);
    this.a = new HarnessClient(this, "a", !!options.diagnostics);
    this.b = new HarnessClient(this, "b", !!options.diagnostics);
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
    for (const key of ["a", "b"] as const) {
      const client = this[key];
      const frame = () => {
        client.diagnostics?.frame(this.now);
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
    this.profiles[key] = { ...this.profiles[key], ...profile };
  }

  /** Browser stall: no frames, timers, inbound messages, or input handling until it ends. */
  stall(key: ClientKey, durationMs: number): void {
    this.stallUntil[key] = Math.max(this.stallUntil[key], this.now + durationMs);
  }

  /** Hold only downstream deliveries; the client keeps rendering and ticking. */
  holdDownstream(key: ClientKey, durationMs: number): void {
    this.downHoldUntil[key] = Math.max(this.downHoldUntil[key], this.now + durationMs);
  }

  /** Queue an input now, or at stall end when the browser cannot run its handler. */
  press(key: ClientKey, input: InputId): void {
    if (this.now < this.stallUntil[key]) {
      this.schedule(this.stallUntil[key], this.inputPriority, "action", key, () => this[key].session.input(input));
      return;
    }
    this[key].session.input(input);
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
      this.now = Math.max(this.now, bestAt);
      best.run();
    }
    this.now = end;
  }

  runUntil(predicate: () => boolean, limit = 5000): void {
    const end = this.now + limit;
    while (!predicate() && this.now < end) this.advance(Math.min(5, end - this.now));
    if (!predicate()) throw new Error(`NetHarness timed out at ${this.now.toFixed(1)}ms`);
  }

  startMatch(options: Partial<RoomOptions> = {}): void {
    this.runUntil(() => this.a.session.connected && this.b.session.connected, 2000);
    const roomOptions: RoomOptions = {
      firstTo: 7, maxPlayers: 4, mode: "competitive", attacksEnabled: true, width: 10, ...options,
    };
    this.a.session.send({ type: "create", requestId: "harness", options: roomOptions });
    this.runUntil(() => !!this.a.session.room, 2000);
    const code = this.a.session.room!.code;
    this.b.session.send({ type: "join", code });
    this.runUntil(() => this.b.session.room?.code === code, 2000);
    for (const client of [this.a, this.b]) {
      client.session.send({ type: "ready", ready: true, handling: DEFAULT_HANDLING });
    }
    this.runUntil(() => this.a.session.canPlay && this.b.session.canPlay, 8000);
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
      at: this.now + delay, priority: PRIORITY.timer, order: ++this.order, kind: "timer", client: key,
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
    const peer: Peer = {
      id,
      send: message => this.deliver(client.key, () => {
        client.messages.push(message);
        callbacks.message(message);
      }),
      close: () => {
        this.closedPeers.add(id);
        this.schedule(this.now, PRIORITY.server, "server", undefined, () => this.rooms.disconnect(id));
        this.deliver(client.key, () => callbacks.close());
      },
    };
    client.peer = peer;
    this.rooms.connect(peer);
    this.schedule(this.now + this.connectMs, PRIORITY.message, "server", undefined, () => {
      if (client.peer === peer) callbacks.open();
    });
    let open = true;
    return {
      send: command => {
        if (!open) return;
        client.commands.push(command);
        if (command.type === "inputBatch") client.batches.push(command);
        this.sendCommand(client.key, peer, command);
      },
      close: () => {
        if (!open) return;
        open = false;
        this.closedPeers.add(id);
        const delay = this.jittered(client.key, "up");
        this.schedule(this.now + delay, PRIORITY.message, "server", undefined, () => {
          this.rooms.disconnect(peer.id);
        });
        callbacks.close();
      },
    };
  }

  private sendCommand(key: ClientKey, peer: Peer, command: ClientCommand): void {
    // WebSocket streams preserve order; jitter only changes spacing.
    const at = Math.max(this.now + this.jittered(key, "up"), this.upNext[key]);
    this.upNext[key] = at;
    this.schedule(at, PRIORITY.message, "message", undefined, () => {
      if (!this.closedPeers.has(peer.id)) this.rooms.receive(peer.id, command);
    });
  }

  private deliver(key: ClientKey, run: () => void): void {
    const schedule = (at: number) => {
      this.schedule(at, PRIORITY.message, "message", key, () => {
        if (this.now < this.downHoldUntil[key]) { schedule(this.downHoldUntil[key]); return; }
        run();
      });
    };
    const at = Math.max(this.now + this.jittered(key, "down"), this.downNext[key]);
    this.downNext[key] = at;
    schedule(at);
  }

  private jittered(key: ClientKey, direction: "up" | "down"): number {
    const profile = this.profiles[key];
    const offset = (this.random() * 2 - 1) * profile.jitter;
    return Math.max(0, profile[direction] + offset);
  }

  private effectiveAt(event: Scheduled): number {
    if (!event.client) return event.at;
    return event.at < this.stallUntil[event.client] ? this.stallUntil[event.client] : event.at;
  }

  private schedule(at: number, priority: number, kind: Kind, client: ClientKey | undefined, run: () => void): void {
    this.events.push({ at, priority, order: ++this.order, kind, client, run });
  }
}
