import { requestCompetitiveReplay } from "./replay-request";
import { FRAME_MS, type InputId } from "@42tris/core";
import { OwnerPrediction } from "@42tris/match";
import type { Checkpoint, ClientCommand, InputItem, RoomState, ServerMessage } from "@42tris/protocol";

export interface Transport {
  send(command: ClientCommand): void;
  close(): void;
}
export interface SessionOptions {
  now(): number;
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  profile: Pick<Storage, "getItem" | "setItem">;
  connect(callbacks: { open(): void; message(message: ServerMessage): void; close(): void }): Transport;
  clearKeys(): void;
  skin?(): string;
  schedule?(callback: () => void, delay: number): () => void;
}
type Pending = InputItem & { sent: boolean };
// Attempts at 0, 600, 1800, 4200 and 8200 ms cover a half-open lease's
// six-second heartbeat timeout plus its next heartbeat sweep.
const DUPLICATE_RETRIES = 4;

export class Session {
  room: RoomState | null = null;
  checkpoint: Checkpoint | null = null;
  prediction: OwnerPrediction | null = null;
  playerId = "";
  name = "Guest";
  status = "Offline";
  connected = false;
  duplicate = false;
  active = false;
  pending: Pending[] = [];
  private socket?: Transport;
  private serial = 0;
  private attempts = 0;
  private retryAt = Infinity;
  private openedAt = 0;
  private lastFlush = -Infinity;
  private cancelFlush?: () => void;
  private lastPing = -Infinity;
  private probes = new Map<string, number>();
  private offset = 0;
  private bestRtt = Infinity;
  private identity = "";
  private nextSeq = 1;
  private prepared = "";
  private releasing = false;
  private gap = false;
  private resyncAt = -Infinity;
  private receivedAt = 0;
  private sequence = -1;
  private invite = "";
  private inviteSent = false;
  private sharedSkin = "";
  notice = "";
  private previousName: string | null = null;

