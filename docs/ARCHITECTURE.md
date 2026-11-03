# Architecture

42tris shares its simulation between the Bun server and browser. Transport and
rendering sit outside that simulation. This keeps gameplay reproducible from seeds,
configuration and ordered inputs while the server decides which inputs are accepted.

## Package boundaries

- **[core](../packages/core/)** owns one board: pieces, movement, rotation, gravity,
  lock timing, clear/attack calculation, snapshots and Zen history. It has no network,
  room, player identity or attack-routing dependency. Its synchronous placement
  settlement callback lets a controller cancel attacks and supply incoming garbage
  before the next piece spawns.
- **[match](../packages/match/)** depends on core. It interleaves all players' deadlines
  and inputs, owns garbage queues and RNG streams, and resolves rounds and sets.
  `OwnerPrediction` advances only the owner's board and known incoming queue using
  the same placement and garbage helpers as authoritative Match.
- **[protocol](../packages/protocol/)** defines client-command validation, server-message
  envelopes and shared types. Its `/client` entry point constructs the Eden client
  with a type-only reference to the server's `App`; it does not import server runtime
  code into the browser. Nested Match checkpoints are trusted simulation output,
  not a complete arbitrary-JSON validation schema.
- **[server](../packages/server/)** connects Elysia WebSockets to rooms and live Match
  instances. It owns guest credentials, input admission and acknowledgements, room
  phases, wall-clock scheduling, reconnect policy and checkpoints. In production it
  also serves the Vite build. State is held in one process with no durable storage
  or coordination between server instances.
- **[web](../packages/web/)** maps physical keys to core inputs and renders Canvas
  boards. Local play uses a standalone Game through the singleplayer controller.
  Online Session owns transport, clock synchronization, pending inputs and
  prediction reconciliation; opponent boards
  come from authoritative snapshots. UI and skin state do not decide game outcomes.

## Gameplay flow

1. The browser timestamps an online input in round-relative frame/subframe time,
   queues its sequence number, and predicts the owner's response immediately.
2. Eden sends batches through `/ws`. Protocol validation bounds their shape; the
   server binds them to the guest seat, checks match/generation/epoch and sequence,
   rejects invalid timing, and assigns authoritative order.
3. The server advances Match through complete frames with a 100ms commit delay.
   Match runs core deadlines before equal-time inputs. At each lock, core calculates
   the clear, Match settles cancellation and incoming rows, and core spawns the next
   piece. Match reconciles crossing outgoing attacks and deaths at frame end.
4. Checkpoints carry Match state, clock data, input dispositions and recent events.
   Session replaces owner prediction and replays only unresolved inputs absent from
   the accepted backlog. Canvas renders that prediction and opponents' snapshots.

Input admission allows frames through
`floor(simulationNow / FRAME_MS) + ceil(MAX_INPUT_LEAD_MS / FRAME_MS) + 2`,
where the protocol constant `MAX_INPUT_LEAD_MS = 250` is an upper admission
allowance in milliseconds. `simulationNow` is the current round-relative server
clock, excluding pauses, rather than the committed Match frame. Inputs below the
committed frame are still rejected, and each seat retains its 128-input pending
cap. Accepted future inputs wait in Match's queue until server-paced advancement
processes their stamped frame; they never execute early or advance the clock.
Default clients use no additional lead. N3-B will introduce optional client-side
lead; deploy this server allowance before enabling N3-B in production.

Preparation and a three-second countdown gate starts and reconnect resumes. During
an active-room disconnect, the server freezes the whole simulation, releases controls
and invalidates queued inputs. Each absent seat has a 40-second reservation. Opening
the online menu releases only local controls and leaves the room playing.

Each 20 Hz checkpoint broadcast builds one detached shared snapshot, including one
`Match.saveState()` call. Per-seat input acknowledgements and globally increasing
server sequences are added separately. Resync, release and input acknowledgements
use the same snapshot builder. Checkpoints retain one ordinary recent event and
the latest relevant current-round `roundEnd` and `setEnd`, in sequence order.
Results survive a paused result countdown and disappear on the next round or
rematch. The room's existing 256-event history, aborted-set filtering and full
competitive recorder journal are unchanged. Input-triggered checkpoints keep
their existing cadence; N2-B3 coalescing is deferred. See the
[checkpoint measurements](NETPLAY-CHECKPOINTS.md) for the retention choice and limits.

