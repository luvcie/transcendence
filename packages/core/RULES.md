# Core gameplay rules

`42tris-tl-s2-v1` adopts Tetra League Season 2 clears and attacks while keeping
42tris handling and gravity. Local play uses the one-second practice lock profile;
match play, including online practice, uses the league lock profile. A controller
can supply explicit incoming garbage rows at settlement. The core has no default
garbage rules, cancellation, routing, eligibility or other Tetra League match settings.

Historical reference recorded during implementation on 2026-10-28:

- [TETR.IO patch notes](https://tetr.io/about/patchnotes/notes.json)
- [TETR.IO client](https://tetr.io/js/tetrio.js), SHA-256
  `9e57c958c43520deb5dd91f5e1773bf779bfb91e7d273dc8494a93a3a0866d2f`

The reference date and hash are historical provenance, not a fresh verification of
the external client. Current behavior is defined by [rules.ts](src/rules.ts),
[game.ts](src/game.ts) and their tests. The profile fixes these choices independently
of future client updates:

- All-Mini+ spins with SRS+ rotation. T corners distinguish full spins from minis,
  with the fifth rotation test upgrading a corner mini. Immobile spins otherwise
  count as minis. A successful translation invalidates rotation eligibility.
- Ordinary and mini clears have base attacks 0, 1, 2, 4 for one through four lines.
  Full T-spins have base attacks 2, 4, 6 for one through three lines.
- Quads, spin line clears and all clears qualify for B2B. Each contributes once,
  even when a spin or Quad is also an all clear. No-line placements preserve B2B.
- Displayed B2B is chain length minus one. Subsequent qualifying clears add one
  to base attack. At displayed B2B 4, stored Surge is 4, then grows with B2B.
- An ordinary clear breaks B2B and releases stored Surge in three packets:
  `round(n / 3)`, `round(n / 3)`, and the remainder.
- Displayed combo starts at zero on the first clear and resets on an empty
  placement. Multiply base attack plus B2B by `1 + 0.25 * combo`. At combo 2
  or higher, apply a minimum of `ln(1 + 1.25 * combo)`, then round down.
- A Quad or spin clearing a garbage-containing row adds one after rounding.
  An all clear adds a separate five-line packet. Surge and all-clear packets
  do not receive combo multipliers. Attack multiplier stays at one.

## Board, pieces and handling

The board is 4 to 12 columns (default 10) by 40 rows. Rows 0 through 19 are hidden; rows 20 through
39 are visible. Cell 0 is empty, IDs 1 through 7 are Z, L, O, S, I, J, T, and 8 is
garbage. Pieces use a seeded splitmix32 RNG and a Fisher-Yates seven-bag shuffle.
Default gravity is 500ms per cell with five previews. Spawn uses rotation 0 at
`y = 18`, with `x = 4` for O and `x = 3` otherwise on a 10-wide board. Other widths shift the spawn by `floor((width - 10) / 2)`. Spawn collision or garbage
overflow causes top-out; merely occupying hidden rows does not.

Hold is available once per placement. An empty hold consumes the next preview;
swapping an occupied hold does not. Either operation resets the active piece's
orientation and per-piece timers. Hard drop moves to the surface and locks
immediately. A positive descent invalidates spin eligibility; a zero-distance
hard drop preserves it. Failed moves and rotations preserve eligibility.
Rotation tries the natural position first, then the ordered SRS+ kick table,
with separate I-piece candidates and explicit 180-degree kicks.

Handling values are in 60Hz frames and may be fractional. Defaults are DAS 10,
ARR 2, soft-drop DAS 0 and soft-drop ARR 2. Valid ranges are respectively 0..20,
0..15, 0..10 and 0..4. A direction press attempts one immediate move, then repeats
after DAS. The last pressed direction wins; releasing it recharges DAS for the
remaining held direction. A blocked initial move charges DAS immediately. Blocked
finite-ARR repeats retry after one frame. ARR 0 moves to the wall after charging
and stays charged across spawns.

Soft-drop press attempts one row immediately, plus a second when soft-drop DAS
is zero and soft-drop ARR is positive. After the delay, positive soft-drop ARR
adds one cell per configured interval to gravity. ARR 0 drops to the surface
without locking and follows subsequent successful lateral moves into available
space. Duplicate down inputs do not restart handling timers.

An optional opening preview delay ignores gameplay input until the first spawn.
The local browser uses 250ms; Match uses zero and the server supplies its own
countdown. See [handling.test.ts](src/handling.test.ts),
[rotation.test.ts](src/rotation.test.ts), [hold.test.ts](src/hold.test.ts) and
[start.test.ts](src/start.test.ts).

## Core consumers

Give `Game.apply`, `Game.tick`, `setPaused` and `undo` finite, nonnegative,
monotonically increasing times in milliseconds (equal timestamps are allowed).
Invalid timestamps throw before any mutation, including while paused, topped out,
or when undo has no history. Even ignored calls observe valid timestamps.
Advance with the same seed, configuration and
ordered inputs to reproduce a game. Render ticks do not advance accumulators
between simulation deadlines, so render frequency does not change lock events.
Input and pause boundaries account for the remaining elapsed time.
`setZen(true)` and `setHandling` process pending simulation deadlines before
accounting for residual time at the latest observed timestamp. This also applies
when that timestamp came from an unsuccessful undo or a no-op pause call. Paused
and topped-out games do not advance.

The browser samples `performance.now()` inside its frame callback, as it does for
restart, input, pause/resume and undo. It does not pass the RAF timestamp to core:
that timestamp can precede an input processed before the callback runs. Sampling
at the call preserves monotonic ordering without relaxing core validation.

Drain events after both `apply` and `tick`, and before discarding a game on restart.
A lock result records its simulation time, cleared row indices before compaction,
spin, all-clear status, updated counters and ordered attack packets. Packets are
Surge first, ordinary attack second, all-clear bonus last. Zero packets are omitted.
The attack counter measures generated lines, before any future cancellation.

`stats.combo` is -1 outside a combo, 0 on its first clear. `chainLength` distinguishes
an established B2B chain from no chain, even though both display B2B 0. Event values
are immutable and sequence numbers increase during forward play and Zen undo.
Exact restoration reinstates the saved sequence, which can be older.
[Match](../match/RULES.md) supplies player identity, cancellation and attack routing.

## Exact snapshots

`GameState` and `GAME_STATE_VERSION` are exported from `@42tris/core`.
`saveState()` returns detached, JSON-safe data. Restore with an explicit controller:

```ts
const state = JSON.parse(JSON.stringify(game.saveState()));
const resumed = Game.fromState(state, null); // An unconnected game.
// Or update an existing instance with the same preview count:
game.restoreState(state, null);
```

Version 4 stores the board, preview queue, bag permutation/index and signed RNG
state, configuration, current piece, hold and rotation eligibility. It also stores
the lock profile, move/rotation reset counters and historical lowest position. It adds
the league frame origin, next frame index, processed phase and lock duration in frames.
Versions 1 through 3 are rejected; no implicit migration changes their continuation rules. It stores
held controls, deadlines, accumulators, opening time, pause/top-out flags, last
result, pending events and sequence. `stats` is derived from the saved last result,
or the initial counters when no result exists. Inactive infinite deadlines use
`null`. Charged ARR=0 also uses `null`; direction and held flags distinguish it.

`lastNow` is the last simulation boundary. `observedNow` is the latest external
timestamp, including paused RAF ticks. Render-only ticks can leave these unequal.
Restoration preserves both clocks exactly. It does not rebase time, release
controls, advance sequence, call settlement or emit an event. Continue with times
at or after `observedNow`. Deliberate restoration can replace a newer game with an
older state; it is not an external timestamp call.

Restore validates versions, array shapes, cell and piece IDs, bag permutation,
integer counters, finite numeric ranges, control/deadline consistency, event
sequence ordering and piece bounds before mutating the target. Unknown properties are
ignored. Invalid state throws. Restored data and later snapshots share no mutable
arrays, configuration or result objects with the source. Lock results remain
deeply frozen. An existing target must have the saved preview count; `fromState`
constructs that count automatically. Validation does not prove gameplay reachability
or recompute historical attacks and counters from the board.

Held directions with finite ARR require a finite movement deadline. A null
movement deadline is valid for a held direction only with charged ARR=0. Held
soft drop requires a finite soft-drop deadline, and held controls require an
initialized simulation clock. Terminal timed locks can retain floating-point
rounding above 1,000ms. Validation allows four clock-scale epsilon units only
for top-out states and preserves the saved value exactly; active timer limits
and external timestamp rejection have no tolerance.

Snapshots exclude Zen history and its current turn checkpoint. Restoration clears
old history and preserves the Zen flag. If playable, the restored position becomes
the next undo baseline. This avoids copying up to 1,000 histories into each exact
checkpoint. Use exact snapshots for continuation and the turn history for Zen undo;
the two have deliberately different clocks, controls and event semantics.

Functions cannot cross JSON. `settlementRequired` records whether a controller was
attached. `fromState(state, callback)` and `restoreState(state, callback)` require
an explicit callback argument, or explicit `null` for an unconnected snapshot.
A snapshot that requires settlement rejects `null` or a missing callback. The
controller must restore its own state and external ledger separately.

## Placement settlement

The constructor accepts an optional sixth argument, `SettlePlacement`. Existing
constructor defaults and the signed seed API are unchanged:

```ts
const game = new Game(seed, 500, 5, DEFAULT_HANDLING, 0, placement => {
  controller.recordGenerated(placement.result);
  return controller.takeIncomingHoles(); // For example [0, 9], not a line count.
});
```

The core calls this synchronous function once per placement, after spin
classification, placement, row clearing and attack calculation, before spawning.
This includes every timed lock in a coarse tick and locks nested inside `apply`.
The frozen `PlacementSettlement` contains only `x`, `y`, `rot` and the frozen
`LockResult`. The result describes the placement before incoming garbage. It has
no mutable board or Game reference. While the callback runs, the Game still holds
the previous committed board, counters and result. Use the supplied result for
this placement, rather than reading the Game. During settlement, `apply`, `tick`,
`undo`, `restoreState`, `setZen`, `setHandling`, `setPaused`, `drainEvents` and
`saveState` on that Game throw before mutation. A callback is not a completed
checkpoint boundary. If the controller catches this rejection, the original
placement can still settle normally. An uncaught rejection uses the fail-closed
path below. Direct writes to public Game fields or arrays from the callback are
unsupported; the method guard does not intercept them.

Return an array of integer hole columns, 0 through 9, in insertion order. The
first row rises above later rows. Every row shifts the 10-by-40 board up one row
and inserts cell 8 across the bottom, with cell 0 at the hole. Occupied cells
shifted off the top cause top-out. The core still inserts all returned rows and
records the placement result, but consumes no next piece and performs no spawn.
If there is no overflow, normal spawn collision checks run after insertion.
Incoming rows do not alter the generated attack counter or this placement's clear
and all-clear calculation.

Placement is staged before commit because a callback can already have changed
an external attack ledger; rolling back only the Game would leave them inconsistent.
If the callback throws, returns a promise, or returns invalid holes, the core throws
and fails closed: top-out is set and controls are released. No part of that placement's staged
board, result, sequence, queue or history is committed. Earlier successful locks
in the same tick remain committed. Input movement and elapsed time are not rolled
back. A later tick cannot retry the failed callback. The controller must recover
its own side effects before restoring a prior snapshot; the core cannot make an
external ledger transactional.

## Zen checkpoints

`setZen(true)` starts history at the current position, or the first spawn if still
in the opening preview. Each completed placement records its starting turn, before
hold or movement. `undo(nowMs)` discards the current turn and restores the previous
one, including the board, bag/RNG, queue, hold, rotation eligibility, timers and
clear counters. History retains the last 1,000 placements. Disabling Zen or creating
a new game discards it.

Undo keeps current handling and pause settings, releases held inputs, and rebases
the restored timer progress to `nowMs`. It drops pending events from the abandoned
state and emits `restored`, without emitting old attacks again. The browser also
clears its pressed-key map. Local non-Zen play automatically restarts after top-out,
while local Zen keeps the board available for undo. Online competitive play waits
for the server result; online practice retains the board for authoritative undo/reset.
Zen's local history is not a competitive rollback or wire protocol.

Undo restores the board before received garbage for that turn. It also rewinds
local generated attack stats, but cannot retract attacks already recorded or sent
by an external controller. Settlement is not called during undo. Controllers that
use Zen must account for this distinction in their own ledgers.

## Lock profiles and shared scheduling

The seventh constructor argument selects `PRACTICE_LOCK` (default) or `LEAGUE_LOCK`.
Their version strings are `42tris-practice-lock-v1` and `42tris-league-lock-v2`.
The practice profile accumulates time only while grounded and locks at 1,000ms.
A successful move, rotation or fall clears an accumulated lock timer and falling
progress, with no reset limit. Failed actions do not refresh it.

### Fall checkpoints

A fixed 31-frame deadline would miss subframe Fall checkpoints that cross the
strict 30-frame threshold before frame 31. League simulation processes complete
60Hz frames, configured handling deadlines, and the residual segment before each
input. Each segment processes held shifts before Fall, then the input acts on the resulting piece.

`tick` processes canonical frame and handling deadlines only. Arbitrary render ticks
do not create extra Fall segments. `apply` also processes its fractional input checkpoint.
An equal-time `tick` followed by `apply` processes each segment once. Other APIs that
account for residual time, such as pausing, also create a checkpoint.

`nextStepAt` includes the next canonical league frame even when airborne. Controllers
must process these deadlines globally before dispatching an input to its target game.
An exhausted reset count does not create a zero-time deadline. A later positive Fall
segment checks exhaustion. The public timestamp unit remains milliseconds.

The lock timer accumulates the full segment duration, in frames, once on the first
failed positive Fall chunk. Successful chunks earlier in that Fall do not reduce the
charge. Successful falling preserves the timer. Thirty blocked whole frames survive;
an input checkpoint at 30.25 frames locks before dispatching that input. Without an
intervening checkpoint, the next evaluation is frame 31. This is a strict comparison,
not a 500ms or 516.667ms deadline.

Two floating-point corrections preserve this checkpoint model. If division rounds a
phase up to the next frame while its millisecond boundary is still pending, the
phase is clamped to the double immediately below that frame. The next frame index
does not change. The pending boundary later processes the remaining positive duration;
snapshots still require `leaguePhase < leagueFrame`.

After adding blocked duration, an overshoot above 30 within
`8 * Number.EPSILON * max(30, phase)` frames is normalized to 30. This bounds the
rounding neighborhood of phase division, subtraction and duration accumulation. It avoids
locking early after a fractional reset such as frame 2.2 followed by frame 32.2.
It also means true overshoots inside that numerical neighborhood are indistinguishable
from rounding and wait for another checkpoint. A 0.25-frame overshoot and a tested
1e-10-frame overshoot at frame 32.2 both lock. The normalized timer is saved unchanged;
snapshot validation does not admit active timers above 30.

Every successful lateral move or rotation increments the reset count, including airborne
actions. Failed actions do not count; a successful 180 counts once. Counts saturate at
31 moves/rotations and 63 rotations. Resulting counts below 15 clear the timer. The
15th action preserves it. Exhaustion forces a lock during the next Fall if one cell
down is blocked.

The integer board retains fractional falling progress in `fallAcc / gravityMs`.
Depth renewal compares `y + fallAcc / gravityMs` against the old historical marker,
then stores its ceiling. Thus fractional progress past that marker renews both counts,
even before a whole row changes. It preserves the lock timer. Each Fall computes its
distance once: configured gravity/soft drop plus `0.5 * duration * max(0, rotations - 30)`
cells. Depth renewal mid-Fall does not reduce that distance. Soft drop does not multiply
the rotation term. Values within eight machine epsilons of a whole cell snap to that
cell to avoid losing an integer descent to floating-point accumulation.

Hold and spawn clear per-piece timers, progress, counts and historical depth. They
preserve the global frame phase. If a checkpoint locks, its remaining distance is
discarded; the next piece receives only subsequent segments. Pause/resume and Zen undo
rebase the canonical frame origin to their timestamp. Undo restores per-piece timers
and releases controls. Exact JSON snapshots preserve the frame phase without rebasing.

### Evidence and remaining differences

The implementation notes recorded these client methods as the basis of the profile.
Their external-source behavior is retained as historical context; the current
repository tests verify the 42tris contract:

| Method | Observed behavior used here |
| --- | --- |
| `_ProcessSubframe` | `ProcessAllShift(duration)` and `Fall(duration)` precede keydown/up. |
| `_InternalLocking` | Adds supplied duration and tests `locking > locktime`. |
| `Fall` | Forces exhausted grounded pieces, adds rotation distance once, charges full duration on first failed chunk. |
| `_InternalShift`, `_InternalRotate` | Cap counts and clear the timer only while the resulting count is below the reset limit. |
| `_InternalFall` | Renews counts past old `hy`, sets `hy = ceil(newY)`, and preserves locking. |

`lock-profile.test.ts` exercises those checkpoint rules, fractional snapshots, and coarse
versus canonical stepping. These are source-derived unit fixtures, not differential
replays against the client.

This profile is not full TETR.IO conformance. The client uses fractional piece coordinates,
millionth-cell rounding and epsilon offsets in `_InternalFall`. Our integer-board projection
and residual accumulator do not reproduce those coordinates exactly. Fractional landings,
spawn offsets and collision boundaries can therefore differ. Client rotation candidates
also change fractional Y behavior after a separate `totalRotations` counter exceeds 30.
Core retains its integer SRS+ candidates and does not implement that separate counter.

Configured 42tris DAS, ARR, soft-drop press behavior and gravity remain supported. Their
deadlines are additional checkpoints; they do not reproduce all TETR.IO handling options
or its soft-drop multiplier. These differences matter for cross-engine replay comparison.
This profile defines reproducible shared-core lock checkpoints without claiming that
subcell positions or input handling match the client bit for bit.

[Match rules](../match/RULES.md) define the shared versus scheduler and garbage profile.

## Finesse

Finesse uses the empty-field reference, generated from this engine's spawn shapes,
wall kicks and rotation rules. A fresh left or right press and each clockwise,
counterclockwise or 180-degree rotation cost one input, including failed actions.
Auto-repeat, releases, hard drop and hold cost nothing; hold starts a new count.
For finite ARR the reference permits stopping a held direction at any column.
For ARR zero it permits a single tap or a hold to the wall. A placement with the
same occupied cells has the same reference, even if its rotation state differs.
DAS must be positive. Keybindings do not change logical inputs; the reference
assumes all three rotation actions are available even if a player unbinds one.

A fault is an evaluated placement with more presses than its reference. The
accuracy uses Techmino's weighted rate: 5 points for no excess inputs, 2 for one,
1 for two and 0 for three or more. Accuracy is 100 × points / (5 × evaluated
pieces); it is unavailable before the first evaluated piece. Faults count
placements, not surplus presses. Total locked pieces remain in `stats.pieces`.

Roofed placements, classified spins, placements near spawn, placements using
soft drop, those with controls held across spawn or hold, and turns where handling
changes are excluded from the evaluated count. Zero-DAS turns are also excluded.
The reference assumes enough time to move above the stack, so high gravity and
unusual stacks can still make its judgment less representative of necessary
inputs. The counter is a finesse practice metric, not proof of a globally optimal
path through the actual field. No statistics are awarded for excluded placements.
Counters and the in-progress input count are included in exact snapshots and
Zen checkpoints. Each match round has independent per-player statistics.
