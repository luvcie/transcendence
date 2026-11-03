# Appendix A — Experiment harness and reproduction

> These are the exact scripts behind every **[measured]**/**[modelled]** number in
> [03](03-LATENCY-AND-FAILURE-ANALYSIS.md). They ran on a **scratchpad copy** of commit
> `fe92d946d2ad57dd14a39308e54154c3e39a79fa` and again on `a4a9e8e95fff86ab43e081220c8bac36de1a55f7` (N1-B), 2026-11-03, with Bun 1.4.2 on an AMD Ryzen 7
> 9800X3D. **None of this is part of the repository's tracked source.** Milestone N2-A
> ([06](06-IMPLEMENTATION-ROADMAP.md#n2-a--diagnostics-for-the-singaporeantideploy-question))
> describes how to upstream the harness properly as tests.

## A.1 Reproduce

```sh
# 1. Snapshot the commit outside the working tree.
mkdir -p /tmp/42tris-exp && git -C <repo> archive fe92d94 | tar -x -C /tmp/42tris-exp
cd /tmp/42tris-exp && bun install --frozen-lockfile
# 2. Apply the three experiment knobs (A.2) — defaults keep production behaviour.
# 3. Copy the files from A.3–A.6 into packages/web/exp/
cd packages/web
bun run exp/sweep.ts rtt rttJitter bursty asym stall interrupt mixed variants bandwidth > results.jsonl
bun run exp/spikes.ts  > spikes.jsonl
bun run exp/table.ts results.jsonl           # markdown table
bun run exp/trace.ts                          # stall/outage timelines
bun run exp/size.ts                           # checkpoint composition + CPU microbenchmarks
bun run exp/replaysize.ts                     # replay JSON / gzip sizes
bun run exp/parse.ts                          # client JSON.parse cost of a saturated checkpoint
```

All runs are deterministic for a given seed (fake clock; seeded LCG). CPU timings use the real
`performance.now()` and vary by machine.

## A.2 Experiment knobs (scratchpad copy only)

```diff
--- a/packages/server/src/rooms.ts	2026-11-03 17:22:28.550444920 +0000
+++ b/packages/server/src/rooms.ts	2026-11-03 16:53:07.427709793 +0000
@@ -360,7 +360,7 @@
       seat.nextSeq++;
       seat.history.set(item.seq, fingerprint);
       if (seat.history.size > 256) seat.history.delete(seat.history.keys().next().value!);
-      let rejected = item.frame < match.frame || item.frame > Math.floor(this.simulationNow(room) / FRAME_MS) + 2 || seat.pending.size >= 128;
+      let rejected = item.frame < match.frame || item.frame > Math.floor(this.simulationNow(room) / FRAME_MS) + ((this as any).futureFrames ?? 2) || seat.pending.size >= 128;
       if (!rejected) {
         const order = room.order++;
         try {
@@ -531,7 +531,7 @@
         this.changed(room);
       }
       if (room.phase === "playing" && room.match) {
-        const target = Math.max(room.match.frame, Math.floor(Math.max(0, this.simulationNow(room) - 100) / FRAME_MS));
+        const target = Math.max(room.match.frame, Math.floor(Math.max(0, this.simulationNow(room) - ((this as any).commitDelay ?? 100)) / FRAME_MS));
         if (room.recorder) room.recorder.advanceToFrame(target);
         else room.match.advanceToFrame(target);
         for (const s of room.seats) for (const [seq, input] of s.pending) if (input.frame < room.match.frame) s.pending.delete(seq);
--- a/packages/web/src/session.ts	2026-11-03 17:22:28.551735355 +0000
+++ b/packages/web/src/session.ts	2026-11-03 16:53:07.429736313 +0000
@@ -213,7 +213,7 @@
     const cp = this.checkpoint!;
     const elapsed = cp.clock.frozen || this.room?.phase !== "playing" ? 0 : Math.max(0, this.serverNow() - cp.serverNow);
     return Math.max(this.prediction?.atMs ?? 0, cp.state!.frame * FRAME_MS,
-      Math.min(cp.clock.simulationNow + elapsed, cp.state!.frame * FRAME_MS + 2000));
+      Math.min(cp.clock.simulationNow + elapsed + ((this as any).lead ?? 0), cp.state!.frame * FRAME_MS + 2000));
   }
   input(input: InputId) {
     if (!this.canPlay) return;
```

With `commitDelay`, `futureFrames` and `lead` unset, behaviour is byte-for-byte production.

## A.3 `exp/nharness.ts` — N-player fake-time harness

```ts
// Temporary experiment harness (scratchpad only, never committed).
// Generalises packages/web/netplay-harness.ts to N clients, adds upstream holds,
// a modelled WebSocket heartbeat, bursty latency spikes, a scripted human-like
// input bot and measurement hooks. Uses the real Rooms/Match authority and the
// real web Session with a fake clock.
import { DEFAULT_HANDLING, FRAME_MS, Input, type InputId } from "@42tris/core";
import type { ClientCommand, RoomOptions, ServerMessage } from "@42tris/protocol";
import { Rooms, type Peer, type Room } from "../../server/src/rooms";
import { Session, type SessionOptions, type Transport } from "../src/session";
import { SessionDiagnostics } from "../src/session-diagnostics";

export interface Link { up: number; down: number; jitter?: number; spikeChance?: number; spikeMs?: number; downKBps?: number; kernelBufKB?: number }
type Callbacks = Parameters<SessionOptions["connect"]>[0];
interface Ev { at: number; pri: number; order: number; client?: number; run(): void }
const PRI = { server: 0, snapshot: 1, message: 2, timer: 3, frame: 4, action: 5 } as const;

function seeded(seed: number) {
  let v = seed >>> 0;
  return () => { v = (Math.imul(v, 1664525) + 1013904223) >>> 0; return v / 0x1_0000_0000; };
}
export const pct = (xs: number[], p: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))];
};

export class Client {
  session: Session;
  diag = new SessionDiagnostics();
  peer?: Peer;
  connections = 0;
  pressed = new Set<number>();
  clears = 0;
  // metrics
  attempts = 0; ignored = 0; blockedMs = 0; playingMs = 0;
  downBytes = 0; upBytes = 0; downMsgs = 0;
  cpAge: number[] = []; oppLag: number[] = []; oppStates = new Map<string, Set<number>>();
  lastCp = -1;
  lead = 0;
  constructor(readonly net: NetN, readonly index: number) {
    const values = new Map<string, string>();
    const store = { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => { values.set(k, v); }, removeItem: (k: string) => { values.delete(k); } };
    this.session = new Session({
      now: () => net.time, storage: store, profile: store,
      clearKeys: () => { this.pressed.clear(); this.clears++; },
      diagnostics: this.diag,
      schedule: (cb, delay) => net.timer(index, cb, delay),
      connect: cb => net.connect(this, cb),
    });
    this.session.start();
  }
}

export class NetN {
  rooms: Rooms;
  clients: Client[] = [];
  now = 0;
  private evs: Ev[] = [];
  private order = 0;
  rand: () => number;
  stallUntil: number[] = [];
  upHold: number[] = [];
  downHold: number[] = [];
  upNext: number[] = [];
  downNext: number[] = [];
  lastPong: number[] = [];
  closed = new Set<string>();
  // server-side admission observations
  admissions: { client: number; lagMs: number; marginMs: number; accepted: boolean; late: boolean; future: boolean; queuedToServerMs: number }[] = [];
  queuedAt = new Map<string, number>();
  cpu = { tick: 0, snapshots: 0, receive: 0, stringify: 0 };
  constructor(readonly links: Link[], opts: { seed?: number; commitDelay?: number; futureFrames?: number; leads?: number[]; heartbeat?: boolean } = {}) {
    this.rand = seeded(opts.seed ?? 1);
    this.rooms = new Rooms(() => this.now);
    if (opts.commitDelay !== undefined) (this.rooms as any).commitDelay = opts.commitDelay;
    if (opts.futureFrames !== undefined) (this.rooms as any).futureFrames = opts.futureFrames;
    for (let i = 0; i < links.length; i++) {
      this.stallUntil.push(0); this.upHold.push(0); this.downHold.push(0); this.upNext.push(0); this.downNext.push(0); this.lastPong.push(0);
    }
    for (let i = 0; i < links.length; i++) {
      const c = new Client(this, i);
      c.lead = opts.leads?.[i] ?? 0;
      (c.session as any).lead = c.lead;
      this.clients.push(c);
    }
    const tick = () => { const t = performance.now(); this.rooms.tick(); this.cpu.tick += performance.now() - t; this.at(this.now + 10, PRI.server, undefined, tick); };
    const snap = () => { const t = performance.now(); this.rooms.snapshots(); this.cpu.snapshots += performance.now() - t; this.at(this.now + 50, PRI.snapshot, undefined, snap); };
    this.at(0, PRI.server, undefined, tick);
    this.at(0, PRI.snapshot, undefined, snap);
    this.clients.forEach((c, i) => {
      const frame = () => { c.diag.frame(this.now); c.session.tick(); this.observe(c); this.at(this.now + FRAME_MS, PRI.frame, i, frame); };
      this.at(FRAME_MS, PRI.frame, i, frame);
    });
    if (opts.heartbeat !== false) {
      // app.ts: native ping every 2 s, lease closed after 6 s without pong (checked every 250 ms).
      const beat = () => {
        this.clients.forEach((c, i) => {
          const peer = c.peer;
          if (!peer || this.closed.has(peer.id)) return;
          if (this.now - this.lastPong[i] >= 6000) { this.closed.add(peer.id); this.rooms.disconnect(peer.id); this.deliver(i, () => (peer as any).onClose?.()); return; }
          if (Math.round(this.now) % 2000 < 250) this.deliver(i, () => this.sendUp(i, () => { this.lastPong[i] = this.now; }), 0, true); // browsers answer WebSocket pings outside page JS
        });
        this.at(this.now + 250, PRI.server, undefined, beat);
      };
      this.at(250, PRI.server, undefined, beat);
    }
  }
  get time() { return this.now; }
  get room(): Room | undefined { return [...this.rooms.rooms.values()][0]; }
  simNow(): number { const r = this.room; return r ? (this.rooms as any).simulationNow(r) : 0; }

  private observe(c: Client) {
    const r = this.room;
    const s = c.session;
    if (!r || r.phase !== "playing") return;
    const me = s.playerId;
    const owner = r.match?.roster.includes(me) && !r.match.activePlayers.includes(me);
    if (owner) return;
    const ownState = r.match?.playerState(me);
    if (ownState?.state.topOut) return;
    c.playingMs += FRAME_MS;
    if (!s.canPlay) c.blockedMs += FRAME_MS;
    const cp = s.checkpoint;
    if (cp?.state && cp.room.phase === "playing" && cp.state.round === r.match!.round) {
      const lag = this.simNow() - cp.state.frame * FRAME_MS;
      c.oppLag.push(lag);
      for (const id of cp.state.roster) if (id !== me) {
        let set = c.oppStates.get(id); if (!set) c.oppStates.set(id, set = new Set());
        set.add(cp.state.round * 1e7 + cp.state.frame);
      }
    }
  }

  setLink(i: number, l: Partial<Link>) { this.links[i] = { ...this.links[i], ...l }; }
  stall(i: number, ms: number) { this.stallUntil[i] = Math.max(this.stallUntil[i], this.now + ms); }
  interrupt(i: number, ms: number) { this.upHold[i] = Math.max(this.upHold[i], this.now + ms); this.downHold[i] = Math.max(this.downHold[i], this.now + ms); }

  press(i: number, input: InputId) {
    const c = this.clients[i];
    const run = () => {
      c.attempts++;
      if (!c.session.canPlay) { c.ignored++; return; }
      const before = c.diag.snapshot().inputs.queued;
      c.session.input(input);
      if (c.diag.snapshot().inputs.queued === before) c.ignored++;
    };
    if (this.now < this.stallUntil[i]) this.at(this.stallUntil[i], PRI.action, i, run); else run();
  }

  advance(ms: number) {
    const end = this.now + ms;
    for (;;) {
      let best: Ev | null = null, bestAt = Infinity;
      for (const e of this.evs) {
        const at = e.client !== undefined && e.at < this.stallUntil[e.client] ? this.stallUntil[e.client] : e.at;
        if (at > end + 1e-9) continue;
        if (!best || at < bestAt - 1e-9 || Math.abs(at - bestAt) <= 1e-9 && (e.pri < best.pri || e.pri === best.pri && e.order < best.order)) { best = e; bestAt = at; }
      }
      if (!best) break;
      this.evs.splice(this.evs.indexOf(best), 1);
      this.now = Math.max(this.now, bestAt);
      best.run();
    }
    this.now = end;
  }
  runUntil(pred: () => boolean, limit = 10_000) {
    const end = this.now + limit;
    while (!pred() && this.now < end) this.advance(Math.min(5, end - this.now));
    if (!pred()) throw new Error(`timeout at ${this.now}`);
  }

  startMatch(options: Partial<RoomOptions> = {}) {
    this.runUntil(() => this.clients.every(c => c.session.connected), 5000);
    const ro: RoomOptions = { firstTo: 100, maxPlayers: 8, mode: "competitive", attacksEnabled: true, width: 10, ...options };
    this.clients[0].session.send({ type: "create", requestId: "exp", options: ro });
    this.runUntil(() => !!this.clients[0].session.room, 5000);
    const code = this.clients[0].session.room!.code;
    for (const c of this.clients.slice(1)) c.session.send({ type: "join", code });
    this.runUntil(() => this.clients.every(c => c.session.room?.code === code), 5000);
    for (const c of this.clients) c.session.send({ type: "ready", ready: true, handling: DEFAULT_HANDLING });
    this.runUntil(() => this.clients.every(c => c.session.canPlay), 15000);
  }

  timer(i: number, cb: () => void, delay: number) {
    const e: Ev = { at: this.now + delay, pri: PRI.timer, order: ++this.order, client: i, run: cb };
    this.evs.push(e);
    return () => { const k = this.evs.indexOf(e); if (k >= 0) this.evs.splice(k, 1); };
  }
  at(at: number, pri: number, client: number | undefined, run: () => void) { this.evs.push({ at, pri, order: ++this.order, client, run }); }

  private jit(i: number, dir: "up" | "down") {
    const l = this.links[i];
    let d = l[dir] + (this.rand() * 2 - 1) * (l.jitter ?? 0);
    if (l.spikeChance && this.rand() < l.spikeChance) d += l.spikeMs ?? 0;
    return Math.max(0, d);
  }
  sendUp(i: number, run: () => void) {
    // TCP: ordered; a held path delivers everything after the hold ends.
    const at = Math.max(this.now + this.jit(i, "up"), this.upNext[i], this.upHold[i] > this.now ? this.upHold[i] + this.jit(i, "up") : 0);
    this.upNext[i] = at;
    this.at(at, PRI.message, undefined, run);
  }
  downFree: number[] = [];
  skipped: number[] = [];
  /** Bytes not yet serialised onto the modelled downlink, minus what a kernel buffer would hide. */
  backlog(i: number): number {
    const l = this.links[i];
    if (!l.downKBps) return 0;
    const queued = Math.max(0, (this.downFree[i] ?? 0) - this.now) * l.downKBps * 1024 / 1000;
    return Math.max(0, queued - (l.kernelBufKB ?? 0) * 1024);
  }
  deliver(i: number, run: () => void, bytes = 0, network = false) {
    const l = this.links[i];
    let txEnd = this.now;
    if (l.downKBps) {
      const start = Math.max(this.now, this.downFree[i] ?? 0, this.downHold[i] > this.now ? this.downHold[i] : 0);
      txEnd = start + bytes / (l.downKBps * 1024) * 1000;
      this.downFree[i] = txEnd;
    }
    const at = Math.max(txEnd - this.now + this.now + this.jit(i, "down"), this.now + this.jit(i, "down"), this.downNext[i], this.downHold[i] > this.now ? this.downHold[i] + this.jit(i, "down") : 0);
    this.downNext[i] = at;
    this.at(at, PRI.message, network ? undefined : i, run);
  }

  connect(c: Client, cb: Callbacks): Transport {
    const i = c.index;
    const id = `${i}:${++c.connections}`;
    const peer: Peer & { onClose?: () => void } = {
      id,
      send: (message: ServerMessage, ephemeral = false) => {
        // app.ts: ephemeral checkpoints are skipped while > 64 KiB is buffered.
        if (ephemeral && this.backlog(i) > 64 * 1024) { this.skipped[i] = (this.skipped[i] ?? 0) + 1; return; }
        const t = performance.now(); const bytes = JSON.stringify(message).length; this.cpu.stringify += performance.now() - t;
        this.deliver(i, () => { if (this.closed.has(id) && message.type !== "error") return; c.downBytes += bytes; c.downMsgs++; c.cpAge.push(message.type === "checkpoint" ? this.now - (message as any).serverNow : NaN); cb.message(message); }, bytes);
      },
      close: () => { this.closed.add(id); this.at(this.now, PRI.server, undefined, () => this.rooms.disconnect(id)); this.deliver(i, () => cb.close()); },
    };
    peer.onClose = () => cb.close();
    c.peer = peer;
    this.lastPong[i] = this.now;
    this.rooms.connect(peer);
    this.at(this.now + 5, PRI.message, undefined, () => { if (c.peer === peer) cb.open(); });
    let open = true;
    return {
      send: (command: ClientCommand) => {
        if (!open) return;
        c.upBytes += JSON.stringify(command).length;
        if (command.type === "inputBatch") for (const it of command.items) this.queuedAt.set(`${i}:${command.generation}:${it.seq}`, this.now);
        this.sendUp(i, () => {
          if (this.closed.has(peer.id)) return;
          if (command.type === "inputBatch") this.admit(i, peer.id, command);
          else { const t = performance.now(); this.rooms.receive(peer.id, command); this.cpu.receive += performance.now() - t; }
        });
      },
      close: () => {
        if (!open) return; open = false; this.closed.add(id);
        this.sendUp(i, () => this.rooms.disconnect(peer.id));
        cb.close();
      },
    };
  }

  private admit(i: number, peerId: string, command: Extract<ClientCommand, { type: "inputBatch" }>) {
    const room = this.room;
    const match = room?.match;
    const seat = room?.seats.find(s => s.peer?.id === peerId) as any;
    const sim = this.simNow();
    const committed = (match?.frame ?? 0) * FRAME_MS;
    const futureLimit = Math.floor(sim / FRAME_MS) + ((this.rooms as any).futureFrames ?? 2);
    const pre = command.items.map(it => ({ it, stamp: (it.frame + it.subframe) * FRAME_MS }));
    const t = performance.now();
    this.rooms.receive(peerId, command);
    this.cpu.receive += performance.now() - t;
    if (!seat || !match || room!.phase !== "playing" || command.generation !== seat.generation) return;
    for (const { it, stamp } of pre) {
      const accepted = seat.pending.has(it.seq);
      const queued = this.queuedAt.get(`${i}:${command.generation}:${it.seq}`);
      this.admissions.push({ client: i, lagMs: sim - stamp, marginMs: stamp - committed, accepted,
        late: it.frame < match.frame, future: it.frame > futureLimit, queuedToServerMs: queued === undefined ? NaN : this.now - queued });
    }
  }
}

