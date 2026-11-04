import { copyBoardEdges, DEFAULT_HANDLING, FRAME_MS, Game, LEAGUE_LOCK, Rng, validateHandling, validateBoardWidth,
  type GameState, type Handling, type InputId, type LockResult } from "@42tris/core";
import { GARBAGE_DELAY_MS, GARBAGE_PROFILE, GarbageQueue,
  type GarbageState, type Packet, type QueueRecord } from "./garbage";
import { compareInputs, hasFrameTimestamp, inputTime, validInput } from "./clock";
import { settlePlacement } from "./placement";

export const MATCH_VERSION = 3;

export interface MatchOptions {
  players: readonly string[];
  width?: number;
  seed: number;
  firstTo?: number;
  handlingByPlayer?: Readonly<Record<string, Handling>>;
  mode?: "competitive" | "practice";
  attacksEnabled?: boolean;
}

export interface MatchInput {
  player: string;
  frame: number;
  subframe: number;
  order: number;
  input: InputId;
  epoch?: number;
}

export type MatchEvent = { round: number; atMs: number } & (
  | { type: "lock"; player: string; epoch: number; result: LockResult }
  | { type: "queue"; packet: Packet }
  | { type: "send"; packet: Packet }
  | { type: "crossCancel"; packets: [number, number]; lines: number }
  | { type: "discard"; packet: number; lines: number }
  | { type: "eliminated"; player: string }
  | { type: "roundEnd"; winner: string | null; complete: boolean; reason: "survivor" | "draw" | "forfeit" }
  | { type: "setEnd"; winner: string | null; reason: "firstTo" | "forfeit" | "aborted" }
  | { type: "practiceUndo" | "practiceReset"; player: string; epoch: number }
  | { type: "controlsReleased"; player: string }
  | { type: "forfeit"; player: string }
  | { type: "attacksEnabled"; enabled: boolean }
  | ({ player: string } & QueueRecord)
);

interface Player {
  game: Game;
  garbage: GarbageQueue;
  sent: number;
  eliminated: boolean;
  withdrawn: boolean;
  epoch: number;
}

export interface MatchState {
  version: typeof MATCH_VERSION;
  garbageProfile: typeof GARBAGE_PROFILE;
  roster: string[];
  firstTo: number;
  width: number;
  mode: "competitive" | "practice";
  attacksEnabled: boolean;
  handlingByPlayer: Record<string, Handling>;
  round: number;
  seed: number;
  frame: number;
  ended: boolean;
  complete: boolean;
  scores: number[];
  routingRng: number;
  packetSequence: number;
  inputs: MatchInput[];
  events: MatchEvent[];
  players: { game: GameState; garbage: GarbageState; sent: number; eliminated: boolean; withdrawn: boolean; epoch: number }[];
}

export class Match {
  readonly roster: readonly string[];
  readonly firstTo: number;
  readonly width: number;
  readonly mode: "competitive" | "practice";
  readonly handlingByPlayer: Readonly<Record<string, Readonly<Handling>>>;
  private attacks = true;
  private players = new Map<string, Player>();
  private routing: Rng;
  private inputs: MatchInput[] = [];
  private events: MatchEvent[] = [];
  private outgoing: Packet[] = [];
  private packetSequence = 0;
  private points: number[];
  private roundNumber = 1;
  private roundSeed: number;
  private nextFrame = 0;
  private roundEnded = false;
  private setComplete = false;

