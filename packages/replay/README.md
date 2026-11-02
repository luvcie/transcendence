# Replay work in progress

This package implements the R1-A replay format, bounded decoding, corruption
checks, R1-B Sprint reconstruction/result verification and R2 Sprint recording.
Deterministic execution lives in the drivers. Sprint playback is implemented in
`packages/web/src/sprint-playback.ts` on top of `SprintDriver`; recording for other
modes, Match playback and export UI are not implemented yet.

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

`MatchDriver` executes competitive Match operations at recorded round/frame
boundaries. `apply` starts an operation and `advance` continues a partially consumed
advance; `afterSeq` changes only when the operation completes. Each call returns
newly drained events. The detached `state` includes pending Match inputs. Do not
checkpoint while `hasPendingAdvance` is true. Practice is rejected.

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
out below the target. `verifyReplayExecution` dispatches to Sprint and rejects other
kinds until their milestones arrive. Verification throws `ReplayError` with code
`simulation-mismatch` and never returns a partial success object.

The digest check proves only that the claimed result follows the journal under the
pinned rules. It is not proof of human play, an authenticated author or a trusted
origin. Check envelope integrity separately with `verifyReplayIntegrity` or
`decodeReplayWithIntegrity`; a matching checksum is not authentication either.

## Remaining R1 work

- Add Match execution verification in R1-C.
- Add optional bounded metadata and annotation fields when their consumers exist.
  Match countdowns and disconnect waits remain presentation annotations outside this
  simulation driver.
- Export UI, Match playback and recording for modes other than Sprint remain
  separate milestones.