## Network instrumentation

Browser diagnostics are opt-in (`?diagnostics`); server metrics require
`NETPLAY_METRICS=1`. They observe clock estimates, received application bytes,
control availability and existing input admission without changing simulation,
recovery, protocol payloads or journals. The fake-time harness supplies transport,
clock and entropy while exercising real Sessions, Rooms, Match and MatchRecorder
for 2–8 players. Measurement scopes and limitations are specified in the
[diagnostics guide](NETPLAY-DIAGNOSTICS.md).

## Invariants for changes

Keep core and match independent of wall clocks, browser APIs and transport arrival
batches. Core timestamps must be finite, nonnegative and monotonic. Match inputs
retain subframe precision; global deadline order and complete-frame delivery affect
garbage and simultaneous deaths. Do not step each board through a whole coarse tick
independently or move attack delivery into the renderer.

The server owns accepted inputs, routing, scores, undo/reset and forfeits. Predicted
outgoing events are informational and never become attack claims. Connection generation
invalidates buffered network controls; board epoch invalidates inputs after undo,
reset or round changes. Reconciliation must respect both, plus match and round identity.
Handling and board width stay frozen for a set. Room settings supply the width to Match, and core and match checkpoints retain it for restoration and prediction.

Exact snapshots preserve simulation clocks, controls and RNG state, but omit Zen undo
history and settlement functions. Restore controllers explicitly and restore their
ledgers together. In-memory reconnect keeps the existing Match and its history;
checkpoint restoration does not recover earlier turns. Match checkpoints are trusted
controller data and must not be accepted as client commands.

Local play uses the one-second practice lock profile. Both competitive and practice
Match use the league lock profile. Both profiles share the same per-piece 15-reset
budget and 3,000ms grounded lifetime; only their normal lock delay differs.
Online practice undo rewinds its board without
retracting sent attacks or restoring the external garbage ledger. These differences
are intentional contracts that contributors need to preserve.

## Browser views

`web/src/app-view.ts` selects the homepage, local gameplay or current room phase.
Normal entry creates no Game. Invitation links and reserved sessions enter online
play directly. The homepage doubles as singleplayer mode selection; its mode list
can grow without adding navigation tabs. Lobby and waiting views hide gameplay.
Preparation, countdown, play,
reconnection and results retain the board stage. A lost socket keeps the last
checkpoint visible until the server supplies a replacement or ends the match.

`online-view.ts` keeps scores and next-round or rematch actions above gameplay.
The same player list and room settings nodes appear
inline while waiting and in a Room details dialog during a match. Only the host
can edit room settings, while waiting or after a set. Forms retain their values
and listeners when moved into the dialog. Opening the homepage keeps the online
session alive, even across room phase changes. Starting a local mode waits for the server's leave acknowledgement before
destroying the online session; active matches retain the existing forfeit prompt.
Leaving an active local game asks for confirmation. Zen pauses during the prompt;
Sprint continues running.

View changes update the navigation and focus the view heading, unless a menu is
open. Native controls retain their keyboard behavior. Closing a gameplay dialog
returns focus to the game. Menus and focus loss release online controls without
pausing the session; Zen pauses, while settings are unavailable during Sprint. CSS sizes boards from the remaining
gameplay area, preserving equal duel boards and a larger local board in groups.

See [core rules](../packages/core/RULES.md) for attacks, lock checkpoints and exact
restoration, and [match rules](../packages/match/RULES.md) for scheduling, garbage,
practice semantics, transport behavior and compatibility limits. The implementation
and existing package tests are the authority when these documents disagree.

## Singleplayer modes and Sprint timing

`web/src/singleplayer.ts` owns the selected mode, Game configuration, local clock
and terminal Sprint result. Mode definitions select undo, line target and whether
play waits for input. Zen uses the saved width and enables core history; Sprint
creates a fresh 10-wide Game with history disabled. The obsolete `42tris.zen`
preference is removed on startup. Online practice remains controlled by Session
and Match, independently of local mode selection.

