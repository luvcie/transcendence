import { AdaptiveInputLead, type AdaptiveDecision } from "./adaptive-input-lead";
import { requestCompetitiveReplay } from "./replay-request";
import { FRAME_MS, Input, setBoardEdges, type InputId } from "@42tris/core";
import { OwnerPrediction } from "@42tris/match";
import { MAX_INPUT_LEAD_MS, type Checkpoint, type ClientCommand, type InputItem, type RoomState, type ServerMessage } from "@42tris/protocol";
import type { ReleaseReason, SessionDiagnostics } from "./session-diagnostics";

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
  /** Opt-in only. Never part of gameplay, checkpoints, or replay journals. */
  diagnostics?: SessionDiagnostics;
  /** Experimental, fixed at construction. The application authorizes this via ?diagnostics. */
  inputLeadMs?: number | "auto";
}

export function normalizeInputLead(value: number = 0): number {
  return Number.isFinite(value) && value >= 0 && value <= MAX_INPUT_LEAD_MS ? value : 0;
}
type Pending = InputItem & { sent: boolean; transmitted: boolean };
type Control = "left" | "right" | "soft";
// Attempts at 0, 600, 1800, 4200 and 8200 ms cover a half-open lease's
// six-second heartbeat timeout plus its next heartbeat sweep.
const DUPLICATE_RETRIES = 4;
const DEFER_MAX_MS = 500;

// Held controls carry state; one-shot actions do something at one moment. Only
// the first can move to the resume frame without changing what it does.
const CONTROL_OF: Partial<Record<InputId, Control>> = {
  [Input.LeftDown]: "left", [Input.LeftUp]: "left",
  [Input.RightDown]: "right", [Input.RightUp]: "right",
  [Input.SoftDropDown]: "soft", [Input.SoftDropUp]: "soft",
};
const CONTROL_DOWN: Record<Control, InputId> = { left: Input.LeftDown, right: Input.RightDown, soft: Input.SoftDropDown };
const CONTROL_UP: Record<Control, InputId> = { left: Input.LeftUp, right: Input.RightUp, soft: Input.SoftDropUp };

