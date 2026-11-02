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
  boards. Local play uses a standalone Game. Online Session owns transport, clock
  synchronization, pending inputs and prediction reconciliation; opponent boards
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

Preparation and a three-second countdown gate starts and reconnect resumes. During
an active-room disconnect, the server freezes the whole simulation, releases controls
and invalidates queued inputs. Each absent seat has a 40-second reservation. Opening
the online menu releases only local controls and leaves the room playing.

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
Handling stays frozen for a set.

Exact snapshots preserve simulation clocks, controls and RNG state, but omit Zen undo
history and settlement functions. Restore controllers explicitly and restore their
ledgers together. In-memory reconnect keeps the existing Match and its history;
checkpoint restoration does not recover earlier turns. Match checkpoints are trusted
controller data and must not be accepted as client commands.

Local play uses the one-second practice lock profile. Both competitive and practice
Match use the league lock profile. Online practice undo rewinds its board without
retracting sent attacks or restoring the external garbage ledger. These differences
are intentional contracts that contributors need to preserve.

## Browser views

`web/src/app-view.ts` selects the visible workspace from Solo or the current room
phase. Lobby and waiting views hide gameplay. Preparation, countdown, play,
reconnection and results retain the board stage. A lost socket keeps the last
checkpoint visible until the server supplies a replacement or ends the match.

`online-view.ts` keeps scores and next-round or rematch actions above gameplay.
The same player list and room settings nodes appear
inline while waiting and in a Room details dialog during a match. Only the host
can edit room settings, while waiting or after a set. Forms retain their values
and listeners when moved into the dialog. Leaving for Solo waits for the server's
leave acknowledgement before destroying the online session.

View changes update the navigation and focus the view heading, unless a menu is
open. Native controls retain their keyboard behavior. Closing a gameplay dialog
returns focus to the game. Menus and focus loss release online controls without
pausing the session; local play still pauses. CSS sizes boards from the remaining
gameplay area, preserving equal duel boards and a larger local board in groups.

See [core rules](../packages/core/RULES.md) for attacks, lock checkpoints and exact
restoration, and [match rules](../packages/match/RULES.md) for scheduling, garbage,
practice semantics, transport behavior and compatibility limits. The implementation
and existing package tests are the authority when these documents disagree.
