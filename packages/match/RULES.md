# Shared versus simulation

`@42tris/match` runs authoritative games from ordered inputs. Match version 3 uses
`42tris-league-garbage-v1`, core's exported `LEAGUE_LOCK` and the core attack profile.
Core's lock profile budgets 15 resets per piece and caps grounded lifetime at 3,000ms;
match scheduling and inputs are unchanged. It is a 42tris simulation with pinned League
rules, not a TETR.IO replay emulator.

```ts
import { Input } from "@42tris/core";
import { Match } from "@42tris/match";

const match = new Match({ players: ["alice", "bob"], seed: 108, firstTo: 7 });
match.submit({ player: "alice", frame: 0, subframe: 0.25, order: 0, input: Input.HardDrop });
match.advanceToFrame(60); // Process frames [0, 60).
const events = match.drainEvents();
const checkpoint = JSON.parse(JSON.stringify(match.saveState()));
const resumed = Match.fromState(checkpoint);
```

## Clock and ordering

One frame is `1000 / 60` milliseconds. Inputs retain a subframe in `[0, 1)`.
`order` is a controller-assigned nonnegative integer, unique within the frame.
Inputs sort by frame, subframe, then order. Submit all inputs for a frame before
advancing past it. Late inputs, duplicate orders and unknown players throw.
The converted millisecond timestamp must remain inside its half-open frame.
Subframes that round to the right edge are rejected before mutation, even if less
than one. Restored input backlogs receive the same validation. The scheduler throws
on a stale or unrepresentable queue head rather than blocking later inputs silently.
The transport must authenticate player IDs and assign ordering; this package has
no network authority or rollback policy.

Inputs can carry `epoch: match.playerEpoch(player)`. Submission rejects a supplied
stale epoch. Omitted epochs bind to the current board at submission, for local
callers. A network adapter must require the epoch supplied by its client; attaching
the latest epoch to an old network input would defeat stale-input rejection.

Internal deadlines run before inputs at the same timestamp. Sorted player IDs
break deadline ties. The scheduler always advances the earliest deadline across
all games. A deadline exactly at a frame's right boundary belongs to the next frame.
Input timestamps, rather than arrival batches or render calls, determine the result.

Complete-frame commits group deaths and reconcile crossing attacks. Running one
player's entire coarse tick first would reorder attacks and garbage insertion.
This frame boundary does not quantize input times; core deadlines and inputs retain
their fractional milliseconds. Garbage eligibility uses the actual lock timestamp.

## Configuration and boundary controls

`mode` defaults to `"competitive"`; `"practice"` enables undo and reset. Both modes
use the shared league lock profile and the same piece seed for each player.
`handlingByPlayer` accepts partial player-ID mappings of full core `Handling` values.
Missing players use `DEFAULT_HANDLING`. Unknown IDs and invalid handling throw.
The constructor copies and freezes each configuration for the entire set.
Changing the caller's options cannot change a running board. Restoring a checkpoint
rejects a board whose handling differs from its frozen player configuration.

The following methods run between `advanceToFrame` calls, at a completed-frame
boundary. Their event timestamp is `match.frame * FRAME_MS`, including zero.

| API | Result |
| --- | --- |
| `practiceUndo(player): boolean` | Undo one core turn; false when no history exists. |
| `practiceReset(player): void` | Replace that board, discard its pending incoming queue and queued inputs. |
| `setAttacksEnabled(enabled): void` | Enable or disable new outgoing practice attacks. |
| `releaseControls(player?): void` | Release one player's held controls and discard their queued inputs; omit the ID for everyone. |
| `forfeit(player): void` | Withdraw a competitive seat for the rest of the set. |

`releaseControls` reapplies the frozen handling at the board's latest observed
timestamp. It releases held directions and soft drop without processing the next
frame's boundary, rebasing gravity, resetting the board or advancing the match.
The server can use it when entering a room pause. The server must also invalidate
buffered network inputs and resynchronize physical key state on resume. Match does
not advance from wall-clock time; the server enforces the 40-second pause policy.