/** Scripted human-like player: bursts of taps/DAS/rotations then a hard drop. */
export function botPlayer(net: NetN, i: number, seed: number, pps = 1.6) {
  const r = seeded(seed);
  const cycle = () => {
    const c = net.clients[i];
    let t = 0;
    const plan: [number, InputId][] = [];
    const dir = r() < 0.5 ? [Input.LeftDown, Input.LeftUp] as const : [Input.RightDown, Input.RightUp] as const;
    if (r() < 0.3) plan.push([t, r() < 0.5 ? Input.RotateCw : Input.RotateCcw]), t += 10 + r() * 40; // rotate first, sometimes <34 ms before move
    if (r() < 0.85) {
      plan.push([t, dir[0]]);
      t += r() < 0.35 ? 140 + r() * 120 : 25 + r() * 50; // DAS hold or tap
      plan.push([t, dir[1]]);
      t += 5 + r() * 45;
    }
    if (r() < 0.25) plan.push([t, Input.Rotate180]), t += 15 + r() * 30;
    if (r() < 0.15) plan.push([t, Input.SoftDropDown]), t += 60 + r() * 80, plan.push([t, Input.SoftDropUp]), t += 10;
    if (r() < 0.08) plan.push([t, Input.Hold]), t += 20 + r() * 40;
    plan.push([t, Input.HardDrop]);
    const start = net.now;
    for (const [dt, input] of plan) {
      net.at(start + dt, PRI.action, i, () => {
        const ups: number[] = [Input.LeftUp, Input.RightUp, Input.SoftDropUp];
        const downOf: Record<number, number> = { [Input.LeftUp]: Input.LeftDown, [Input.RightUp]: Input.RightDown, [Input.SoftDropUp]: Input.SoftDropDown };
        if (ups.includes(input)) {
          if (!c.pressed.has(downOf[input])) return; // key state was cleared by a release: the real UI sends nothing
          c.pressed.delete(downOf[input]);
          if (!c.session.canPlay) { c.session.release("user"); return; } // mirrors lateRelease in main.ts
        } else if (downOf[Input.LeftUp] === input || downOf[Input.RightUp] === input || downOf[Input.SoftDropUp] === input) {
          if (!c.session.canPlay) { c.attempts++; c.ignored++; return; }
          c.pressed.add(input);
        }
        net.press(i, input);
      });
    }
    const gap = 1000 / pps;
    net.at(start + Math.max(t + 30, gap * (0.6 + r() * 0.8)), PRI.action, i, cycle);
  };
  net.at(net.now + r() * 300, PRI.action, i, cycle);
}