  constructor(options: MatchOptions) {
    if (!Array.isArray(options.players) || options.players.length < 2
      || options.players.some(p => typeof p !== "string" || !p.length)
      || new Set(options.players).size !== options.players.length) throw new RangeError("Invalid roster");
    if (!Number.isSafeInteger(options.seed) || options.seed < -0x80000000 || options.seed > 0x7fffffff) {
      throw new RangeError("Seed must be a signed 32-bit integer");
    }
    this.width = options.width === undefined ? 10 : options.width;
    validateBoardWidth(this.width);
    this.firstTo = options.firstTo ?? 7;
    if (!Number.isSafeInteger(this.firstTo) || this.firstTo < 1) throw new RangeError("Invalid firstTo");
    this.roster = Object.freeze([...options.players].sort());
    this.mode = options.mode ?? "competitive";
    if (this.mode !== "competitive" && this.mode !== "practice") throw new RangeError("Invalid match mode");
    if (options.attacksEnabled !== undefined && typeof options.attacksEnabled !== "boolean") {
      throw new TypeError("Invalid attacksEnabled");
    }
    this.attacks = options.attacksEnabled ?? true;
    if (this.mode === "competitive" && !this.attacks) throw new RangeError("Competitive attacks must be enabled");
    if (options.handlingByPlayer !== undefined && (options.handlingByPlayer === null
      || typeof options.handlingByPlayer !== "object" || Array.isArray(options.handlingByPlayer)
      || Object.keys(options.handlingByPlayer).some(id => !this.roster.includes(id)))) {
      throw new RangeError("Invalid handling roster");
    }
    this.handlingByPlayer = Object.freeze(Object.fromEntries(this.roster.map(id => {
      const handling = Object.hasOwn(options.handlingByPlayer ?? {}, id) ? options.handlingByPlayer![id] : DEFAULT_HANDLING;
      validateHandling(handling);
      return [id, Object.freeze({ das: handling.das, arr: handling.arr, sddas: handling.sddas, sdarr: handling.sdarr })];
    })));
    this.points = this.roster.map(() => 0);
    this.roundSeed = options.seed;
    this.routing = new Rng(options.seed ^ 0x52a7e);
    this.createPlayers();
  }

  get frame(): number { return this.nextFrame; }
  get round(): number { return this.roundNumber; }
  get seed(): number { return this.roundSeed; }
  get ended(): boolean { return this.roundEnded; }
  get complete(): boolean { return this.setComplete; }
  get attacksEnabled(): boolean { return this.attacks; }
  get activePlayers(): readonly string[] { return this.roster.filter(id => !this.player(id).withdrawn); }
  get scores(): Readonly<Record<string, number>> {
    return Object.freeze(Object.fromEntries(this.roster.map((id, i) => [id, this.points[i]])));
  }

  /** Detached board view; administrative changes use the boundary methods. */
  playerState(id: string): GameState { return this.player(id).game.saveState(); }
  playerEpoch(id: string): number { return this.player(id).epoch; }

  private player(id: string): Player {
    const p = this.players.get(id);
    if (!p) throw new RangeError("Unknown player");
    return p;
  }

  private createPlayers(): void {
    for (const [index, id] of this.roster.entries()) {
      const previous = this.players.get(id);
      const game = this.createGame(id, 0);
      this.players.set(id, { game, garbage: new GarbageQueue(this.roundSeed ^ Math.imul(index + 1, 0x74ab3), this.width),
        sent: 0, eliminated: previous?.withdrawn ?? false, withdrawn: previous?.withdrawn ?? false,
        epoch: previous ? previous.epoch + 1 : 0 });
    }
  }

  private createGame(id: string, nowMs: number): Game {
    const game = new Game(this.roundSeed, 500, 5, this.handlingByPlayer[id], 0,
      p => this.settle(id, p.result), LEAGUE_LOCK, this.width);
    game.tick(nowMs);
    if (this.mode === "practice") game.setZen(true);
    return game;
  }

  private requirePractice(): void {
    if (this.mode !== "practice") throw new Error("Practice operation in competitive match");
  }

  setAttacksEnabled(enabled: boolean): void {
    this.requirePractice();
    if (typeof enabled !== "boolean") throw new TypeError("Invalid attacksEnabled");
    if (enabled === this.attacks) return;
    this.attacks = enabled;
    this.events.push({ type: "attacksEnabled", round: this.round, atMs: this.frame * FRAME_MS, enabled });
  }

  /** Clear held and queued controls without evaluating the next frame's boundary. */
  releaseControls(id?: string): void {
    const ids = id === undefined ? this.roster : [id];
    for (const player of ids) this.player(player);
    for (const player of ids) {
      this.player(player).game.setHandling(this.handlingByPlayer[player]);
      this.events.push({ type: "controlsReleased", round: this.round, atMs: this.frame * FRAME_MS, player });
    }
    this.inputs = this.inputs.filter(input => !ids.includes(input.player));
  }

