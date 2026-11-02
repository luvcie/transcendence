import { FRAME_MS, Game, validateHandling, type Attack, type GameState, type Handling, type LockResult } from "@42tris/core";
import { compareInputs, hasFrameTimestamp, inputTime, validInput } from "./clock";
import { GARBAGE_PROFILE, GarbageQueue, type GarbageState, type QueueRecord } from "./garbage";
import { MATCH_VERSION, type MatchInput, type MatchState } from "./match";
import { settlePlacement } from "./placement";

type PredictionDetail =
  | { type: "lock"; result: LockResult }
  | { type: "outgoing"; attack: Attack }
  | { type: "discard"; packet: number; lines: number }
  | QueueRecord;

export type PredictionEvent = { owner: string; round: number; epoch: number; atMs: number } & PredictionDetail;

/** Local ledger, not an authoritative MatchState or a server message. */
export interface OwnerPredictionState {
  owner: string;
  round: number;
  epoch: number;
  frame: number;
  atMs: number;
  mode: MatchState["mode"];
  attacksEnabled: boolean;
  eliminated: boolean;
  withdrawn: boolean;
  game: GameState;
  garbage: GarbageState;
  sent: number;
  inputs: MatchInput[];
}

export class OwnerPrediction {
  readonly owner: string;
  readonly round: number;
  readonly epoch: number;
  readonly mode: MatchState["mode"];
  readonly attacksEnabled: boolean;
  readonly handling: Readonly<Handling>;
  private game: Game;
  private ledger: { garbage: GarbageQueue; sent: number };
  private inputs: MatchInput[] = [];
  private events: PredictionEvent[] = [];
  private nextFrame: number;
  private nowMs: number;
  private consumedOrders = new Set<number>();
  private lastInput: MatchInput | null = null;
  private eliminated: boolean;
  private readonly withdrawn: boolean;
  private readonly stopped: boolean;
  private readonly hasRecipient: boolean;

  constructor(state: MatchState, owner: string) {
    if (state.version !== MATCH_VERSION || state.garbageProfile !== GARBAGE_PROFILE
      || !Number.isSafeInteger(state.frame) || state.frame < 0) throw new RangeError("Invalid prediction checkpoint");
    const index = state.roster.indexOf(owner);
    if (index < 0) throw new RangeError("Unknown prediction owner");
    const p = state.players[index];
    if (!p || !Number.isSafeInteger(p.epoch) || p.epoch < 0
      || (state.mode !== "practice" && state.mode !== "competitive") || typeof state.attacksEnabled !== "boolean") {
      throw new RangeError("Invalid prediction configuration");
    }
    const handling = state.handlingByPlayer[owner];
    validateHandling(handling);
    for (const key of ["das", "arr", "sddas", "sdarr"] as const) {
      if (handling[key] !== p.game.config.handling[key]) throw new RangeError("Checkpoint handling differs");
    }
    this.owner = owner;
    this.round = state.round;
    this.epoch = p.epoch;
    this.mode = state.mode;
    this.attacksEnabled = state.attacksEnabled;
    this.handling = Object.freeze({ ...handling });
    this.nextFrame = state.frame;
    this.nowMs = state.frame * FRAME_MS;
    if (p.game.state.observedNow > this.nowMs) throw new RangeError("Owner clock exceeds checkpoint boundary");
    this.withdrawn = p.withdrawn;
    this.eliminated = p.eliminated;
    this.stopped = state.ended || state.complete || p.withdrawn;
    // Snapshot eligibility only: never step an opponent to guess future targeting or death.
    this.hasRecipient = state.players.some((other, i) => i !== index && !other.withdrawn && !other.game.state.topOut);
    this.ledger = { garbage: GarbageQueue.fromState(p.garbage), sent: p.sent };
    this.game = Game.fromState(p.game, placement => this.settle(placement.result));
    for (const input of state.inputs) if (input.player === owner) this.submit(input);
  }

  get frame(): number { return this.nextFrame; }
  get atMs(): number { return this.nowMs; }