export function summarize(net: NetN, simMs: number) {
  return net.clients.map((c, i) => {
    const d = c.diag.snapshot();
    const adm = net.admissions.filter(a => a.client === i);
    const acc = adm.filter(a => a.accepted);
    const lag = adm.map(a => a.lagMs);
    return {
      client: i, link: net.links[i], lead: c.lead,
      attempts: c.attempts, ignored: c.ignored, queued: d.inputs.queued, sent: d.inputs.sent,
      admitted: adm.length, accepted: acc.length, late: adm.filter(a => a.late).length, future: adm.filter(a => a.future).length,
      rejections: d.rejections.byCode, releases: d.releases.byReason, releaseTotal: d.releases.total,
      corrections: { total: d.corrections.total, piece: d.corrections.piece, board: d.corrections.board, garbage: d.corrections.garbage, controls: d.corrections.controls },
      blockedPct: c.playingMs ? 100 * c.blockedMs / c.playingMs : 0,
      stampLagP50: pct(lag, 0.5), stampLagP95: pct(lag, 0.95), stampLagMax: Math.max(...lag),
      queueToServerP50: pct(acc.map(a => a.queuedToServerMs), 0.5), queueToServerP95: pct(acc.map(a => a.queuedToServerMs), 0.95),
      oppLagP50: pct(c.oppLag, 0.5), oppLagP95: pct(c.oppLag, 0.95),
      oppUpdatesPerSec: c.oppStates.size ? [...c.oppStates.values()].reduce((n, s) => n + s.size, 0) / c.oppStates.size / (c.playingMs / 1000) : 0,
      downKBps: c.downBytes / 1024 / (simMs / 1000), upKBps: c.upBytes / 1024 / (simMs / 1000), downMsgsPerSec: c.downMsgs / (simMs / 1000),
      cpAgeP50: pct(c.cpAge.filter(x => !isNaN(x)), 0.5), cpAgeP95: pct(c.cpAge.filter(x => !isNaN(x)), 0.95), cpAgeMax: Math.max(...c.cpAge.filter(x => !isNaN(x))), skippedCheckpoints: net.skipped[i] ?? 0,
      rtt: d.rtt,
    };
  });
}
```

## A.4 `exp/run.ts` — one scenario + replay verification

```ts
import { verifyMatchReplayExecution } from "@42tris/replay";
import { botPlayer, NetN, summarize, type Link } from "./nharness";

