import { t, type Static } from "elysia";
import type { MatchEvent, MatchInput, MatchState } from "@42tris/match";

const integer = (minimum = 0, maximum = Number.MAX_SAFE_INTEGER) => t.Integer({ minimum, maximum });
const text = (maxLength: number) => t.String({ minLength: 1, maxLength });
const object = <T extends Record<string, import("elysia").TSchema>>(properties: T) => t.Object(properties, { additionalProperties: false });
export const NameSchema = t.String({ minLength: 1, maxLength: 24, pattern: "^[^<>\\x00-\\x1f\\x7f]+$" });
export const HandlingSchema = object({ das: t.Number({ minimum: 0, maximum: 20 }), arr: t.Number({ minimum: 0, maximum: 15 }), sddas: t.Number({ minimum: 0, maximum: 10 }), sdarr: t.Number({ minimum: 0, maximum: 4 }) });
export const RoomOptionsSchema = object({ firstTo: integer(1, 100), maxPlayers: t.Optional(integer(2, 8)), mode: t.Union([t.Literal("competitive"), t.Literal("practice")]), attacksEnabled: t.Boolean() });
export const InputItemSchema = object({ seq: integer(1), frame: integer(), subframe: t.Number({ minimum: 0, exclusiveMaximum: 1 }), input: t.Union([t.Literal(0), t.Literal(1), t.Literal(2), t.Literal(3), t.Literal(4), t.Literal(5), t.Literal(6), t.Literal(7), t.Literal(8), t.Literal(9), t.Literal(10)]) });
export const ClientCommandSchema = t.Union([
  object({ type: t.Literal("hello"), resumeToken: t.Optional(text(128)), guestProfileId: t.Optional(text(128)), name: NameSchema }),
  object({ type: t.Literal("rename"), name: NameSchema }),
  object({ type: t.Literal("create"), requestId: text(64), options: RoomOptionsSchema }),
  object({ type: t.Literal("configure"), options: RoomOptionsSchema }),
  object({ type: t.Literal("join"), code: t.String({ pattern: "^[A-HJ-NP-Z2-9]{6}$" }) }),
  object({ type: t.Literal("leave") }),
  object({ type: t.Literal("ready"), ready: t.Boolean(), handling: HandlingSchema }),
  object({ type: t.Literal("prepared"), matchId: text(64), preparationId: integer(1) }),
  object({ type: t.Literal("inputBatch"), matchId: text(64), generation: integer(), epoch: integer(), items: t.Array(InputItemSchema, { minItems: 1, maxItems: 32 }) }),
  object({ type: t.Literal("releaseControls") }),
  object({ type: t.Literal("practiceUndo") }),
  object({ type: t.Literal("practiceReset") }),
  object({ type: t.Literal("toggleAttacks"), enabled: t.Boolean() }),
  object({ type: t.Literal("ping"), nonce: text(64) }),
  object({ type: t.Literal("resync") }),
]);
export type ClientCommand = Static<typeof ClientCommandSchema>;
export type RoomOptions = Required<Static<typeof RoomOptionsSchema>>;
export type InputItem = Static<typeof InputItemSchema>;
export type RoomPhase = "waiting" | "preparing" | "countdown" | "playing" | "paused" | "roundResult" | "setResult";
export type ErrorCode = "INVALID_MESSAGE" | "HELLO_REQUIRED" | "ALREADY_CONNECTED" | "SESSION_EXPIRED" | "CAPACITY" | "RATE_LIMIT" | "ROOM_NOT_FOUND" | "ROOM_FULL" | "ROOM_BUSY" | "NOT_IN_ROOM" | "NOT_OWNER" | "WRONG_PHASE" | "INVALID_OPTIONS" | "STALE_INPUT" | "SEQ_GAP" | "SEQ_CONFLICT" | "SEQ_EXPIRED" | "INPUT_REJECTED" | "INTERNAL_ERROR";
export interface RoomState {
  code: string;
  revision: number;
  ownerId: string;
  options: RoomOptions;
  phase: RoomPhase;
  matchId: string | null;
  preparationId: number;
  startsAt: number | null;
  prepareDeadline: number | null;
  players: { playerId: string; name: string; connected: boolean; ready: boolean; prepared: boolean; deadline: number | null; withdrawn: boolean }[];
}
export interface InputAck {
  generation: number;
  epoch: number;
  nextSeq: number;
  resolvedThroughSeq: number;
  pendingAccepted: (InputItem & { order: number })[];
  rejections: { seq: number; code: ErrorCode }[];
}
export interface Checkpoint {
  type: "checkpoint";
  serverSequence: number;
  serverNow: number;
  room: RoomState;
  matchId: string | null;
  state: MatchState | null;
  owner: InputAck;
  clock: { currentTargetFrame: number; simulationNow: number; origin: number | null; pausedTotal: number; commitDelayMs: 100; frozen: boolean };
  events: { sequence: number; event: MatchEvent }[];
}
export type ServerMessage =
  | { type: "welcome"; guestSessionId: string; playerId: string; resumeToken: string; name: string; room: RoomState | null; generation: number; serverNow: number }
  | Checkpoint
  | { type: "roomState"; room: RoomState; serverNow: number; requestId?: string }
  | { type: "left" }
  | { type: "error"; code: ErrorCode; message: string; requestId?: string }
  | { type: "pong"; nonce: string; serverNow: number };