function releaseReason(code: string): ReleaseReason {
  if (code === "STALE_INPUT") return "stale-input";
  if (code === "SEQ_EXPIRED") return "sequence-expired";
  if (code === "RATE_LIMIT") return "rate-limit";
  if (code === "WRONG_PHASE") return "wrong-phase";
  return "rejected-input";
}

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
  private deferred?: { first: Pending; until: number; cancel?: () => void };
  private lastPing = -Infinity;
  private probes = new Map<string, number>();
  private offset = 0;
  private bestRtt = Infinity;
  private identity = "";
  private leadRound = "";
  private readonly requestedLeadMs: number;
  private readonly leadMode: "zero" | "fixed" | "adaptive";
  private activeLeadMs = 0;
  private readonly adaptive?: AdaptiveInputLead;
  private roundOffsetMs: number | null = null;
  private leadFinalized = false;
  private leadMatch = "";
  private adaptiveDecision?: AdaptiveDecision;
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
  private previousName: string | null = null;
  readonly diagnostics?: SessionDiagnostics;
  notice = "";

  constructor(private options: SessionOptions) {
    this.adaptive = options.inputLeadMs === "auto" ? new AdaptiveInputLead() : undefined;
    this.requestedLeadMs = options.inputLeadMs === "auto" ? 0 : normalizeInputLead(options.inputLeadMs);
    this.leadMode = this.adaptive ? "adaptive" : options.inputLeadMs !== undefined && options.inputLeadMs === this.requestedLeadMs ? "fixed" : "zero";
    this.diagnostics = options.diagnostics;
    this.name = this.read(options.profile, "42tris.name") || "Guest";
    this.diagnostics?.attach(options.now, () => {
      const state = this.checkpoint?.state;
      const owner = state?.players[state.roster.indexOf(this.playerId)];
      return {
        eligible: this.connected && this.room?.phase === "playing" && !!owner && !owner.withdrawn
          && this.room.code === this.checkpoint?.room.code && this.room.matchId === this.checkpoint?.matchId
          && !(state?.mode === "competitive" && (owner.eliminated || owner.game.state.topOut)),
        playable: this.canPlay,
        expiresAt: this.receivedAt + 2000,
      };
    }, () => this.timingDiagnostics());
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
    this.diagnostics?.connection(this.options.now(), false);
    this.diagnostics?.updateControl();
  }
  private open() {
    this.invalidate();
    const serial = ++this.serial;
    this.adaptive?.connection(serial);
    if (this.adaptive) this.probes.clear();
    this.socket?.close();
    this.connected = false;
    this.diagnostics?.connection(this.options.now(), false);
    this.inviteSent = false;
    this.openedAt = this.options.now();
    this.retryAt = Infinity;
    this.diagnostics?.updateControl();
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
    this.diagnostics?.connection(this.options.now(), false);
    this.diagnostics?.updateControl();
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
    this.resetLead();
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
  private get effectiveOffsetMs() { return this.roundOffsetMs ?? this.offset; }
  serverNow() { return this.options.now() + this.effectiveOffsetMs; }
  private timingDiagnostics() {
    const now = this.options.now();
    const proposal = this.adaptive?.proposal(now, this.checkpoint?.clock.commitDelayMs ?? 100);
    const samples = this.adaptive?.observations(now) ?? [];
    const selected = this.adaptiveDecision?.proposal?.selected;
    return {
      lead: { mode: this.leadMode,
        requestedMs: this.adaptive ? null : this.requestedLeadMs, appliedMs: this.activeLeadMs,
        proposedNextMs: proposal?.candidateMs ?? null, wantedMs: proposal?.wantedMs ?? null,
        ceilingMs: proposal?.ceilingMs ?? null, reason: this.adaptiveDecision?.reason ?? null,
        capped: proposal?.capped ?? false },
      adaptive: { sampleCount: samples.length, newestSampleAgeMs: samples.length ? now - samples.at(-1)!.receivedAtClientMs : null,
        rttMin: proposal?.rttMin ?? null, rttMedian: proposal?.rttMedian ?? null, rttP95: proposal?.rttP95 ?? null,
        effectiveTransitMedian: proposal?.effectiveTransitMedian ?? null, effectiveTransitP95: proposal?.effectiveTransitP95 ?? null,
        decreaseConfirmed: this.adaptive?.decreaseConfirmed ?? false,
        decisions: this.adaptive?.decisions().map(d => ({ at: d.at, roundOrdinal: d.roundOrdinal,
          previousMs: d.previousMs, appliedMs: d.appliedMs, reason: d.reason,
          wantedMs: d.proposal?.wantedMs ?? null, ceilingMs: d.proposal?.ceilingMs ?? null,
          rttP95: d.proposal?.rttP95 ?? null, effectiveTransitP95: d.proposal?.effectiveTransitP95 ?? null })) ?? [] },
      clock: { estimatedOffsetMs: this.offset, effectiveOffsetMs: this.effectiveOffsetMs,
        bestRttMs: Number.isFinite(this.bestRtt) ? this.bestRtt : null,
        calibrated: this.connected && Number.isFinite(this.bestRtt),
        selectedSampleAgeMs: selected ? now - selected.receivedAtClientMs : null,
        selectedSampleRttMs: selected?.rttMs ?? null,
        quality: !this.adaptive ? (Number.isFinite(this.bestRtt) ? "fresh" as const : "unwarmed" as const)
          : !proposal ? (this.adaptive.fallbackReason === "fallback-unwarmed" ? "unwarmed" as const : "stale" as const)
          : proposal.capped ? "capped" as const : "fresh" as const },
    };
  }
  private resetLead() {
    this.leadRound = "";
    this.activeLeadMs = 0;
    this.roundOffsetMs = null;
    this.leadFinalized = false;
    this.leadMatch = "";
    this.adaptiveDecision = undefined;
    this.adaptive?.resetDecrease();
  }
  private invalidate() {
    this.cancelScheduledFlush();
    this.pending = [];
    this.gap = false;
    this.prediction = null;
    this.options.clearKeys();
    this.diagnostics?.clearQueue();
  }
  release(reason: ReleaseReason = "user") {
    this.cancelScheduledFlush();
    this.options.clearKeys();
    const cp = this.checkpoint;
    if (!this.connected || !cp?.state || this.releasing) return;
    this.pending = [];
    this.releasing = true;
    this.prediction = null;
    this.diagnostics?.clearQueue();
    this.diagnostics?.release(reason, this.options.now(), cp.owner.generation);
    this.send({ type: "releaseControls" });
    this.diagnostics?.updateControl();
  }
  practice(type: "practiceUndo" | "practiceReset") {
    if (!this.canPlay || this.room?.options.mode !== "practice") return;
    this.release();
    this.send({ type });
  }
  private get controlsReady() {
    const state = this.checkpoint?.state;
    const owner = state?.players[state.roster.indexOf(this.playerId)];
    return this.connected && !this.releasing && !this.gap && this.room?.phase === "playing" && !!this.prediction
      && this.room.code === this.checkpoint?.room.code && this.room.matchId === this.checkpoint?.matchId
      && !this.checkpoint?.clock.frozen
      && !owner?.withdrawn && !(state?.mode === "competitive" && (owner?.eliminated || owner?.game.state.topOut));
  }
  get canPlay() { return this.controlsReady && this.options.now() - this.receivedAt < 2000; }
  private target() {
    const cp = this.checkpoint!;
    const base = cp.state!.frame * FRAME_MS;
    const running = !cp.clock.frozen && this.room?.phase === "playing";
    const elapsed = running ? Math.max(0, this.serverNow() - cp.serverNow) : 0;
    return Math.max(this.prediction?.atMs ?? 0, base,
      Math.min(cp.clock.simulationNow + elapsed + (running ? this.activeLeadMs : 0), base + 2000));
  }
  input(input: InputId) {
    this.adaptive?.activity(this.options.now());
    if (!this.canPlay) return;
    if (this.pending.length >= 128) { this.release("pending-overflow"); return; }
    this.queue(input);
    // Rebuild before replay: a checkpoint's accepted orders may precede a local
    // input at exactly the same time, even after that time was already rendered.
    this.rebuild();
    this.flushInputs(this.options.now());
  }
  private queue(input: InputId, at = this.target()) {
    let frame = Math.floor(at / FRAME_MS);
    // Divide first: subtracting frame*FRAME_MS can round subframe up to one.
    let subframe = Math.min(1 - Number.EPSILON, Math.max(0, at / FRAME_MS - frame));
    if ((frame + subframe) * FRAME_MS >= (frame + 1) * FRAME_MS) { frame++; subframe = 0; }
    const item = { seq: this.nextSeq++, frame, subframe, input, sent: false, transmitted: false };
    this.pending.push(item);
    this.diagnostics?.queuedInput(item.seq, this.options.now());
  }
  private flushInputs(now: number) {
    if (!this.canPlay) {
      if (!this.deferred || !this.controlsReady) this.cancelScheduledFlush();
      return;
    }
    const items = this.pending.filter(i => !i.sent).slice(0, 32);
    if (!items.length) { this.cancelScheduledFlush(); return; }
    const previous = this.deferred;
    if (previous && previous.first !== items[0]) this.cancelScheduledFlush();
    if (this.deferred) {
      if (now >= this.deferred.until) this.release("stale-prediction");
      return;
    }
    const cp = this.checkpoint!;
    const committed = cp.clock.simulationNow + Math.max(0, this.serverNow() - cp.serverNow) - cp.clock.commitDelayMs;
    const first = items[0];
    if (!first.transmitted && (first.frame + first.subframe) * FRAME_MS < committed - FRAME_MS) {
      // Partial checkpoint recovery can replace the first item without making
      // the surviving tail safe to send. It must not renew the waiting budget.
      const until = previous?.until ?? now + DEFER_MAX_MS;
      if (now >= until) { this.release("stale-prediction"); return; }
      this.cancelScheduledFlush();
      const deferred = { first, until };
      this.deferred = deferred;
      this.deferred.cancel = this.schedule(() => {
        if (this.deferred !== deferred) return;
        this.cancelScheduledFlush();
        // A clock estimate cannot retract inputs. Without a checkpoint, use the
        // existing generation reset rather than send a likely-stale batch.
        this.release("stale-prediction");
      }, until - now);
      this.resync();
      return;
    }
    if (now - this.lastFlush < 34) { this.scheduleFlush(now); return; }
    this.cancelScheduledFlush();
    this.send({ type: "inputBatch", matchId: this.checkpoint!.matchId!,
      generation: this.checkpoint!.owner.generation, epoch: this.checkpoint!.owner.epoch,
      items: items.map(({ sent: _, transmitted: __, ...item }) => item) });
    items.forEach(i => { i.sent = true; i.transmitted = true; });
    this.lastFlush = now;
    this.diagnostics?.sentBatch(now, items.map(item => item.seq), this.pending.length);
    if (this.diagnostics) {
      // Input stamps are round-relative simulation time, not the process clock.
      const deadline = cp.clock.simulationNow + Math.max(0, now + this.effectiveOffsetMs - cp.serverNow) - cp.clock.commitDelayMs;
      for (const item of items) this.diagnostics.inputMargin((item.frame + item.subframe) * FRAME_MS, deadline);
    }
    if (this.pending.some(i => !i.sent)) this.scheduleFlush(now);
  }
  private cancelScheduledFlush() {
    this.cancelFlush?.();
    this.cancelFlush = undefined;
    this.deferred?.cancel?.();
    this.deferred = undefined;
  }
  private schedule(callback: () => void, delay: number) {
    const schedule = this.options.schedule ?? ((callback, delay) => {
      const timer = setTimeout(callback, delay);
      return () => clearTimeout(timer);
    });
    return schedule(callback, delay);
  }
  private scheduleFlush(now: number) {
    if (this.cancelFlush || this.deferred) return;
    this.cancelFlush = this.schedule(() => {
      this.cancelFlush = undefined;
      this.flushInputs(this.options.now());
    }, Math.max(0, Math.ceil(this.lastFlush + 34 - now)));
  }
  private rebuild(authoritative = false) {
    const cp = this.checkpoint;
    if (!cp?.state || !cp.state.roster.includes(this.playerId) || this.releasing) return;
    const previous = this.prediction;
    const target = previous?.atMs ?? cp.state.frame * FRAME_MS;
    // Capture what the player was shown. The corrected prediction is evaluated at
    // exactly this simulation time before any divergence is classified, because
    // comparing two different times would invent corrections that never happened.
    const shown = authoritative && this.diagnostics && previous
      && previous.owner === this.playerId && previous.round === cp.state.round
      && previous.epoch === cp.owner.epoch && previous.atMs >= cp.state.frame * FRAME_MS
      ? previous.saveState() : null;
    const accepted = new Set(cp.owner.pendingAccepted.map(i => i.seq));
    if (!this.recover(cp, accepted)) { this.release("stale-prediction"); return; }
    const prediction = new OwnerPrediction(cp.state, this.playerId);
    for (const item of this.pending) {
      if (accepted.has(item.seq)) continue;
      if (item.frame < cp.state.frame) { this.release("stale-prediction"); return; }
      prediction.submit({ player: this.playerId, frame: item.frame, subframe: item.subframe,
        input: item.input, order: 2 ** 48 + item.seq, epoch: cp.owner.epoch });
    }
    this.prediction = prediction;
    const finalTarget = Math.max(target, this.target());
    if (shown) {
      if (prediction.atMs < shown.atMs) prediction.advanceToTime(shown.atMs);
      this.diagnostics!.correction(this.options.now(), shown.atMs, shown, prediction.saveState());
    }
    prediction.advanceToTime(finalTarget);
  }
  /**
   * A queued input that never left the browser is the one stale input the client
   * can retract: the server has no record of it and its sequence number was never
   * used. Held controls are re-issued before surviving unsent actions (or at the
   * resume frame), netted to the transition the checkpoint does not already
   * carry. One-shot actions are dropped instead of being replayed onto a
   * different board. Anything already transmitted still needs the full release,
   * because it can no longer be taken back from the server.
   */
  private recover(cp: Checkpoint, accepted: Set<number>): boolean {
    const frame = cp.state!.frame;
    const stale = this.pending.filter(item => !accepted.has(item.seq) && item.frame < frame);
    if (!stale.length) return true;
    const firstUnsent = this.pending.findIndex(item => !item.sent);
    // Frames only grow, so the stale ones are a prefix of the unsent tail. A
    // transmitted item, or a hole before the tail, cannot be retracted this way.
    if (firstUnsent < 0 || stale[0] !== this.pending[firstUnsent] || stale.some(item => item.transmitted)
      // A gap retry can clear `sent` on an input the server may still hold; its
      // number is spoken for, so the whole tail has to stay put.
      || this.pending.some(item => !item.sent && item.transmitted)) return false;
    const wanted = new Map<Control, boolean>();
    for (const item of stale) {
      const control = CONTROL_OF[item.input];
      if (control === undefined) continue;
      // Last transition wins: a press and release that both happened during the
      // stall leave the control where the player left it, not half applied.
      wanted.delete(control);
      wanted.set(control, item.input === CONTROL_DOWN[control]);
    }
    const retracted = stale.map(item => item.seq);
    const removed = new Set<InputItem>(stale);
    this.pending = this.pending.filter(item => !removed.has(item));
    const unsent = this.pending.filter(item => !item.sent);
    const first = unsent[0];
    const at = Math.min(this.target(), first ? (first.frame + first.subframe) * FRAME_MS : Infinity);
    const owner = cp.state!.players[cp.state!.roster.indexOf(this.playerId)].game.state;
    const held = { left: owner.leftHeld, right: owner.rightHeld, soft: owner.softHeld };
    const corrections: InputId[] = [];
    for (const [control, want] of wanted) {
      if (held[control] !== want) corrections.push(want ? CONTROL_DOWN[control] : CONTROL_UP[control]);
    }
    // The dropped numbers were never sent, so close the hole locally: the server
    // still expects the first of them next. Correct held state before newer
    // actions at their original time; never retime a surviving one-shot.
    const seqs = new Map<number, number>();
    let seq = cp.owner.nextSeq + corrections.length;
    for (const item of unsent) {
      seqs.set(item.seq, seq);
      item.seq = seq++;
    }
    this.diagnostics?.renumber(seqs, retracted);
    this.pending = this.pending.filter(item => item.sent);
    this.nextSeq = cp.owner.nextSeq;
    for (const input of corrections) this.queue(input, at);
    this.pending.push(...unsent);
    this.nextSeq = seq;
    this.diagnostics?.recovered(this.options.now(), retracted.length, corrections.length);
    return true;
  }
  private resync() {
    if (this.options.now() - this.resyncAt < 500) return;
    this.resyncAt = this.options.now();
    this.send({ type: "resync" });
  }
  receive(message: ServerMessage) {
    this.adaptive?.activity(this.options.now());
    try { this.receiveMessage(message); }
    finally { this.diagnostics?.updateControl(); }
  }
  private receiveMessage(message: ServerMessage) {
    switch (message.type) {
      case "welcome":
        this.connected = true;
        this.diagnostics?.connection(this.options.now(), true);
        this.duplicate = false;
        this.attempts = 0;
        this.sequence = -1;
        this.offset = message.serverNow - this.options.now();
        this.bestRtt = Infinity;
        this.playerId = message.playerId;
        this.name = message.name;
        this.previousName = null;
        this.room = message.room;
        if (this.adaptive && (!message.room?.matchId || this.leadMatch && this.leadMatch !== JSON.stringify([message.room.code, message.room.matchId]))) this.resetLead();
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
        if (this.diagnostics && this.checkpoint && (message.room.code !== this.checkpoint.room.code
          || message.room.matchId !== this.checkpoint.matchId)) this.diagnostics.identityChanged();
        if (message.room.players.find(p => p.playerId === this.playerId)?.name === this.name) this.previousName = null;
        this.room = message.room;
        if (this.adaptive && (!message.room.matchId || this.leadMatch && this.leadMatch !== JSON.stringify([message.room.code, message.room.matchId]))) this.resetLead();
        this.invite = "";
        if (!this.canPlay && (!this.deferred || !this.controlsReady)) this.cancelScheduledFlush();
        if (message.room.phase !== "playing") this.options.clearKeys();
        break;
      case "checkpoint": {
        if (message.serverSequence <= this.sequence) { this.diagnostics?.staleCheckpoint(this.options.now()); return; }
        if (message.state && message.boardEdges) {
          if (message.boardEdges.length !== message.state.players.length) throw new RangeError("Checkpoint edge roster differs");
          const edges = message.boardEdges.map(value => Uint8Array.from(atob(value), char => char.charCodeAt(0)));
          if (edges.some((value, i) => value.length !== message.state!.players[i].game.board.length)) throw new RangeError("Checkpoint edge dimensions differ");
          message.state.players.forEach((player, i) => setBoardEdges(player.game.board, edges[i]));
        }
        this.sequence = message.serverSequence;
        this.receivedAt = this.options.now();
        this.room = message.room;
        this.invite = "";
        const identity = [message.room.code, message.matchId, message.state?.round, message.owner.generation, message.owner.epoch].join(":");
        const changed = identity !== this.identity;

        if (changed) {
          this.invalidate();
          this.nextSeq = message.owner.nextSeq;
          this.releasing = false;
          this.identity = identity;
        }
        this.checkpoint = message;
        if (message.state && message.matchId) {
          // Recovery identities include generation and practice epoch; neither
          // starts a round. Latch before rebuilding its first prediction.
          const round = JSON.stringify([message.room.code, message.matchId, message.state.round]);
          if (round !== this.leadRound) {
            const match = JSON.stringify([message.room.code, message.matchId]);
            if (this.adaptive && match !== this.leadMatch) {
              this.activeLeadMs = 0;
              this.adaptive.resetDecrease();
            }
            this.leadMatch = match;
            this.leadRound = round;
            this.roundOffsetMs = null;
            this.leadFinalized = false;
            this.adaptiveDecision = undefined;
            if (!this.adaptive) this.activeLeadMs = this.requestedLeadMs;
          }
          if (this.adaptive && !this.leadFinalized && message.room.phase === "playing" && !message.clock.frozen) {
            const decision = this.adaptive.decide(this.options.now(), message.clock.commitDelayMs, this.activeLeadMs);
            this.activeLeadMs = decision.appliedMs;
            this.roundOffsetMs = decision.offsetMs;
            this.adaptiveDecision = decision;
            this.leadFinalized = true;
          }
        } else this.resetLead();
        this.diagnostics?.checkpoint(this.receivedAt, { sequence: message.serverSequence, serverNow: message.serverNow,
          frame: message.state?.frame ?? 0, round: message.state?.round ?? 0,
          generation: message.owner.generation, identityChanged: changed,
          estimatedOffset: this.connected ? this.effectiveOffsetMs : undefined });
        const accepted = new Set(message.owner.pendingAccepted.map(i => i.seq));
        const rejected = new Set(message.owner.rejections.map(i => i.seq));
        const rejectedLocal = this.pending.some(i => rejected.has(i.seq));
        this.diagnostics?.rejections(this.receivedAt, message.owner.rejections, message.owner.generation);
        this.pending = this.pending.filter(i => i.seq > message.owner.resolvedThroughSeq && !rejected.has(i.seq)
          && (i.seq >= message.owner.nextSeq || accepted.has(i.seq)));
        this.nextSeq = Math.max(this.nextSeq, message.owner.nextSeq);
        if (rejectedLocal) { this.release("rejected-input"); break; }
        if (this.gap) {
          this.gap = false;
          if (this.nextSeq > message.owner.nextSeq && !this.pending.some(i => i.seq === message.owner.nextSeq)) {
            this.release("gap-recovery"); break;
          }
          for (const item of this.pending) if (item.seq >= message.owner.nextSeq) item.sent = false;
        }
        this.rebuild(true);
        if (this.deferred && !this.pending.includes(this.deferred.first)) this.flushInputs(this.options.now());
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
        this.resetLead();
        this.diagnostics?.identityChanged();
        this.invalidate();
        break;
      case "pong": {
        if (this.adaptive) {
          const valid = this.adaptive.pong(message.nonce, message.serverNow, this.options.now(),
            this.checkpoint?.clock.commitDelayMs ?? 100, this.activeLeadMs);
          if (valid) {
            const sample = this.adaptive.observations(this.options.now()).at(-1)!;
            this.diagnostics?.rtt(sample.rttMs);
            this.diagnostics?.clockOffset(sample.receivedAtClientMs, sample.impliedOffsetMs);
            if (sample.rttMs < this.bestRtt) {
              this.bestRtt = sample.rttMs;
              this.offset = sample.impliedOffsetMs;
            }
          }
          break;
        }
        const sent = this.probes.get(message.nonce);
        if (sent === undefined) break;
        const rtt = this.options.now() - sent;
        this.diagnostics?.rtt(rtt);
        this.diagnostics?.clockOffset(sent + rtt, message.serverNow - (sent + rtt / 2));
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
          this.resetLead();
          this.diagnostics?.identityChanged();
          this.invalidate();
          this.socket?.send({ type: "hello", name: this.name,
            guestProfileId: this.read(this.options.profile, "42tris.profile") || undefined });
          this.status = "Session expired or server restarted. Previous game is unavailable; join a room again.";
          this.notice = this.status;
        } else if (message.code === "SEQ_GAP") {
          this.diagnostics?.rejection(this.options.now(), message.code, null);
          this.gap = true;
          this.cancelScheduledFlush();
          this.resync();
        } else if (["INPUT_REJECTED", "STALE_INPUT", "SEQ_EXPIRED", "RATE_LIMIT"].includes(message.code)
          || message.code === "WRONG_PHASE" && this.pending.length > 0) {
          this.diagnostics?.rejection(this.options.now(), message.code, null);
          this.release(releaseReason(message.code));
        }
        break;
    }
  }
  tick() {
    const now = this.options.now();
    this.adaptive?.activity(now);
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
    if (now - this.lastPing >= (this.adaptive?.cadence(now) ?? 2000)) {
      const nonce = this.adaptive ? this.adaptive.probe(now) : String(now);
      if (nonce !== null) {
        if (!this.adaptive) {
          this.probes.clear();
          this.probes.set(nonce, now);
        }
        this.send({ type: "ping", nonce });
        this.lastPing = now;
      }
    }
    if (this.checkpoint?.state && now - this.receivedAt >= 2000) {
      // Suspending play must not cancel the pending recovery deadline.
      if (!this.deferred || !this.controlsReady) this.cancelScheduledFlush();
      this.resync();
      return;
    }
    if (this.canPlay) {
      this.prediction!.advanceToTime(this.target());
      this.flushInputs(now);
    }
  }
}