export interface Scenario {
  name: string;
  links: Link[];
  seconds?: number;
  commitDelay?: number;
  futureFrames?: number;
  leads?: number[];
  events?: (net: NetN) => void; // scheduled disturbances
  seed?: number;
  verifyReplay?: boolean;
}

export async function run(s: Scenario) {
  const net = new NetN(s.links.map(l => ({ ...l })), { seed: s.seed ?? 11, commitDelay: s.commitDelay, futureFrames: s.futureFrames, leads: s.leads });
  net.startMatch();
  const t0 = net.now;
  net.clients.forEach((_, i) => botPlayer(net, i, 1000 + i * 77 + (s.seed ?? 0)));
  const cpu0 = { ...net.cpu };
  s.events?.(net);
  const ms = (s.seconds ?? 30) * 1000;
  net.advance(ms);
  const rows = summarize(net, ms);
  const room = net.room!;
  let replay = "n/a";
  if (s.verifyReplay !== false && room.recorder) {
    try {
      const r = await room.recorder.buildIncompleteReplay();
      if (!r) replay = "no-prefix";
      else { const v = await verifyMatchReplayExecution(r); replay = `verified prefix: rounds=${r.summary.rounds.length} ops=${r.records.length} complete=${v.complete}`; }
    } catch (e) { replay = `FAILED ${(e as Error).message}`; }
  }
  const cpu = { tick: net.cpu.tick - cpu0.tick, snapshots: net.cpu.snapshots - cpu0.snapshots, receive: net.cpu.receive - cpu0.receive, stringify: net.cpu.stringify - cpu0.stringify };
  return { name: s.name, simSeconds: ms / 1000, startedAt: t0, rounds: room.match?.round, rows, replay, serverCpuMsPerSimSec: Object.fromEntries(Object.entries(cpu).map(([k, v]) => [k, +(v / (ms / 1000)).toFixed(3)])) };
}