const nullableTime = t.Union([t.Number(), t.Null()]);
const nullableId = t.Union([t.String(), t.Null()]);
export const RoomStateSchema = object({
  code: t.String(), revision: integer(), ownerId: t.String(), options: RoomOptionsSchema,
  phase: t.Union([t.Literal("waiting"), t.Literal("preparing"), t.Literal("countdown"), t.Literal("playing"), t.Literal("paused"), t.Literal("roundResult"), t.Literal("setResult")]),
  matchId: nullableId, preparationId: integer(), startsAt: nullableTime, prepareDeadline: nullableTime,
  players: t.Array(object({ playerId: t.String(), name: t.String(), connected: t.Boolean(), ready: t.Boolean(), prepared: t.Boolean(), deadline: nullableTime, withdrawn: t.Boolean() })),
});
// Simulation checkpoints/events are trusted Match output. Only transport envelopes
// are validated here; Match owns the versioned nested simulation format.
const matchState = t.Unsafe<MatchState>(t.Object({ version: integer(), roster: t.Array(t.String()), frame: integer() }, { additionalProperties: true }));
const matchEvent = t.Unsafe<MatchEvent>(t.Object({ type: t.String(), round: integer(), atMs: t.Number() }, { additionalProperties: true }));
export const ServerMessageSchema = t.Unsafe<ServerMessage>(t.Union([
  object({ type: t.Literal("welcome"), guestSessionId: t.String(), playerId: t.String(), resumeToken: t.String(), name: t.String(), room: t.Union([RoomStateSchema, t.Null()]), generation: integer(), serverNow: t.Number() }),
  object({ type: t.Literal("checkpoint"), serverSequence: integer(), serverNow: t.Number(), room: RoomStateSchema, matchId: nullableId,
    state: t.Union([matchState, t.Null()]),
    owner: object({ generation: integer(), epoch: integer(), nextSeq: integer(1), resolvedThroughSeq: integer(),
      pendingAccepted: t.Array(object({ ...InputItemSchema.properties, order: integer() })), rejections: t.Array(object({ seq: integer(1), code: t.String() })) }),
    clock: object({ currentTargetFrame: integer(), simulationNow: t.Number(), origin: nullableTime, pausedTotal: t.Number(), commitDelayMs: t.Literal(100), frozen: t.Boolean() }),
    events: t.Array(object({ sequence: integer(1), event: matchEvent })),
  }),
  object({ type: t.Literal("roomState"), room: RoomStateSchema, serverNow: t.Number(), requestId: t.Optional(t.String()) }),
  object({ type: t.Literal("left") }),
  object({ type: t.Literal("error"), code: t.String(), message: t.String(), requestId: t.Optional(t.String()) }),
  object({ type: t.Literal("pong"), nonce: t.String(), serverNow: t.Number() }),
]));
export type { MatchState, MatchInput, MatchEvent };
