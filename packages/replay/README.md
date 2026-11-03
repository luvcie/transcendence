# Replay work in progress

This package implements the replay format, bounded decoding, corruption checks,
Sprint reconstruction/result verification, Sprint recording and competitive Match
reconstruction/result verification. Deterministic execution lives in the drivers.
Sprint playback is implemented in `packages/web/src/sprint-playback.ts` on top of
`SprintDriver`; competitive recording is implemented in `MatchRecorder`; Match playback,
server integration and export UI are not implemented yet.

## Format and decoding

Format v1 supports `kind: "solo"` with modes `42tris-local` and `42tris-sprint`,
and `kind: "match"` with mode `42tris-competitive`. Envelopes pin `format`,
`simulation`, `coreState`, `coreRules`, and, for matches, `matchState` and
`garbage`. These identifiers must match the installed core/match versions; unknown
values fail with `unsupported`.

Sprint mode pins the standard attempt configuration: 500 ms gravity, five previews,
no opening delay, the practice lock profile, ten columns and a target of 40 lines.
Its journal records controller observations, not raw `Game` timestamps. The first
tick fixes the controller origin, later ticks and releases before the first gameplay
press do not start the clock, and the first non-release input starts the pause-free
elapsed timeline. Pause and undo records are rejected. A terminal record must be the
final journal entry. The shared `Singleplayer` controller from core executes both
live Sprint and replay, so replay cannot drift from the game's rules.

Competitive matches pin a sorted 2–8 player roster, board width, first-to target,
per-player handling, full match compatibility versions, the league lock profile and
enabled attacks. Initial boards and piece sequences derive from the round seed, so
the journal never accepts client-supplied boards, scores, attacks or garbage. Each
round after the first gets its seed from a recorded `nextRound` operation.
The journal's `summary.rounds` entries may carry an optional `reason` assertion
(`survivor`, `draw` or `forfeit`). The field is additive: older v1 payloads that omit
it still decode, and verification checks it only when present. No format or
compatibility version changed for this optional field.

`decodeReplay(value)` validates an already-parsed value. `decodeReplayJson(text)`
first enforces the byte limit, then parses, validates and verifies the envelope
checksum. `decodeReplayWithIntegrity(value)` adds checksum verification to the parsed
form. `sealReplay` hashes an unsigned payload, `encodeReplay` emits canonical JSON,
and `verifyReplayIntegrity` checks an existing envelope.

The checksum covers canonical JSON with the `integrity` field removed. It detects
accidental corruption only. It is not authentication, does not prove who produced a
file, and provides no anti-cheat protection. A recomputed checksum does not make an
invalid or unreachable replay valid.

`computeFinalStateDigest(state, modeState)` produces the canonical digest used by
`end.finalStateDigest`. For Sprint, `modeState` is `Singleplayer.replayState()`:
mode, seed, handling, controller clocks and the frozen result. R1-B executes the
journal, computes the digest from reconstructed state and compares it with the
claim.

## Limits and errors

Defaults are 32 MiB of JSON, 1,000,000 operations, 8 match players, 256-character
strings, two hours of solo engine duration and 432,000 advanced match frames. Limits
can be lowered (or raised) per call through `ReplayDecodeOptions`. Byte limits apply
to `decodeReplayJson`; callers of `decodeReplay` must bound already-parsed input
themselves. Decoding rejects malformed structures, non-monotonic solo clocks,
contiguous-sequence violations, impossible Match boundaries, invalid epochs, bad
handling/input values, unknown fields, unsupported versions/modes and over-budget
work. `ReplayError.code` distinguishes `malformed`, `unsupported`, `resource-limit`,
`integrity` and the reserved `simulation-mismatch` case.

## Drivers

`SoloDriver` executes timestamped raw `Game` operations, checks sequence and observed
handling time, and returns drained events. Its state is a detached `GameState`. It is
the raw local driver, not the Sprint controller.

`SprintDriver` executes controller observations using the same `Singleplayer` class
as the live game. It reproduces the first-input clock, pause-free elapsed time,
10-column setup, winning lock termination, top-out failure, movement, rotations,
handling changes and finesse accounting. It rejects pause, continued records after a
terminal result, non-Sprint configuration and clock regressions.