## Practice

Practice has no scoring, elimination, round end or set completion. A topped-out
board remains available for undo/reset; other players continue. Topped-out boards
are excluded from new target selection. Existing pending garbage remains queued.
`nextRound` and competitive `forfeit` are unavailable in practice.

`attacksEnabled` defaults to true. False suppresses new outgoing packets, but core
still computes attacks and local statistics. Defense still cancels the sender's
incoming queue. Already queued attacks remain eligible for insertion. Turning
attacks back on permits future placements to send normally. Competitive mode rejects
disabled attacks and the practice toggle method.

Undo calls core's `undo` at the current boundary. It can rewind received garbage
on the board when the restored turn predates insertion. It does not restore the
external garbage queue, hole RNG, routing RNG or sent ledger. Previously inserted
garbage is not queued again, and already sent attacks remain at their recipients.
The sent count remains monotonic across undo/reset. Replaying an undone turn is a
new placement, with a new event sequence and permission to send again.

A successful undo increments the player's board epoch and discards their queued
inputs. A failed undo changes nothing. Reset also increments the epoch, clears
history, and creates a board with the round's piece seed and frozen profile/handling.
The new `Game` starts with `tick(frame * FRAME_MS)`, so its gravity phase starts at
that boundary rather than at zero. Reset preserves the recipient's hole/RNG state,
but discards all pending incoming packets without treating them as cancellations.
It leaves other boards, queued inputs for other players and previously sent attacks
unchanged. Reset and undo events identify the new epoch; lock events identify the
epoch that produced the placement.

## Garbage

Core generates ordered attack packets. No match input supplies an attack amount,
board, target, score or garbage claim. `playerState()` returns a detached view.

At each placement, each attack packet first cancels the sender's existing incoming
queue FIFO, including packets that have not reached their insertion time. During
placements 1 through 14, pending lines greater than or equal to total lines sent
grant an extra defensive budget equal to that attack packet. The normal budget is
spent first. Remaining defensive budget is discarded; it never becomes outgoing.
The condition is reevaluated for each Surge, normal or all-clear packet.

Outgoing packets from the current frame are staged. At frame end, opposite
sender/recipient pairs cancel FIFO, one-for-one, before either side is queued.
This includes attacks at different subframes of the same frame. Partial packets
retain their identity and order. Staged packets are not yet in the recipient's
defensive queue, so same-frame crossings do not gain the opener bonus. This is
the simulation's authoritative delivery policy; it does not reproduce the client's
network acknowledgement protocol. Fully offset same-frame attacks never enter
either recipient's queue.

One living opponent is chosen randomly per outgoing placement bundle. All remaining
packets in that bundle use that opponent, with no broadcast multiplication.
The roster is sorted and frozen across the set. Piece seeds are identical for all
players. Routing and each recipient's garbage use separate RNG streams. These are
42tris splitmix32 streams, not the client's RNG algorithm or bit sequence.

Packets become insertion-eligible at `lock time + 20 frames`, including fractional
lock time. Non-clearing placements insert up to eight eligible lines before spawn.
Any line clear blocks insertion. Partial packets remain queued. Phase is zero,
sequential queue delay is disabled, and insertion is instant.

Eligibility comparison allows at most `4 * Number.EPSILON * max(abs(lock time),
abs(eligible time), 20 * FRAME_MS)` milliseconds of clock error. This covers rounding
differences between frame/subframe conversion and adding the delay to a send time.
It is not a fixed millisecond grace period. A placement earlier by more than that
bound cannot insert the packet. Saved eligible timestamps remain unchanged.