  submit(input: MatchInput): void {
    if (this.stopped || input.player !== this.owner || !validInput(input, this.frame)
      || input.epoch !== undefined && input.epoch !== this.epoch || inputTime(input) < this.nowMs
      || this.lastInput !== null && compareInputs(input, this.lastInput) <= 0
      || input.frame === this.frame && this.consumedOrders.has(input.order)
      || this.inputs.some(i => i.frame === input.frame && i.order === input.order)) {
      throw new RangeError("Invalid, stale, or duplicate prediction input");
    }
    this.inputs.push({ player: this.owner, frame: input.frame, subframe: input.subframe,
      order: input.order, input: input.input, epoch: this.epoch });
    this.inputs.sort(compareInputs);
  }

  /** Same half-open completed-frame boundary as Match.advanceToFrame. */
  advanceToFrame(frame: number): void {
    if (!Number.isSafeInteger(frame) || frame < this.frame || frame * FRAME_MS < this.nowMs) {
      throw new RangeError("Invalid prediction frame");
    }
    if (this.stopped) return;
    while (this.nextFrame < frame) {
      const end = (this.nextFrame + 1) * FRAME_MS;
      this.processUntil(end, false);
      this.finishFrame(end);
      this.nowMs = end;
      this.nextFrame++;
      this.consumedOrders.clear();
    }
  }

  /** Include deadlines and queued inputs at targetMs, without rounding up to a future frame. */
  advanceToTime(targetMs: number): void {
    if (!Number.isFinite(targetMs) || targetMs < this.nowMs
      || targetMs >= Number.MAX_SAFE_INTEGER * FRAME_MS) throw new RangeError("Invalid prediction time");
    if (this.stopped) return;
    while ((this.nextFrame + 1) * FRAME_MS <= targetMs) this.advanceToFrame(this.nextFrame + 1);
    this.processUntil(targetMs, true);
    this.game.tick(targetMs);
    this.game.drainEvents();
    this.nowMs = targetMs;
  }

  private processUntil(end: number, inclusive: boolean): void {
    for (;;) {
      const input = this.inputs[0];
      if (input && (input.frame < this.frame || !hasFrameTimestamp(input))) {
        throw new RangeError("Stale or unrepresentable prediction input");
      }
      const inputAt = input?.frame === this.frame ? inputTime(input) : Infinity;
      const at = Math.min(inputAt, this.game.nextStepAt);
      if (inclusive ? at > end : at >= end) break;
      if (this.game.nextStepAt <= at) this.game.tick(at);
      if (inputAt === at) {
        this.inputs.shift();
        this.consumedOrders.add(input.order);
        this.lastInput = input;
        this.game.apply(input.input, at);
      }
    }
  }

  private finishFrame(atMs: number): void {
    if (this.mode === "competitive" && this.game.topOut && !this.eliminated) {
      this.eliminated = true;
      for (const packet of this.ledger.garbage.packets) this.record({ type: "discard", packet: packet.id, lines: packet.lines }, atMs);
      this.ledger.garbage.packets.length = 0;
    }
    this.game.drainEvents();
  }

  private settle(result: LockResult): readonly number[] {
    this.record({ type: "lock", result }, result.atMs);
    const { holes, records } = settlePlacement(this.ledger, result, this.attacksEnabled, attack => {
      if (!this.hasRecipient) return false;
      this.record({ type: "outgoing", attack: { ...attack } }, result.atMs);
      return true;
    });
    for (const record of records) this.record(record, result.atMs);
    return holes;
  }

  private record(event: PredictionDetail, atMs: number): void {
    this.events.push({ ...event, owner: this.owner, round: this.round, epoch: this.epoch, atMs });
  }

  gameState(): GameState { return this.game.saveState(); }

  saveState(): OwnerPredictionState {
    return { owner: this.owner, round: this.round, epoch: this.epoch, frame: this.frame, atMs: this.atMs,
      mode: this.mode, attacksEnabled: this.attacksEnabled, eliminated: this.eliminated, withdrawn: this.withdrawn,
      game: this.game.saveState(), garbage: this.ledger.garbage.saveState(), sent: this.ledger.sent,
      inputs: this.inputs.map(input => ({ ...input })) };
  }

  drainEvents(): PredictionEvent[] {
    const events = this.events;
    this.events = [];
    return structuredClone(events);
  }
}