Sprint initializes core at time zero and waits without advancing gravity until
the first gameplay press. Browser samples are mapped to attempt-relative
milliseconds using a clock anchor. Sprint cannot pause; Zen pauses re-anchor its clock
without adding elapsed time.
Core and inputs use that same timeline. Advancement visits `Game.nextStepAt`
deadlines in order and drains events after each step and input. The first lock
whose cumulative lines reach 40 supplies the exact `LockResult.atMs`; advancement
stops there even when a render callback arrives much later. Top-out freezes a
failed result at its input or simulation deadline. Winning clears take precedence
if the following spawn also tops out. No render timestamp becomes the recorded
completion time. Results copy statistics and finesse and remain frozen until an
explicit retry creates a fresh controller and seed.

Both local modes retain the practice lock profile. No engine timing or multiplayer
scheduling contract changes. This attempt-relative input/event timeline and fresh
configuration are suitable inputs for future replay recording; recording, result
persistence and leaderboard validation are not implemented.

Zen automatically restarts after top-out using a new deterministic seed. The
controller retains that board for undo until the replacement's first placement;
undo can restore it with core's existing timer rebasing and released controls.
Explicit restart and mode changes discard both histories. Sprint creates neither
practice history nor a previous-board reference, and its controller rejects undo
before calling core.

### Competitive replay retrieval (M3-B1)

`GET /api/rooms/:code/replay` accepts `Authorization: Bearer <resumeToken>`.
Use the token from the WebSocket `welcome` message (the browser session stores it
under `42tris.resume`). Tokens belong in the header, never the URL. There are no
public replay links, cookies, new credentials, or permanent replay storage.

| HTTP | Body | Meaning |
| --- | --- | --- |
| 200 | Original competitive `MatchReplay` JSON | Completed and deterministically verified |
| 202 | `{"status":"pending"}` | Set completed; recorder is still sealing/verifying |
| 409 | `{"status":"failed"}` | Recorder exceeded a resource limit or failed verification |
| 404 | `{"status":"unavailable"}` | No completed artifact, abandoned recording, practice mode, missing/expired room |
| 403 | `{"status":"unauthorized"}` | Missing/invalid session token or ineligible seat |

Every response uses `Cache-Control: no-store` and `Vary: Authorization`. Non-200
status envelopes are described by `ReplayAccessStatusSchema` in the protocol.
Missing credentials always return 403; a recognized session requesting a missing
room receives 404. An unrelated session cannot read an existing room's artifact
or its recording status.

Authorization resolves the existing opaque resume token to its server-owned Seat,
requires that Seat still belong to this Room, and checks its ID against the
current Match's immutable original roster. Room codes, guest profile IDs and
client-supplied player IDs prove nothing. Joining after a set finishes does not
grant access. Reconnect retains the Seat ID and token; disconnected participants
can retrieve during their existing 40-second reservation. Leaving or expiry of
that reservation revokes access. A returning original Seat that rejoins the same
room remains an original participant; a replacement Seat has a new ID and cannot
inherit access. Token secrecy remains the existing guest-session security boundary;
anyone holding a participant's bearer token has that participant's authority.

Retrieval only reads the current recorder's cached JSON, which has already passed
the strict decoder, byte/resource limits and deterministic execution verification.
It does not call `finish`, construct a recorder, or run verification. Incomplete
journals are never returned. Both room configuration and Match mode must be
competitive, so changing the lobby to practice also hides a retained competitive
artifact. Practice never creates a recorder. Replay journals stay out of routine
checkpoints and broadcasts.

A new set replaces the recorder and Match ID during `Rooms.prepare(room, false)`;
completion of an older recorder cannot restore access to its artifact. Existing
room cleanup drops it after 60 seconds empty or 15 minutes idle in a result/lobby
phase. Requests enforce those same room expiry conditions even before the next
scheduler tick. No retrieval extends room or session lifetime.

M3-B2 should issue this GET from the browser and pass a successful JSON body to
`MatchPlayback.create`. It can request again on demand after a pending response;
M3-B1 adds no polling or broadcast infrastructure and no viewer UI. If the browser
uses a separate development origin, use its existing same-origin `/api` proxy;
this endpoint does not enable cross-origin credential access.

For original appearance, capture a detached, immutable map of
`playerId -> selected built-in skin ID` in the non-resume branch of
`Rooms.prepare`, alongside the initial Match roster and before any later skin
changes or reconnects. Key it by that exact roster, retain it with that set's
artifact, authorize it identically, and replace/drop it with the recorder. Do not
read mutable Seat skins at retrieval time. This presentation metadata belongs
outside MatchState, replay journals and replay digests. Capturing and returning
it is deferred to M3-B2.