`MatchDriver` executes the authoritative `Match` in journal order at recorded
round/frame boundaries. It supports 2–8 players and the complete competitive
controller surface: ordered `submit`, `advance` (including partial chunking),
`release` (one player or all), `forfeit` and `nextRound` with its recorded seed.
`apply` starts an operation and `advance` continues a partially consumed advance;
`afterSeq` changes only when the operation completes. Each call returns newly
drained events. The detached `state` includes pending Match inputs and every
player's board, garbage queue, sent counter, elimination/withdrawal flags and epoch.
Do not checkpoint while `hasPendingAdvance` is true.

All boards advance through the same Match scheduler, so equal-time deadlines,
subframe ordering, frame-end attack reconciliation, simultaneous eliminations and
round transitions retain their authoritative semantics. The driver budgets actual
reached frames rather than the original requested target, because an ended round
stops early, and caps each call at the remaining global frame budget so a forged
small `reachedFrame` cannot force over-budget work before rejection. It never steps
players through independent single-player simulations. Practice is rejected by
initial validation, and the journal operation set contains no practice-only undo,
reset or attacks toggle.

Match lifecycle phases that do not exist in the simulation are not journal
operations: preparation, readiness, three-second countdowns, server pause waits and
round-result countdowns do not advance `Match`. A disconnect pause is represented by
the authoritative `release` calls the server makes and by the absence of advances.
Reconnection resumes with further recorded operations; the server's resume token is
never part of replay data. A forfeit or an ended round is represented by its explicit
Match operation and the resulting events.

Discard a driver after an execution exception; partially executed operations are not
rolled back.

## Sprint recording

`SprintRecorder` owns a live `Singleplayer` controller, delegates `tick`, `apply`,
`setHandling` and `setPaused` to it, and appends the exact controller observation in
call order. Sprint ignores the pause flag but still observes the controller clock, so
that call is journaled as a tick. The recorder records the constructor's
initialization tick, so the first gameplay press still starts the clock exactly as it
does in live play. It does not drain events or run a second simulation.

A terminal result captures a detached `GameState` and `SingleplayerReplayState`
synchronously, then asynchronously seals the payload with `sealReplay`, checks the
byte limit, decodes it with `decodeReplayJson` and executes it through
`verifySprintReplayExecution`. `finish()` resolves with the decoded, verified replay
or `null`; `completion` resolves at the same time for lifecycle consumers. `replay`
and `json` expose the sealed artifact. Terminal finalization is idempotent and
ignores later operations. `abandon()` discards only an unfinished attempt.

Operation, duration and approximate byte budgets are enforced while recording. When
a budget is reached, recording fails explicitly (`error` carries the `ReplayError`)
and the live controller keeps running; no truncated journal is exposed. The default
budgets come from `DEFAULT_REPLAY_LIMITS` and can be lowered per recorder.

`packages/web/src/sprint-recording.ts` owns the browser lifecycle: Sprint launch
starts a recorder, restart and leaving abandon the unfinished one, and
`sprintRecordingFor(recorder)` exposes only that attempt's successfully verified
recording. Zen and multiplayer never create a recorder.

## Match recording

`MatchRecorder` observes the authoritative operations performed against a real `Match`
instance in competitive mode: `submit`, `advanceToFrame`, `releaseControls`, `forfeit` and
`nextRound`. It wraps the live `Match` operations, delegates to the real `Match` methods,
and appends accepted operations to the journal with their exact boundaries and authoritative
outcomes (such as `reachedFrame` on advance). It does not drain events from `Match` without
buffering them for callers (`drainEvents()`) and does not run a second simulation.

Online practice rooms are strictly rejected at construction with `ReplayError` (`unsupported`).
Practice rooms must never create a recorder.

On set completion (`match.complete === true`), the recorder snapshots the final state,
seals the replay with `sealReplay`, encodes and decodes canonical JSON with `decodeReplayJson`,
and verifies it through `verifyMatchReplayExecution`. `finish()` resolves with the decoded,
verified replay or `null`; `completion` resolves concurrently for lifecycle consumers.
Unfinished attempts can be abandoned (`abandon()`), or a verified stopped prefix can be
extracted with `buildIncompleteReplay()`.

## Sprint playback