if (import.meta.main) {
  const r = await run({ name: "smoke", links: [{ up: 10, down: 10 }, { up: 10, down: 10 }], seconds: 10 });
  console.log(JSON.stringify(r, null, 1));
}
```

## A.5 `exp/sweep.ts` — scenario groups

```ts
import { FRAME_MS } from "@42tris/core";
import { run, type Scenario } from "./run";
import type { Link } from "./nharness";

const sym = (rtt: number, extra: Partial<Link> = {}): Link => ({ up: rtt / 2, down: rtt / 2, ...extra });
const two = (l: Link): Link[] => [l, { ...l }];
const leadFor = (rtt: number, jitter = 0) => Math.max(0, Math.ceil(rtt / 2 + 34 + 2 * jitter + 20 - 100));
const futureFor = (lead: number) => Math.ceil(lead / FRAME_MS) + 2;

const groups: Record<string, Scenario[]> = {
  rtt: [10, 40, 60, 100, 120, 140, 160, 180, 200, 220, 250, 300, 350, 400, 600].map(rtt => ({ name: `2p sym RTT ${rtt}`, links: two(sym(rtt)) })),
  rttJitter: [40, 100, 160, 200, 250, 300].map(rtt => ({ name: `2p sym RTT ${rtt} ±15ms jitter`, links: two(sym(rtt, { jitter: 15 })) })),
  bursty: [
    { name: "2p RTT 60, 5% +150ms spikes", links: two(sym(60, { jitter: 5, spikeChance: 0.05, spikeMs: 150 })) },
    { name: "2p RTT 160, 5% +150ms spikes", links: two(sym(160, { jitter: 5, spikeChance: 0.05, spikeMs: 150 })) },
  ],
  asym: [
    { name: "2p up 20 / down 180", links: two({ up: 20, down: 180 }) },
    { name: "2p up 180 / down 20", links: two({ up: 180, down: 20 }) },
    { name: "2p up 60 / down 140", links: two({ up: 60, down: 140 }) },
  ],
  stall: [300, 1000, 3000].map(ms => ({ name: `2p RTT 40, browser stall ${ms} ms on client 0 at t+10s`, links: two(sym(40)),
    events: net => net.at(net.now + 10_000, 0, undefined, () => net.stall(0, ms)) })),
  interrupt: [
    { name: "2p RTT 40, 6 s network interruption (both directions) on client 0 at t+10s", links: two(sym(40)), seconds: 40,
      events: net => net.at(net.now + 10_000, 0, undefined, () => net.interrupt(0, 6000)) },
    { name: "2p RTT 40, 3 s network interruption on client 0 at t+10s", links: two(sym(40)), seconds: 30,
      events: net => net.at(net.now + 10_000, 0, undefined, () => net.interrupt(0, 3000)) },
  ],
  bandwidth: ([[40, 0], [40, 2000], [200, 0], [200, 2000], [200, 500], [200, 250], [200, 120]] as const).flatMap(([rtt, cap]) => [0, 1024].map(kb => ({
    name: `2p RTT ${rtt}, downlink ${cap || "∞"} KB/s, kernel buffer ${kb} KB`, seconds: 60, links: two(sym(rtt, cap ? { downKBps: cap, kernelBufKB: kb } : {})) }))).filter((s, i) => !(s.name.includes("∞") && s.name.includes("1024"))),
  mixed: [
    { name: "4p mixed RTT 20/60/180/300", links: [sym(20), sym(60), sym(180), sym(300)] },
    { name: "8p mixed RTT 10/20/40/60/100/150/200/300", links: [10, 20, 40, 60, 100, 150, 200, 300].map(r => sym(r)) },
    { name: "8p all RTT 40", links: Array.from({ length: 8 }, () => sym(40)) },
  ],
  variants: [
    { name: "2p RTT 300 baseline", links: two(sym(300)) },
    { name: "2p RTT 300 commitDelay 200", links: two(sym(300)), commitDelay: 200 },
    { name: "2p RTT 300 per-player lead", links: two(sym(300)), leads: [leadFor(300), leadFor(300)], futureFrames: futureFor(leadFor(300)) },
    { name: "2p RTT 200 ±15 baseline", links: two(sym(200, { jitter: 15 })) },
    { name: "2p RTT 200 ±15 per-player lead", links: two(sym(200, { jitter: 15 })), leads: [leadFor(200, 15), leadFor(200, 15)], futureFrames: futureFor(leadFor(200, 15)) },
    { name: "2p RTT 500 per-player lead", links: two(sym(500)), leads: [leadFor(500), leadFor(500)], futureFrames: futureFor(leadFor(500)) },
    { name: "4p mixed 20/60/180/300 per-player lead", links: [sym(20), sym(60), sym(180), sym(300)], leads: [20, 60, 180, 300].map(r => leadFor(r)), futureFrames: futureFor(leadFor(300)) },
    { name: "2p RTT 40 per-player lead (should be 0)", links: two(sym(40)), leads: [leadFor(40), leadFor(40)] },
  ],
};