  practiceUndo(id: string): boolean {
    this.requirePractice();
    const p = this.player(id);
    if (p.game.undoCount === 0) return false;
    const undone = p.game.undo(this.frame * FRAME_MS);
    if (!undone) return false;
    this.inputs = this.inputs.filter(input => input.player !== id);
    p.epoch++;
    p.game.drainEvents();
    this.events.push({ type: "practiceUndo", round: this.round, atMs: this.frame * FRAME_MS, player: id, epoch: p.epoch });
    return true;
  }

  practiceReset(id: string): void {
    this.requirePractice();
    const p = this.player(id);
    const nowMs = this.frame * FRAME_MS;
    for (const packet of p.garbage.packets) this.discard(packet, nowMs);
    p.garbage.packets.length = 0;
    p.game = this.createGame(id, nowMs);
    p.epoch++;
    this.inputs = this.inputs.filter(input => input.player !== id);
    this.events.push({ type: "practiceReset", round: this.round, atMs: nowMs, player: id, epoch: p.epoch });
  }

  forfeit(id: string): void {
    if (this.mode !== "competitive") throw new Error("Forfeit requires competitive mode");
    const p = this.player(id);
    if (p.withdrawn) return;
    this.releaseControls(id);
    p.withdrawn = p.eliminated = true;
    const atMs = this.frame * FRAME_MS;
    for (const packet of p.garbage.packets) this.discard(packet, atMs);
    p.garbage.packets.length = 0;
    this.events.push({ type: "forfeit", round: this.round, atMs, player: id });
    if (!this.roundEnded) this.finishFrame(atMs, "forfeit");
    else if (this.activePlayers.length <= 1) {
      this.setComplete = true;
      this.events.push({ type: "setEnd", round: this.round, atMs,
        winner: this.activePlayers[0] ?? null, reason: this.activePlayers.length ? "forfeit" : "aborted" });
    }
  }

  submit(input: MatchInput): void {
    const p = this.player(input.player);
    if (p.withdrawn || input.epoch !== undefined && input.epoch !== p.epoch
      || this.roundEnded || !validInput(input, this.nextFrame)
      || this.inputs.some(i => i.frame === input.frame && i.order === input.order)) {
      throw new RangeError("Invalid, late, or duplicate input");
    }
    this.inputs.push({ player: input.player, frame: input.frame, subframe: input.subframe,
      order: input.order, input: input.input, epoch: p.epoch });
    this.inputs.sort(compareInputs);
  }

  /** Process complete half-open frames; a deadline at the right edge belongs to the next frame. */
  advanceToFrame(frame: number): void {
    if (!Number.isSafeInteger(frame) || frame < this.nextFrame) throw new RangeError("Invalid frame");
    while (this.nextFrame < frame && !this.roundEnded) {
      const end = (this.nextFrame + 1) * FRAME_MS;
      for (;;) {
        const input = this.inputs[0];
        if (input && (input.frame < this.nextFrame || !hasFrameTimestamp(input))) {
          throw new RangeError("Stale or unrepresentable queued input");
        }
        const inputAt = input?.frame === this.nextFrame ? inputTime(input) : Infinity;
        let deadline = Infinity;
        for (const p of this.players.values()) if (!p.withdrawn) deadline = Math.min(deadline, p.game.nextStepAt);
        const at = Math.min(inputAt, deadline);
        if (at >= end) break;
        // Deadlines precede inputs at the same time. Stable roster breaks deadline ties.
        for (const p of this.players.values()) {
          if (!p.withdrawn && p.game.nextStepAt <= at) p.game.tick(at);
        }
        if (inputAt === at) {
          this.inputs.shift();
          const p = this.player(input.player);
          if (!p.withdrawn && input.epoch === p.epoch) p.game.apply(input.input, at);
        }
      }
      this.flushOutgoing(end);
      this.finishFrame(end);
      for (const p of this.players.values()) p.game.drainEvents();
      this.nextFrame++;
    }
  }