`SprintPlayback` is a presentation controller, not a second simulator. It verifies a
Sprint replay once, then feeds its journal records to a fresh `SprintDriver` in seq
order as a recorded-timeline cursor moves. Browser frame time only moves that cursor
(`advance`), scaled by playback speed; the driver still timestamps every operation
with the recorded values, so reconstructed states do not depend on framerate. The
pre-first-input idle period remains part of the watched timeline and the Sprint
timer still starts at the first gameplay input. Playback never writes to the stored
replay, never touches the live recorder and owns no animation loop or DOM handlers;
the web layer starts and stops it with the results screen.

## Terminal verification

`verifySprintReplayExecution(replay)` executes a decoded Sprint replay, reconstructs
the terminal `GameState` and controller state, computes the canonical digest and
requires an exact match with `end.finalStateDigest`. It then compares every claimed
summary field (outcome, elapsed completion time, clear stats, finesse, top-out) and
the terminal constraints against the simulation. A completed run must end with a
winning lock at the reported timestamp and at least 40 lines; a failed run must top
out below the target. Verification throws `ReplayError` with code
`simulation-mismatch` and never returns a partial success object.

`verifyMatchReplayExecution(replay)` executes a decoded competitive journal, then:

- requires the executed endpoint to equal `end.round`, `end.frame`, `end.afterSeq`
  and the completed journal cursor, with no outstanding advance;
- requires every player's final epoch to equal `round - 1` and the final roster,
  width, first-to setting, mode and attacks flag to match the initial state;
- recomputes the canonical digest over the detached final `MatchState` and requires
  an exact match with `end.finalStateDigest`;
- reconstructs every `roundEnd` event, converts its authoritative frame boundary,
  and compares round numbers, frames, winners, set-completion flags and optional
  reasons against `summary.rounds`. The summary must list exactly the rounds that
  ended; it cannot invent, omit or reorder one;
- compares the claimed final scores with the executed scores from every board;
- for a completed set, requires a terminal `setEnd`, `status: "complete"`, the same
  winner and reason, and enforces the engine's result shape: `firstTo` requires the
  winner to have reached the target and to match the final round; `forfeit` requires
  exactly one eligible player and that winner; `aborted` requires no eligible
  players and no winner;
- for an unfinished set, requires no `setEnd` event, `status` `stopped` or
  `incomplete`, and an `aborted` summary with no winner. The result object carries
  `complete: false`; it is a verified prefix, not a claimed competitive result.

`verifyReplayExecution` dispatches to Sprint or competitive Match and rejects other
kinds. Verification throws `ReplayError` with code `simulation-mismatch` for any
semantic divergence and never returns a partially executed or partially verified
object.

The replay format does not persist the full `MatchEvent` stream. Verification
therefore derives events by executing the journal and compares the represented
summary data (round boundaries and set result); it does not accept a claimed event
list. A future recorder may add an event assertion as separate, optional metadata.
Per-player skins, display names and other cosmetics are deliberately absent from the
replay schema. They cannot influence execution or validity and remain presentation
metadata for a later viewer. `MatchRecorder` implements recording for competitive
matches; online practice must never create one. Practice replay data is rejected as
`unsupported` at decode, driver construction and execution.

The digest check proves only that the claimed result follows the journal under the
pinned rules. It is not proof of human play, an authenticated author, a trusted
origin or a genuine server-issued match. Check envelope integrity separately with
`verifyReplayIntegrity` or `decodeReplayWithIntegrity`; a matching checksum is not
authentication either. Deterministic verification is not anti-cheat enforcement.

## Remaining work

- Server integration of competitive Match recording (M2-B2), Match playback, export
  UI, persistence and shareable links remain separate milestones. Online practice
  recording remains strictly disabled at the source.
- Add optional bounded metadata and presentation annotations when their consumers
  exist. Match countdowns, disconnect waits and pause durations remain presentation
  annotations outside this simulation driver.
- Per-player appearance metadata and replay skin overrides belong to the later
  viewer; they must stay outside simulation state and final-state digests.

The multiplayer server owns one recorder per competitive set, starting when its
Match is created. The room retains a completed replay only after strict decoding
and deterministic verification; `Rooms.completedReplay(code)` is an internal
read-only availability boundary for the current set. A new set replaces the
recorder, and room destruction drops it. Verification runs asynchronously;
failed or unfinished recordings are never exposed. Practice rooms do not create
recorders. Simultaneous seat expirations are recorded as one batch before the
server finalizes the result.