const which = process.argv.slice(2);
for (const g of which.length ? which : Object.keys(groups)) {
  for (const s of groups[g]) {
    const r = await run(s);
    const compact = r.rows.map(x => ({
      c: x.client, rtt: x.link.up + x.link.down, lead: x.lead,
      acc: `${x.accepted}/${x.admitted}`, late: x.late, fut: x.future, ign: x.ignored,
      rel: x.releaseTotal, why: x.releases, rej: x.rejections,
      corr: x.corrections.total, corrBoard: x.corrections.board, corrGarb: x.corrections.garbage,
      blocked: +x.blockedPct.toFixed(1),
      lagP95: +x.stampLagP95.toFixed(0), lagMax: +x.stampLagMax.toFixed(0),
      q2sP50: +x.queueToServerP50.toFixed(0), q2sP95: +x.queueToServerP95.toFixed(0),
      oppP50: +x.oppLagP50.toFixed(0), oppP95: +x.oppLagP95.toFixed(0), oppHz: +x.oppUpdatesPerSec.toFixed(1),
      down: +x.downKBps.toFixed(0), up: +x.upKBps.toFixed(1),
      ageP50: +(x as any).cpAgeP50.toFixed(0), ageP95: +(x as any).cpAgeP95.toFixed(0), ageMax: +(x as any).cpAgeMax.toFixed(0), skip: (x as any).skippedCheckpoints,
      rttMin: x.rtt.min === null ? null : +x.rtt.min.toFixed(0), rttMax: x.rtt.max === null ? null : +x.rtt.max.toFixed(0),
    }));
    console.log(JSON.stringify({ group: g, name: r.name, secs: r.simSeconds, rounds: r.rounds, replay: r.replay, cpu: r.serverCpuMsPerSimSec, clients: compact }));
  }
}
```

## A.6 `exp/spikes.ts` — lead vs. bursty spikes

```ts
import { FRAME_MS } from "@42tris/core";
import { run } from "./run";
const link = (rtt: number) => ({ up: rtt / 2, down: rtt / 2, jitter: 5, spikeChance: 0.05, spikeMs: 150 });
for (const [rtt, lead] of [[60, 0], [60, 40], [60, 120], [160, 0], [160, 60], [160, 170]] as const) {
  const r = await run({ name: `2p RTT ${rtt} + 5% 150ms spikes, lead ${lead}`, links: [link(rtt), link(rtt)], leads: [lead, lead], futureFrames: Math.ceil(lead / FRAME_MS) + 2, seconds: 60 });
  console.log(JSON.stringify({ group: "spikes", name: r.name, secs: r.simSeconds, rounds: r.rounds, replay: r.replay, cpu: r.serverCpuMsPerSimSec, clients: r.rows.map(x => ({ c: x.client, rtt: x.link.up + x.link.down, lead: x.lead, acc: `${x.accepted}/${x.admitted}`, late: x.late, fut: x.future, ign: x.ignored, rel: x.releaseTotal, why: x.releases, rej: x.rejections, corr: x.corrections.total, blocked: +x.blockedPct.toFixed(1), lagP95: +x.stampLagP95.toFixed(0), oppP50: +x.oppLagP50.toFixed(0), oppP95: +x.oppLagP95.toFixed(0), down: +x.downKBps.toFixed(0), ageP50: +(x as any).cpAgeP50.toFixed(0), ageP95: +(x as any).cpAgeP95.toFixed(0), ageMax: +(x as any).cpAgeMax.toFixed(0), skip: (x as any).skippedCheckpoints })) }));
}
```

## A.7 `exp/trace.ts` — stall and outage timelines

```ts
import { Input } from "@42tris/core";
import { NetN } from "./nharness";

async function trace(name: string, setup: (net: NetN) => void, seconds = 16) {
  const net = new NetN([{ up: 20, down: 20 }, { up: 20, down: 20 }], { seed: 5 });
  net.startMatch();
  const t0 = net.now;
  const log: string[] = [];
  let lastPhase = net.room!.phase, lastConn = true, lastCan = true, lastGen = net.clients[0].session.checkpoint!.owner.generation;
  const me = net.clients[0].session.playerId;
  const watch = () => {
    const r = net.room!, s = net.clients[0].session;
    const gen = s.checkpoint?.owner.generation ?? -1;
    const st = r.match?.playerState(me);
    const parts = [];
    if (r.phase !== lastPhase) parts.push(`room ${lastPhase}→${r.phase}`), lastPhase = r.phase;
    if (s.connected !== lastConn) parts.push(`client0 connected=${s.connected}`), lastConn = s.connected;
    if (s.canPlay !== lastCan) parts.push(`client0 canPlay=${s.canPlay}`), lastCan = s.canPlay;
    if (gen !== lastGen) parts.push(`client0 generation ${lastGen}→${gen}`), lastGen = gen;
    if (parts.length) log.push(`t+${((net.now - t0) / 1000).toFixed(2)}s ${parts.join("; ")} | server board: leftHeld=${st?.state.leftHeld} pieces=${st?.state.dealt}`);
    net.at(net.now + 10, 6, undefined, watch);
  };
  watch();
  setup(net);
  net.advance(seconds * 1000);
  const d = net.clients[0].diag.snapshot();
  console.log(`\n### ${name}\n` + log.join("\n") + `\nreleases=${JSON.stringify(d.releases.byReason)} rejections=${JSON.stringify(d.rejections.byCode)} server pieces dealt to client0=${net.room!.match?.playerState(me).state.dealt}`);
}