  constructor(private options: SessionOptions) {
    this.name = this.read(options.profile, "42tris.name") || "Guest";
  }
  joinInvite(code: string) {
    const normalized = code.toUpperCase();
    if (!/^[A-HJ-NP-Z2-9]{6}$/.test(normalized)) {
      this.notice = "Invalid invitation code. Enter a valid room code to join.";
      return;
    }
    this.invite = normalized;
  }
  private read(storage: SessionOptions["profile"], key: string) {
    try { return storage.getItem(key); }
    catch { this.status = "Browser storage unavailable; this session cannot survive refresh."; return null; }
  }
  private store(storage: SessionOptions["profile"], key: string, value: string) {
    try { storage.setItem(key, value); }
    catch { this.status = "Browser storage unavailable; this session cannot survive refresh."; }
  }
  private forgetToken() {
    try { this.options.storage.removeItem("42tris.resume"); }
    catch { this.status = "Cannot clear browser credential. Enable session storage to change guest."; }
  }
  start() {
    if (this.active) return;
    this.active = true;
    this.attempts = 0;
    this.open();
  }
  stop() {
    this.active = false;
    ++this.serial;
    this.socket?.close();
    this.socket = undefined;
    this.connected = false;
    this.invalidate();
  }
  private open() {
    this.invalidate();
    const serial = ++this.serial;
    this.socket?.close();
    this.connected = false;
    this.inviteSent = false;
    this.openedAt = this.options.now();
    this.retryAt = Infinity;
    this.status = this.attempts ? `Reconnecting (${this.attempts}/8)…` : "Connecting…";
    this.socket = this.options.connect({
      open: () => {
        if (serial !== this.serial) return;
        let profile = this.read(this.options.profile, "42tris.profile");
        if (!profile) {
          profile = `guest-${this.options.now()}-${Math.random().toString(36).slice(2)}`;
          this.store(this.options.profile, "42tris.profile", profile);
        }
        const skin = this.options.skin?.();
        this.sharedSkin = skin ?? "";
        this.socket?.send({ type: "hello", name: this.name, guestProfileId: profile,
          ...(skin ? { skin } : {}),
          resumeToken: this.read(this.options.storage, "42tris.resume") || undefined });
      },
      message: message => { if (serial === this.serial) this.receive(message); },
      close: () => { if (serial === this.serial) this.disconnected(); },
    });
  }
  private disconnected() {
    this.connected = false;
    this.invalidate();
    if (!this.active) return;
    if (this.attempts >= (this.duplicate ? DUPLICATE_RETRIES : 8)) {
      this.retryAt = Infinity;
      this.status = this.duplicate ? "This guest is connected in another window. Join as another guest, or retry after closing it."
        : "Connection failed. Retry to resume your guest.";
    } else {
      this.retryAt = this.options.now() + Math.min(4000, 600 * 2 ** this.attempts);
      this.status = this.duplicate ? "Guest still connected; waiting briefly for refresh…" : "Disconnected. Reconnecting…";
    }
  }
  retry() { this.attempts = 0; this.open(); }
  anotherGuest() {
    this.forgetToken();
    this.room = null;
    this.checkpoint = null;
    this.playerId = "";
    this.identity = "";
    this.duplicate = false;
    this.invalidate();
    this.retry();
  }
  rename(name: string) {
    if (this.connected && this.previousName === null) this.previousName = this.name;
    this.name = name.trim().replace(/[<>\x00-\x1f\x7f]/g, "").slice(0, 24) || "Guest";
    this.store(this.options.profile, "42tris.name", this.name);
    this.send({ type: "rename", name: this.name });
  }
  send(command: ClientCommand) {
    if (command.type === "join" || command.type === "create") this.invite = "";
    if (this.connected) this.socket?.send(command);
  }
  replay(signal: AbortSignal) {
    const code = this.room?.code;
    const token = this.read(this.options.storage, "42tris.resume");
    if (!code || !token) throw new Error("Reconnect to retrieve this replay.");
    return requestCompetitiveReplay(code, token, signal);
  }
  serverNow() { return this.options.now() + this.offset; }
  private invalidate() {
    this.cancelScheduledFlush();
    this.pending = [];
    this.gap = false;
    this.prediction = null;
    this.options.clearKeys();
  }
  release() {
    this.cancelScheduledFlush();
    this.options.clearKeys();
    if (!this.connected || !this.checkpoint?.state || this.releasing) return;
    this.pending = [];
    this.releasing = true;
    this.prediction = null;
    this.send({ type: "releaseControls" });
  }
  practice(type: "practiceUndo" | "practiceReset") {
    if (!this.canPlay || this.room?.options.mode !== "practice") return;
    this.release();
    this.send({ type });
  }
  get canPlay() {
    const state = this.checkpoint?.state;
    const owner = state?.players[state.roster.indexOf(this.playerId)];
    return this.connected && !this.releasing && !this.gap && this.room?.phase === "playing" && !!this.prediction
      && !this.checkpoint?.clock.frozen && this.options.now() - this.receivedAt < 2000
      && !owner?.withdrawn && !(state?.mode === "competitive" && (owner?.eliminated || owner?.game.state.topOut));
  }
  private target() {
    const cp = this.checkpoint!;
    const elapsed = cp.clock.frozen || this.room?.phase !== "playing" ? 0 : Math.max(0, this.serverNow() - cp.serverNow);
    return Math.max(this.prediction?.atMs ?? 0, cp.state!.frame * FRAME_MS,
      Math.min(cp.clock.simulationNow + elapsed, cp.state!.frame * FRAME_MS + 2000));
  }
  input(input: InputId) {
    if (!this.canPlay) return;
    if (this.pending.length >= 128) { this.release(); return; }
    const at = this.target();
    let frame = Math.floor(at / FRAME_MS);
    // Divide first: subtracting frame*FRAME_MS can round subframe up to one.
    let subframe = Math.min(1 - Number.EPSILON, Math.max(0, at / FRAME_MS - frame));
    if ((frame + subframe) * FRAME_MS >= (frame + 1) * FRAME_MS) { frame++; subframe = 0; }
    const item = { seq: this.nextSeq++, frame, subframe, input, sent: false };
    this.pending.push(item);
    // Rebuild before replay: a checkpoint's accepted orders may precede a local
    // input at exactly the same time, even after that time was already rendered.
    this.rebuild();
    this.flushInputs(this.options.now());
  }
  private flushInputs(now: number) {
    if (!this.canPlay) { this.cancelScheduledFlush(); return; }
    const items = this.pending.filter(i => !i.sent).slice(0, 32);
    if (!items.length) { this.cancelScheduledFlush(); return; }
    if (now - this.lastFlush < 34) { this.scheduleFlush(now); return; }
    this.cancelScheduledFlush();
    this.send({ type: "inputBatch", matchId: this.checkpoint!.matchId!,
      generation: this.checkpoint!.owner.generation, epoch: this.checkpoint!.owner.epoch,
      items: items.map(({ sent: _, ...item }) => item) });
    items.forEach(i => { i.sent = true; });
    this.lastFlush = now;
    if (this.pending.some(i => !i.sent)) this.scheduleFlush(now);
  }
  private cancelScheduledFlush() {
    this.cancelFlush?.();
    this.cancelFlush = undefined;
  }
  private scheduleFlush(now: number) {
    if (this.cancelFlush) return;
    const schedule = this.options.schedule ?? ((callback, delay) => {
      const timer = setTimeout(callback, delay);
      return () => clearTimeout(timer);
    });
    this.cancelFlush = schedule(() => {
      this.cancelFlush = undefined;
      this.flushInputs(this.options.now());
    }, Math.max(0, Math.ceil(this.lastFlush + 34 - now)));
  }
  private rebuild() {
    const cp = this.checkpoint;
    if (!cp?.state || !cp.state.roster.includes(this.playerId) || this.releasing) return;
    const target = this.prediction?.atMs ?? cp.state.frame * FRAME_MS;
    const prediction = new OwnerPrediction(cp.state, this.playerId);
    const accepted = new Set(cp.owner.pendingAccepted.map(i => i.seq));
    for (const item of this.pending) {
      if (accepted.has(item.seq)) continue;
      if (item.frame < cp.state.frame) { this.release(); return; }
      prediction.submit({ player: this.playerId, frame: item.frame, subframe: item.subframe,
        input: item.input, order: 2 ** 48 + item.seq, epoch: cp.owner.epoch });
    }
    this.prediction = prediction;
    prediction.advanceToTime(Math.max(target, this.target()));
  }
  private resync() {
    if (this.options.now() - this.resyncAt < 500) return;
    this.resyncAt = this.options.now();
    this.send({ type: "resync" });
  }
  receive(message: ServerMessage) {
    switch (message.type) {
      case "welcome":
        this.connected = true;
        this.duplicate = false;
        this.attempts = 0;
        this.sequence = -1;
        this.offset = message.serverNow - this.options.now();
        this.bestRtt = Infinity;
        this.playerId = message.playerId;
        this.name = message.name;
        this.previousName = null;
        this.room = message.room;
        this.store(this.options.storage, "42tris.resume", message.resumeToken);
        this.status = `Connected as ${message.name}`;
        this.lastPing = -Infinity;
        if (this.invite) {
          if (message.room) {
            if (message.room.code !== this.invite) this.notice = `You are already in room ${message.room.code}. Leave it to join another room.`;
            this.invite = "";
          } else if (!this.inviteSent) {
            this.inviteSent = true;
            this.socket?.send({ type: "join", code: this.invite });
          }
        }
        break;
      case "roomState":
        if (message.room.players.find(p => p.playerId === this.playerId)?.name === this.name) this.previousName = null;
        this.room = message.room;
        this.invite = "";
        if (!this.canPlay) this.cancelScheduledFlush();
        if (message.room.phase !== "playing") this.options.clearKeys();
        break;
      case "checkpoint": {
        if (message.serverSequence <= this.sequence) return;
        this.sequence = message.serverSequence;
        this.receivedAt = this.options.now();
        this.room = message.room;
        this.invite = "";
        const identity = [message.matchId, message.state?.round, message.owner.generation, message.owner.epoch].join(":");
        const changed = identity !== this.identity;
        if (changed) {
          this.invalidate();
          this.nextSeq = message.owner.nextSeq;
          this.releasing = false;
          this.identity = identity;
        }
        this.checkpoint = message;
        const accepted = new Set(message.owner.pendingAccepted.map(i => i.seq));
        const rejected = new Set(message.owner.rejections.map(i => i.seq));
        const rejectedLocal = this.pending.some(i => rejected.has(i.seq));
        this.pending = this.pending.filter(i => i.seq > message.owner.resolvedThroughSeq && !rejected.has(i.seq)
          && (i.seq >= message.owner.nextSeq || accepted.has(i.seq)));
        this.nextSeq = Math.max(this.nextSeq, message.owner.nextSeq);
        if (rejectedLocal) { this.release(); break; }
        if (this.gap) {
          this.gap = false;
          if (this.nextSeq > message.owner.nextSeq && !this.pending.some(i => i.seq === message.owner.nextSeq)) {
            this.release(); break;
          }
          for (const item of this.pending) if (item.seq >= message.owner.nextSeq) item.sent = false;
        }
        this.rebuild();
        if (!this.canPlay || !this.pending.some(i => !i.sent)) this.cancelScheduledFlush();
        else if (!this.cancelFlush) this.scheduleFlush(this.options.now());
        if (message.room.phase !== "playing") this.options.clearKeys();
        const preparation = `${message.matchId}:${message.room.preparationId}`;
        if (message.room.phase === "preparing" && this.prediction && this.prepared !== preparation) {
          this.prepared = preparation;
          this.send({ type: "prepared", matchId: message.matchId!, preparationId: message.room.preparationId });
        }
        break;
      }
      case "left":
        this.room = null;
        this.checkpoint = null;
        this.identity = "";
        this.invalidate();
        break;
      case "pong": {
        const sent = this.probes.get(message.nonce);
        if (sent === undefined) break;
        const rtt = this.options.now() - sent;
        if (rtt < this.bestRtt) {
          this.bestRtt = rtt;
          this.offset = message.serverNow - (sent + this.options.now()) / 2;
        }
        this.probes.delete(message.nonce);
        break;
      }
      case "error":
        if (this.previousName !== null) {
          this.name = this.previousName;
          this.previousName = null;
          this.store(this.options.profile, "42tris.name", this.name);
        }
        this.status = `${message.code}: ${message.message}`;
        if (this.invite && ["ROOM_NOT_FOUND", "ROOM_FULL", "ROOM_BUSY"].includes(message.code)) {
          this.status = message.code === "ROOM_NOT_FOUND" ? "Room not found or expired. Check the code and try again."
            : message.code === "ROOM_FULL" ? "Room is full. Try another room code."
            : "Room is unavailable to join right now. Try another room code.";
          this.invite = "";
        }
        if (message.code === "ALREADY_CONNECTED") {
          this.duplicate = true;
          this.socket?.close();
          this.disconnected();
        } else if (message.code === "SESSION_EXPIRED") {
          this.forgetToken();
          this.room = null;
          this.checkpoint = null;
          this.identity = "";
          this.invalidate();
          this.socket?.send({ type: "hello", name: this.name,
            guestProfileId: this.read(this.options.profile, "42tris.profile") || undefined });
          this.status = "Session expired or server restarted. Previous game is unavailable; join a room again.";
          this.notice = this.status;
        } else if (message.code === "SEQ_GAP") {
          this.gap = true;
          this.cancelScheduledFlush();
          this.resync();
        } else if (["INPUT_REJECTED", "STALE_INPUT", "SEQ_EXPIRED", "RATE_LIMIT"].includes(message.code)
          || message.code === "WRONG_PHASE" && this.pending.length > 0) this.release();
        break;
    }
  }
  tick() {
    const now = this.options.now();
    if (!this.active) return;
    if (!this.connected) {
      if (now >= this.retryAt) { ++this.attempts; this.open(); }
      else if (this.retryAt === Infinity && now - this.openedAt > 6000 && this.attempts < (this.duplicate ? DUPLICATE_RETRIES : 8)) {
        this.socket?.close();
        this.disconnected();
      }
      return;
    }
    const skin = this.options.skin?.();
    if (skin && skin !== this.sharedSkin) {
      this.sharedSkin = skin;
      this.send({ type: "skin", skin });
    }
    if (now - this.lastPing >= 2000) {
      const nonce = String(now);
      this.probes.clear();
      this.probes.set(nonce, now);
      this.send({ type: "ping", nonce });
      this.lastPing = now;
    }
    if (this.checkpoint?.state && now - this.receivedAt >= 2000) { this.cancelScheduledFlush(); this.resync(); return; }
    if (this.canPlay) {
      this.prediction!.advanceToTime(this.target());
      this.flushInputs(now);
    }
  }
}