All players use the match width, an integer from 4 through 12 (default 10), frozen for the set and stored in checkpoints. A recipient has one hole column within that width. It is generated on first insertion, then rerolled
when a packet finishes, including a fully canceled packet. Rows inside a packet
share that column. Partial insertion preserves it. Repeated columns are allowed.
There is no within-packet messiness. Hole values are chosen at consumption, not
preassigned when a packet is sent. Cancellation therefore affects later hole progression.

Events record generated locks, sends, crossing cancellation, queue admission,
defensive cancellation, insertion holes, discards, eliminations and round results.
Packets retain attack kind and identity. `sent` counts outgoing lines before crossing
cancellation, separately from core's generated attack count. Eliminated recipients'
remaining packets are discarded. Attacks already sent by an eliminated sender can
still reach a living opponent.

## Rounds and continuation

Competitive deaths are resolved together at frame end. Zero survivors produce a draw and no
points. One survivor gains one point. Reaching `firstTo` completes the set; default
is seven. There is no ten-minute cutoff or win-by-two rule.

`nextRound(newSeed)` requires an ended round, an unfinished set and a different
signed 32-bit seed. It increments the round ID and resets the round clock, games,
queues and RNG streams. Scores and packet sequence survive. Pending event records
retain their round IDs, even across a round transition.

The original `roster` remains fixed. `activePlayers` is the subset still eligible
for this set. `forfeit(player)` withdraws a seat, releases its controls, drops its
queued inputs and pending incoming garbage, and stops stepping that board.
Previously sent attacks remain in recipients' queues. Withdrawn seats do not respawn
or receive targets in later rounds. Board epochs increase on each new round.

A current-round last survivor receives one point. With two or more eligible seats,
normal FT rules continue across rounds. With one eligible seat, forfeit completes
the set immediately, even below the FT threshold; a duel cannot farm absent-player
rounds. Forfeit between rounds never awards a second point for the ended round.
Repeated forfeit of the same seat is a no-op. If the final eligible seat also leaves,
a new `setEnd` event marks the set aborted, superseding its previous set result;
existing scores remain unchanged. A new set requires a new Match instance.

`roundEnd.reason` is `survivor`, `draw` or `forfeit`. Completed sets also emit `setEnd`
with reason `firstTo`, `forfeit` or `aborted`, and a winner ID or null.

Match checkpoints are trusted controller data, not a client message schema.
`fromState` checks version, roster, frame, mode, frozen handling, player epochs,
eligibility and input backlog, and delegates core validation to `Game`.
It does not fully validate the match ledger or events from arbitrary JSON.
Checkpoints include clocks, input backlog, events, scores, packet sequence, queues,
hole state and all RNG states. Only complete frames are checkpoint boundaries.
Snapshots are detached and JSON-safe. Core Zen undo history remains excluded.
After restoring a practice checkpoint, prior turns cannot be undone; newly played
turns build fresh core history. Match does not serialize core's private undo stack.
Version 3 also stores mode, attacks toggle, frozen handling, withdrawn seats and
board epochs. Version 1 checkpoints are rejected rather than silently upgraded.

## Owner-only client prediction

`OwnerPrediction` restores only the owner's `Game` and garbage queue from a full
authoritative `MatchState`. It does not construct, step or route attacks to opponent
games. Opponent inputs in the checkpoint are ignored. Known incoming packets retain
their identity, remaining lines, eligibility timestamps and recipient hole RNG.

```ts
import { OwnerPrediction } from "@42tris/match";

const prediction = new OwnerPrediction(authoritativeState, ownerId);
for (const input of unresolvedOwnerInputs) prediction.submit(input);
prediction.advanceToTime(renderTargetMs);
const board = prediction.gameState();
const effects = prediction.drainEvents();
```

Use round-relative simulation milliseconds for `renderTargetMs`, starting at
`authoritativeState.frame * FRAME_MS`. Do not pass an absolute browser clock.
The client chooses the prediction horizon from its synchronized simulation clock
and stops advancing that clock during a room pause.