await trace("3 s two-way interruption while holding Left (client keeps running)", net => {
  net.at(net.now + 1000, 5, 0, () => { net.press(0, Input.LeftDown); net.clients[0].pressed.add(Input.LeftDown); });
  net.at(net.now + 1100, 5, 0, () => net.interrupt(0, 3000));
  net.at(net.now + 1600, 5, 0, () => net.press(0, Input.LeftUp));
  net.at(net.now + 2000, 5, 0, () => net.press(0, Input.RotateCw));
  net.at(net.now + 3800, 5, 0, () => net.press(0, Input.HardDrop));
});
await trace("6 s two-way interruption while holding Left (client keeps running)", net => {
  net.at(net.now + 1000, 5, 0, () => { net.press(0, Input.LeftDown); });
  net.at(net.now + 1100, 5, 0, () => net.interrupt(0, 6000));
  net.at(net.now + 1600, 5, 0, () => net.press(0, Input.LeftUp));
  net.at(net.now + 2000, 5, 0, () => net.press(0, Input.HardDrop));
}, 20);
await trace("6 s browser freeze (no frames, no handlers, no inbound processing)", net => {
  net.at(net.now + 1000, 5, 0, () => { net.press(0, Input.LeftDown); });
  net.at(net.now + 1100, 5, 0, () => net.stall(0, 6000));
  net.at(net.now + 1600, 5, 0, () => net.press(0, Input.LeftUp)); // runs only when the stall ends
}, 20);
await trace("300 ms stall between a key press and its trailing flush", net => {
  net.at(net.now + 1000, 5, 0, () => net.press(0, Input.LeftDown));
  net.at(net.now + 1005, 5, 0, () => net.press(0, Input.LeftUp));
  net.at(net.now + 1006, 5, 0, () => net.stall(0, 300));
}, 4);
```

## A.8 `exp/size.ts` — checkpoint composition and CPU microbenchmarks

```ts
import { botPlayer, NetN } from "./nharness";
import type { ServerMessage } from "@42tris/protocol";
import { Match, OwnerPrediction } from "@42tris/match";