  private settle(id: string, result: LockResult): readonly number[] {
    const p = this.player(id);
    this.events.push({ type: "lock", round: this.round, atMs: result.atMs, player: id, epoch: p.epoch, result });
    let target: string | undefined;
    const { holes, records } = settlePlacement(p, result, this.attacks, attack => {
      if (target === undefined) {
        const opponents = this.roster.filter(other => other !== id && !this.player(other).withdrawn && !this.player(other).game.topOut);
        if (!opponents.length) return false;
        target = opponents[this.routing.nextBelow(opponents.length)];
      }
      const packet: Packet = { id: ++this.packetSequence, from: id, to: target, lines: attack.lines, kind: attack.kind,
        atMs: result.atMs, eligibleAtMs: result.atMs + GARBAGE_DELAY_MS };
      this.outgoing.push(packet);
      this.events.push({ type: "send", round: this.round, atMs: result.atMs, packet: { ...packet } });
      return true;
    });
    this.events.push(...records.map(record => ({ ...record, player: id, round: this.round, atMs: result.atMs })));
    return holes;
  }

  private flushOutgoing(atMs: number): void {
    // Reconcile the entire frame before enqueueing either direction. Packet order survives partial offsets.
    for (let i = 0; i < this.outgoing.length; i++) {
      const a = this.outgoing[i];
      for (let j = 0; a.lines && j < i; j++) {
        const b = this.outgoing[j];
        if (a.from !== b.to || a.to !== b.from || !b.lines) continue;
        const lines = Math.min(a.lines, b.lines);
        a.lines -= lines;
        b.lines -= lines;
        this.events.push({ type: "crossCancel", round: this.round, atMs, packets: [b.id, a.id], lines });
      }
    }
    for (const packet of this.outgoing) {
      if (!packet.lines) continue;
      if (this.player(packet.to).withdrawn || this.player(packet.to).game.topOut) this.discard(packet, atMs);
      else {
        this.player(packet.to).garbage.packets.push(packet);
        this.events.push({ type: "queue", round: this.round, atMs, packet: { ...packet } });
      }
    }
    this.outgoing = [];
  }

  private discard(packet: Packet, atMs: number): void {
    this.events.push({ type: "discard", round: this.round, atMs, packet: packet.id, lines: packet.lines });
  }

  private finishFrame(atMs: number, reason?: "forfeit"): void {
    if (this.mode === "practice") return;
    for (const [id, p] of this.players) {
      if (!p.game.topOut || p.eliminated) continue;
      p.eliminated = true;
      for (const packet of p.garbage.packets) this.discard(packet, atMs);
      p.garbage.packets.length = 0;
      this.events.push({ type: "eliminated", round: this.round, atMs, player: id });
    }
    const living = this.roster.filter(id => !this.player(id).eliminated);
    if (living.length > 1) return;
    const winner = living[0] ?? null;
    if (winner !== null) {
      const index = this.roster.indexOf(winner);
      this.setComplete = ++this.points[index] >= this.firstTo;
    }
    const eligible = this.activePlayers;
    this.setComplete ||= eligible.length <= 1;
    this.roundEnded = true;
    this.inputs = [];
    this.events.push({ type: "roundEnd", round: this.round, atMs, winner, complete: this.complete,
      reason: reason ?? (winner === null ? "draw" : "survivor") });
    if (this.complete) this.events.push({ type: "setEnd", round: this.round, atMs,
      winner: eligible.length <= 1 ? eligible[0] ?? null : winner,
      reason: eligible.length === 0 ? "aborted" : eligible.length === 1 ? "forfeit" : "firstTo" });
  }

  nextRound(seed: number): void {
    if (this.mode === "practice" || !this.roundEnded || this.complete) throw new Error("Round cannot start");
    if (!Number.isSafeInteger(seed) || seed < -0x80000000 || seed > 0x7fffffff || seed === this.seed) {
      throw new RangeError("Next round requires a new signed seed");
    }
    this.roundNumber++;
    this.roundSeed = seed;
    this.nextFrame = 0;
    this.roundEnded = false;
    this.routing = new Rng(seed ^ 0x52a7e);
    this.createPlayers();
  }