| API | Contract |
| --- | --- |
| `new OwnerPrediction(state, ownerId)` | Copy the owner's board, ledger, frozen handling, mode and epoch; enqueue their existing authoritative backlog. |
| `submit(input)` | Accept an ordered owner input using Match's frame/subframe conversion and validation. Reject other owners, stale epochs, late times and duplicate orders. |
| `advanceToFrame(frame)` | Process complete half-open frames exactly as Match does for the owner. |
| `advanceToTime(targetMs)` | Process owner deadlines and queued inputs through the requested time, inclusive. Tick at that time without rounding up to a future frame. |
| `gameState()` | Return a detached renderable `GameState`. |
| `saveState()` | Return a detached local ledger with frame, time, owner epoch, board, garbage, predicted sent count and remaining owner inputs. This is not a `MatchState`. |
| `drainEvents()` | Return local lock, cancellation, insertion, discard and informational outgoing events. |

`frame` counts completed frames. At an exact frame boundary, `advanceToTime` also
processes that boundary's deadlines and zero-subframe inputs, while `advanceToFrame`
excludes them. Times cannot go backward. After advancing inside a frame, the next
`advanceToFrame` target must be at or beyond the current time. Inputs submitted at
an already visited timestamp must follow previously consumed inputs in order.

Match and prediction call the same `settlePlacement` helper for opener defense,
FIFO cancellation, outgoing line accounting, clear blocking and garbage insertion.
Both use `GarbageQueue` for packet eligibility, cap and hole progression. There is
no second prediction implementation of those rules.

Prediction's `outgoing` events contain attack kind and lines, with no target,
packet ID or server routing. The predicted sent count assumes a recipient exists
when the authoritative snapshot has a living, non-withdrawn opponent. That eligibility
is not simulated forward. The prediction never manufactures future incoming attacks,
crossing cancellations, opponent deaths, scores, forfeits or round results. Unknown
external interactions can therefore make its board or sent ledger differ from the
server until the next correction. Withdrawn owners and ended snapshots do not advance.

On every authoritative correction, discard the prediction object and construct a
new one. Replay only unresolved owner inputs for the corrected round and epoch,
excluding inputs already present in the snapshot backlog. Do not merge a predicted
ledger into authoritative state, or send predicted outgoing effects as attack claims.
New inputs should include the owner's current epoch. `round`, `epoch`, `owner`,
`mode`, `attacksEnabled` and frozen `handling` are available on the predictor.

Practice undo/reset, attacks-toggle changes, control release and forfeits remain
authoritative requests. The predictor exposes no speculative versions of those
operations. Network checkpoints do not contain Zen history. After a reset or undo,
the replacement predictor restores the authoritative epoch and core clock origin;
old-epoch inputs must not be replayed against it.

## Server authority and online lifecycle

[rooms.ts](../server/src/rooms.ts) binds commands to a server-issued guest seat.
An opaque resume token restores that seat after disconnect; a live connection
cannot be taken over. The browser stores the token in session storage. This is
guest-session authority, not account authentication. A profile ID is not a credential.
[Protocol schemas](../protocol/src/index.ts) reject extra client fields, including
forged player IDs, boards, attacks or scores.

Each input batch carries `matchId`, connection `generation` and board `epoch`.
The server assigns player identity and global order, requires contiguous sequence
numbers, deduplicates identical retransmissions and disconnects conflicting reuse.
Late inputs are rejected rather than rolled back. Inputs more than two frames
ahead of the current wall-clock simulation frame are also rejected. Batches are
limited to 32 inputs, with at most 128 accepted inputs pending per seat and a
separate input rate budget. Acknowledgements distinguish pending accepted,
resolved and rejected sequences; receipt does not mean an input has been simulated.