for (const n of [2, 4, 8]) {
  const net = new NetN(Array.from({ length: n }, () => ({ up: 15, down: 15 })), { seed: 3 });
  net.startMatch();
  net.clients.forEach((_, i) => botPlayer(net, i, 500 + i));
  // capture the next checkpoint delivered to client 0 after 20 s of play
  net.advance(20_000);
  const room = net.room!;
  const seat = room.seats[0] as any;
  let captured: ServerMessage | null = null;
  const peer = seat.peer;
  const orig = peer.send;
  peer.send = (m: ServerMessage, e?: boolean) => { if (m.type === "checkpoint") captured = m; orig(m, e); };
  net.rooms.checkpoint(room, seat);
  peer.send = orig;
  const cp = captured as any;
  const total = JSON.stringify(cp).length;
  const state = JSON.stringify(cp.state).length;
  const events = JSON.stringify(cp.events).length;
  const oneGame = JSON.stringify(cp.state.players[0].game).length;
  const lockEvents = cp.events.filter((e: any) => e.event.type === "lock").length;
  // CPU microbenchmarks on this machine
  const match = room.match!;
  let t = performance.now();
  for (let k = 0; k < 200; k++) match.saveState();
  const saveMs = (performance.now() - t) / 200;
  t = performance.now();
  for (let k = 0; k < 200; k++) JSON.stringify(cp);
  const strMs = (performance.now() - t) / 200;
  t = performance.now();
  for (let k = 0; k < 200; k++) { const p = new OwnerPrediction(cp.state, cp.state.roster[0]); p.advanceToTime(cp.state.frame * (1000 / 60) + 150); }
  const predMs = (performance.now() - t) / 200;
  const m2 = Match.fromState(cp.state);
  t = performance.now();
  m2.advanceToFrame(m2.frame + 600);
  const sim10s = performance.now() - t;
  console.log(JSON.stringify({ players: n, checkpointBytes: total, stateBytes: state, eventsBytes: events, eventsCount: cp.events.length, lockEvents, oneGameBytes: oneGame,
    saveStateMs: +saveMs.toFixed(3), stringifyMs: +strMs.toFixed(3), ownerPredictionRebuildMs: +predMs.toFixed(3), idleSim10sMs: +sim10s.toFixed(2),
    perSeatCheckpointKBps_at20Hz: +(total * 20 / 1024).toFixed(1), roomEgressKBps_at20Hz: +(total * 20 * n / 1024).toFixed(1) }));
}
```

## A.9 `exp/replaysize.ts` — replay sizes

```ts
import { encodeReplay } from "@42tris/replay";
import { botPlayer, NetN } from "./nharness";
for (const [n, secs] of [[2, 120], [8, 120]] as const) {
  const net = new NetN(Array.from({ length: n }, () => ({ up: 20, down: 20 })), { seed: 4 });
  net.startMatch();
  net.clients.forEach((_, i) => botPlayer(net, i, 900 + i));
  net.advance(secs * 1000);
  const r = await net.room!.recorder!.buildIncompleteReplay();
  const json = encodeReplay(r!);
  const gz = Bun.gzipSync(new TextEncoder().encode(json));
  const counts: Record<string, number> = {};
  for (const rec of r!.records) counts[rec.op.type] = (counts[rec.op.type] ?? 0) + 1;
  console.log(JSON.stringify({ players: n, seconds: secs, records: r!.records.length, counts, jsonKB: +(json.length / 1024).toFixed(1), gzipKB: +(gz.length / 1024).toFixed(1) }));
}
```

## A.10 `exp/parse.ts` — client parse cost

```ts
import { botPlayer, NetN } from "./nharness";
const net = new NetN([{ up: 15, down: 15 }, { up: 15, down: 15 }], { seed: 3 });
net.startMatch();
net.clients.forEach((_, i) => botPlayer(net, i, 500 + i));
net.advance(90_000);
const room = net.room!; const seat = room.seats[0] as any; let cp: any; const o = seat.peer.send; seat.peer.send = (m: any, e: any) => { if (m.type === "checkpoint") cp = m; o(m, e); };
net.rooms.checkpoint(room, seat); seat.peer.send = o;
const json = JSON.stringify(cp);
let t = performance.now(); for (let k = 0; k < 500; k++) JSON.parse(json); const parse = (performance.now() - t) / 500;
const s = net.clients[0].session as any;
t = performance.now(); for (let k = 0; k < 200; k++) { s.sequence = -1; s.receive(JSON.parse(json)); } const recv = (performance.now() - t) / 200;
console.log(JSON.stringify({ bytesAfter90s: json.length, events: cp.events.length, parseMs: +parse.toFixed(3), parsePlusSessionReceiveMs: +recv.toFixed(3) }));
```

## A.11 `exp/table.ts` — markdown table formatter

```ts
const file = process.argv[2];
const lines = (await Bun.file(file).text()).trim().split("\n").filter(l => l.startsWith("{"));
console.log("| Scenario | Client RTT | Lead | Accepted | Late rej. | Control resets (reason) | Ignored presses | Blocked % | Corrections | Stamp lag p95 | Opp. lag p50/p95 | Ckpt age p50/p95/max | Down KB/s | Skipped ckpts | Replay |");
console.log("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
for (const l of lines) {
  const r = JSON.parse(l);
  for (const c of r.clients) {
    const [a, n] = c.acc.split("/").map(Number);
    const why = Object.entries(c.why).map(([k, v]) => `${k}×${v}`).join(", ");
    console.log(`| ${r.name} | ${c.rtt} | ${c.lead} | ${a}/${n} (${n ? (100 * a / n).toFixed(0) : "–"}%) | ${c.late} | ${c.rel}${why ? ` (${why})` : ""} | ${c.ign} | ${c.blocked} | ${c.corr} | ${c.lagP95} | ${c.oppP50}/${c.oppP95} | ${c.ageP50}/${c.ageP95}/${c.ageMax} | ${c.down} | ${c.skip} | ${c.c === 0 ? (r.replay.startsWith("verified") ? "✓ " + r.replay.replace("verified prefix: ", "") : r.replay) : ""} |`);
  }
}
```

## A.12 Known limitations of this harness

* It is not a network simulator. Delivery is ordered per direction. Jitter is uniform per
  message, plus an optional fixed-size spike. There is no packet loss or TCP congestion
  control. The bandwidth model is a single FIFO link per client downlink, with an optional
  "kernel buffer" that hides backlog from the 64 KiB ephemeral-skip check.
* The browser is modelled as `Session` + a 60 Hz frame callback. There is no rendering, GC or
  real event loop. Stalls pause frames, timers, inbound processing and input handlers.
  WebSocket pongs are answered at network level.
* The scripted player is a bot (~1.6 pieces/s, random taps/DAS/rotations). It rarely clears
  lines, so garbage interactions are under-exercised. The forced-attack experiment that was
  attempted replaced `room.match` mid-session and produced invalid input flow, so its results
  were discarded ([03 §3.8](03-LATENCY-AND-FAILURE-ANALYSIS.md#38-garbage-interaction-under-latency-derived-experiment-specified-not-run)).
* "Blocked %" counts frames with `canPlay === false` while the server room is `playing` and
  the owner is alive. It includes downlink delay at round starts.
* Server CPU excludes socket syscalls, TLS and Elysia/uWS overhead.

## A.13 `exp/n1b-order.ts` — N1-B post-stall ordering (run on `a4a9e8e`, uses the repository harness)

Result: (A) checkpoints first → `staleRecovery {count 1, retracted 1, reissued 1}`, no release.
(B1) trailing-flush timer first, (B2) key press first, (C) 1 s stall timer first → each
`INPUT_REJECTED ×1`, `stale-prediction ×1`, recovery count 0, generation 2 → 3.

```ts
// Does N1-B recovery still apply when something other than a checkpoint runs first after a stall?
import { Input } from "@42tris/core";
import { NetHarness } from "../netplay-harness";

function run(name: string, setup: (h: NetHarness) => void) {
  const h = new NetHarness({ diagnostics: true });
  h.startMatch();
  h.press("a", Input.LeftDown);
  h.advance(5);
  h.press("a", Input.LeftUp);          // inside the 34 ms throttle: unsent, waiting for the trailing flush
  setup(h);
  h.runUntil(() => h.a.session.canPlay && h.a.session.pending.length === 0, 4000);
  h.advance(300);
  const d = h.a.diagnostics!.snapshot();
  const room = h.room!;
  const st = room.match!.playerState(h.a.session.playerId).state;
  console.log(JSON.stringify({ name, releases: d.releases.byReason, rejections: d.rejections.byCode, staleRecovery: d.staleRecovery,
    serverLeftHeld: st.leftHeld, generation: h.a.session.checkpoint!.owner.generation }));
}

run("A: checkpoints processed first after a 300 ms stall (harness default)", h => { h.stall("a", 300); h.advance(300); });
run("B1: trailing-flush timer runs before the first post-stall checkpoint", h => { h.stall("a", 300); h.holdDownstream("a", 320); h.advance(320); });
run("B2: a key press is handled before the first post-stall checkpoint", h => {
  h.stall("a", 300); h.holdDownstream("a", 330);
  h.advance(300);                      // stall ends; the deferred trailing flush also fires here
  h.press("a", Input.RotateCw); h.advance(30);
});
run("C: 1 s stall, timer first", h => { h.stall("a", 1000); h.holdDownstream("a", 1020); h.advance(1020); });
```

## A.14 Re-running the matrix on N1-B

Apply the same three knobs (A.2) to a snapshot of `a4a9e8e`. The `session.ts` hunk applies to
`target()` at `:223-228`. Copy A.3–A.11, then run `sweep.ts` and `spikes.ts`. Compare per
scenario with a small script (acceptance %, non-phase resets, blocked %). Every group stayed
within run-to-run noise, and every replay prefix verified.