  drainEvents(): MatchEvent[] {
    const events = this.events;
    this.events = [];
    return structuredClone(events);
  }

  saveState(): MatchState {
    const snapshot: MatchState = structuredClone({ version: MATCH_VERSION, garbageProfile: GARBAGE_PROFILE,
      roster: [...this.roster], firstTo: this.firstTo, width: this.width, round: this.round, seed: this.seed,
      mode: this.mode, attacksEnabled: this.attacks, handlingByPlayer: this.handlingByPlayer,
      frame: this.frame, ended: this.ended, complete: this.complete, scores: this.points,
      routingRng: this.routing.save(), packetSequence: this.packetSequence, inputs: this.inputs, events: this.events,
      players: this.roster.map(id => {
        const p = this.player(id);
        return { game: p.game.saveState(), garbage: p.garbage.saveState(), sent: p.sent, eliminated: p.eliminated,
          withdrawn: p.withdrawn, epoch: p.epoch };
      }) });
    this.roster.forEach((id, i) => copyBoardEdges(this.player(id).game.board, snapshot.players[i].game.board));
    return snapshot;
  }

  /** Trusted controller checkpoint, not a client protocol. Core states are validated by Game. */
  static fromState(state: MatchState): Match {
    if (state.version !== MATCH_VERSION || state.garbageProfile !== GARBAGE_PROFILE) {
      throw new RangeError("Unsupported MatchState");
    }
    const s = structuredClone(state);
    if (!Number.isSafeInteger(s.frame) || s.frame < 0 || !Array.isArray(s.inputs)) {
      throw new RangeError("Invalid checkpoint clock or inputs");
    }
    if ((s.mode !== "competitive" && s.mode !== "practice") || typeof s.attacksEnabled !== "boolean"
      || !s.handlingByPlayer || s.roster.some(id => !Object.hasOwn(s.handlingByPlayer, id))) {
      throw new RangeError("Invalid checkpoint mode or handling");
    }
    const match = new Match({ players: s.roster, firstTo: s.firstTo, seed: s.seed,
      mode: s.mode, attacksEnabled: s.attacksEnabled, handlingByPlayer: s.handlingByPlayer, width: s.width === undefined ? 10 : s.width });
    if (s.players.length !== match.roster.length || s.scores.length !== match.roster.length
      || s.roster.some((id, i) => id !== match.roster[i])) throw new RangeError("Invalid checkpoint roster");
    match.roundNumber = s.round;
    match.nextFrame = s.frame;
    match.roundEnded = s.ended;
    match.setComplete = s.complete;
    match.points = s.scores;
    match.routing.restore(s.routingRng);
    match.packetSequence = s.packetSequence;
    match.events = s.events;
    for (const [i, id] of match.roster.entries()) {
      const p = s.players[i];
      if (!Number.isSafeInteger(p.epoch) || p.epoch < 0 || typeof p.withdrawn !== "boolean") {
        throw new RangeError("Invalid player epoch or eligibility");
      }
      if (p.withdrawn && !p.eliminated || p.game.zenEnabled !== (match.mode === "practice")
        || match.mode === "practice" && (p.withdrawn || p.eliminated || s.ended || s.complete || s.scores[i] !== 0)) {
        throw new RangeError("Checkpoint mode and player state differ");
      }
      if ((p.game.config.width ?? 10) !== match.width || (p.garbage.hole !== null && (p.garbage.hole < 0 || p.garbage.hole >= match.width))) throw new RangeError("Checkpoint width differs");
      for (const key of ["das", "arr", "sddas", "sdarr"] as const) {
        if (p.game.config.handling[key] !== match.handlingByPlayer[id][key]) throw new RangeError("Checkpoint handling differs");
      }
      copyBoardEdges(state.players[i].game.board, p.game.board);
      match.players.set(id, { game: Game.fromState(p.game, placement => match.settle(id, placement.result)),
        garbage: GarbageQueue.fromState(p.garbage, match.width), sent: p.sent, eliminated: p.eliminated,
        withdrawn: p.withdrawn, epoch: p.epoch });
    }
    for (const input of s.inputs) match.submit(input);
    return match;
  }
}