The scheduler wakes every 10ms and advances complete frames to
`floor(max(0, simulationNow - 100) / FRAME_MS)`, never backward. The 100ms commit
delay leaves time for network input arrival. Full checkpoints are scheduled every
50ms (20Hz) and also sent after relevant commands and transitions. Transport can
skip a checkpoint under backpressure. These intervals are scheduling targets,
not delivery guarantees. Checkpoints include the authoritative Match, owner input
acknowledgements, clock information and a bounded recent event window.

Ready players enter preparation. All eligible players must acknowledge the supplied
checkpoint within 10 seconds before a three-second countdown starts. Readiness
also gates subsequent rounds and a new set after a result. Handling is frozen when
the set is created; later readiness messages do not change that set's handling.

A detected disconnect during play, preparation or countdown pauses the whole room.
Match advancement stops, the simulation clock freezes, all held controls and queued
inputs are released, and each seat's generation changes. Each disconnected seat
has its own 40-second reservation; another disconnect does not extend it. Native
WebSocket heartbeat probes run every two seconds and close a lease after six
seconds without a pong, so a silent connection loss need not pause immediately.

When all remaining eligible seats are connected, preparation and the three-second
countdown run again before the existing Match resumes. The paused duration is
excluded from the simulation clock. Expired or explicitly leaving competitive seats
forfeit; remaining players can continue, and simultaneous expiry can abort an
unfinished set. Published completed-set results are preserved by the room layer.
Removing a practice seat discards that practice Match and returns the room to waiting.

Reconnect retains the live Match instance and its server-side Zen history. This
is different from `Match.fromState`, which loses earlier undo history. Online undo
and reset are server requests, not local prediction operations. The room owner alone
can toggle practice attacks. Opening the online menu or losing browser focus only
releases that owner's controls; play continues unless a disconnect pauses the room.

The browser [Session](../web/src/session.ts) predicts its owner immediately, batches
inputs at intervals of at least 34ms, and rebuilds prediction after each checkpoint.
It replays unresolved inputs once, uses server-assigned order for accepted backlog,
and drops old match/round/generation/epoch inputs. Ping samples estimate the server
clock offset. Pauses freeze the prediction horizon; checkpoints stale for two
seconds suspend input and request resynchronization. Opponents render from server
snapshots without forward simulation.

See [room tests](../server/test/rooms.test.ts),
[WebSocket tests](../server/test/websocket.test.ts),
[session tests](../web/session.test.ts) and [netplay tests](../web/netplay.test.ts).

## Evidence and compatibility gaps

Historical implementation notes record a check of saved
[client source](https://tetr.io/js/tetrio.js) on 2026-10-29.
[Core rules](../core/RULES.md) record the source hash. These notes explain the
profile's origin; they are not a fresh verification of the external client.

The historical reference notes describe the opener condition as
`piecesplaced <= openerphase` and `pending >= sent`. The source increments placed
pieces before resolving attacks. It spends normal attack before the extra defensive budget. The preset sets opener phase to 14,
garbage speed to 20, cap to eight, combo blocking and zero passthrough. Engine
defaults supply phase zero, nonsequential queue, instant entry, packet messiness
one, inner messiness zero and no repeated-column avoidance.

Current compatibility limits:

1. Core supplies lock timing through `LEAGUE_LOCK` and `nextStepAt`; match has no
   separate lock timer. See [core rules](../core/RULES.md) for the current timing contract
   and its limits relative to the client's fractional falling model.
2. Match retains 42tris gravity (500ms per cell) and handling. League gravity ramps,
   later garbage multipliers, fractional kick depth and the client's acknowledgement
   protocol are not implemented. Do not label this profile full League conformance.
3. Practice history before an exact checkpoint is unavailable after restoration.
   The server must communicate that limit if it reloads a practice session.
4. Durable server persistence is not implemented. Rooms, guest sessions and live
   matches exist only in server memory. A process restart loses them. Network
   transport and reconnect policy are implemented outside this package, as described
   above.

Match version 3 embeds core version 5 finesse and lock-timing state in each authoritative player snapshot. Round results display those counters; a new round starts new counters.
