# 06 — Implementation roadmap

> Baseline `a4a9e8e` (N1-B landed; 648 tests), 2026-11-03. This roadmap is written for implementation agents.
> Follow the milestones **in order** unless the dependency table says otherwise. Each one is
> small, has its own tests, and can be reverted alone. **No milestone may be started without
> the owner's authorisation.**
>
> Netplay milestones continue the project's numbering (N1-A, N1-B already exist) as **N2–N6**.
> The replay track continues **M4** (persistent and shareable replays) as **M4-A…M4-E**.

Related: [04 recommendation](04-ARCHITECTURE-OPTIONS.md) · [07 test plan](07-TESTING-AND-ACCEPTANCE-PLAN.md) ·
[05 replay design](05-REPLAY-COMPATIBILITY.md) · [Appendix A harness](appendix-A-experiment-harness.md).

---

## Overview

| # | Milestone | Touches | Gameplay change | Replay format change | Difficulty |
|---|---|---|---|---|---|
| N2-0 | Close the N1-B post-stall ordering gap | web | Yes (fewer resets) | No | S |
| N2-A | Diagnostics extension + N-player harness | web, server (env-gated), tests | No | No | S–M |
| N2-B | Checkpoint diet | server | No | No | S |
| N3-A | Server future window for lead | server, protocol constant | No (admission) | No | XS |
| N3-B | Client fixed lead (opt-in) | web | Yes (stamping) | No | S |
| N3-C | Adaptive lead policy | web | Yes | No | M |
| N3-D | Sliding-window clock estimate | web | Yes (stamping) | No | S |
| N2-C | Silence/outage policy | server, web | Yes (lifecycle) | No (uses `release`) | M |
| N4-A | Opponent replicas (60 Hz) | web | Presentation only | No | M |
| N4-B | Live ops streaming *(gated)* | protocol, server, web | Transport | No | L |
| N5 | Piece-guarded late re-timing *(gated)* | core/match, protocol, replay | **Yes** | **Yes (new Match version)** | L |
| N6 | Architecture C prototype *(conditional, branch only)* | experiment | — | — | XL |
| M4-A | Replay engine registry | replay, web | No | No | M |
| M4-B | Replay store + golden corpus | replay, server | No | No | M |
| M4-C | Share endpoint + appearance records | server, protocol | No | No | M |
| M4-D | Public viewer route | web, server | No | No | M |
| M4-E | Cross-version CI | tests | No | No | S |

Mapping from the architecture components in [04 §2.2](04-ARCHITECTURE-OPTIONS.md#22-components):
A2 → N3-A/N3-B/N3-C · A3 → N3-D · A4a → N1-B (landed) + N2-0 · A4b → N5 · A5 → N2-B · A6 → N4-A ·
A7 → N4-B · A8/A9 → N2-C. A1 (room-wide commit delay) is deliberately **not** scheduled.

```
N2-0 ─► N2-A ─► N2-B ─┬─► N3-A ─► N3-B ─► N3-C ─► N3-D ─► N2-C ─► N4-A ─► [re-measure]
                      │                                                     ├─► N4-B (if 8p egress too high)
                      │                                                     ├─► N5   (if resets from bursts remain)
                      │                                                     └─► N6   (if N5 insufficient)
N2-0 ─► M4-A ─► M4-B ─► M4-C ─► M4-D ─► M4-E          (parallel track; coordinate edits to rooms.ts/app.ts)
```

---

## Global invariants

Every milestone must preserve all of these, and its tests must assert the ones it touches.

| ID | Invariant |
|---|---|
| I1 | **In-flight sequence numbers are never reused** within a generation. The server consumes a seq whether it accepts or rejects it (`rooms.ts:360`). Reusing one with a different fingerprint closes the socket (`SEQ_CONFLICT`). |
| I2 | **One-shot actions** (rotations, Hard Drop, Hold) **never apply to an unintended piece because of new code.** Re-timing a one-shot is forbidden unless N5's piece guard exists. |
| I3 | **No client message creates, sizes, targets or cancels an attack.** Attacks derive only from server simulation. Predicted outgoing events are informational. |
| I4 | **No backdating beyond the committed frame.** The server rejects `frame < match.frame`. The future bound is `≤ ceil(MAX_INPUT_LEAD_MS/F) + 2` frames and is never unbounded. |
| I5 | **Existing verified replays remain verifiable** (golden corpus, M4-E) on every commit. |
| I6 | **Replay results never depend on wall-clock scheduling.** Journals contain frames and ordered operations, never times or arrival batches. |
| I7 | **Practice rooms never create recorders, journals or stored replays.** |
| I8 | **Nearby play is unchanged.** At RTT ≤ 60 ms (no spikes): 0 resets, lead 0, opponent lag not increased, local input-to-render ≤ 1 frame. |
| I9 | **An unavailable network never silently rewrites committed history.** Recovery affects only speculative client state or produces explicit, journaled operations (`release`, `forfeit`). |
| I10 | **Prediction time never moves backwards**, and input stamps are non-decreasing within a generation. |
| I11 | **Diagnostics are opt-in and never affect gameplay**, checkpoints or journals (existing test `netplay-latency.test.ts:571`). |
| I12 | **Checkpoints remain complete authoritative `MatchState`s** unless N4-B explicitly adds a verified replica protocol. |
| I13 | **Generation, epoch, matchId and round identity checks are never weakened** (`rooms.ts:349`, `session.ts:405-415`). |
| I14 | **Core and match stay free of wall clocks, browser APIs and transport batching** (`docs/ARCHITECTURE.md`). |

### Mistakes implementation agents are likely to make — and the guardrail

| Likely mistake | Guardrail |
|---|---|
| Renumbering pending inputs after a reset or recovery | I1. Recovery assigns **new** seqs from `nextSeq` only. Never edit `seq` of an item that may have been sent. Test: a retransmission with the same seq must have the same fingerprint. |
| "Fixing" late inputs by re-stamping them on the client | I2/I10. Only N1-B's unsent held-transition recovery may re-stamp. Sent inputs are immutable. |
| Adding a client field that the server trusts for gameplay (e.g. "lines sent") | I3. Protocol schemas stay strict (`additionalProperties: false`). Any new field must be validated and must not create authority. |
| Using a room-wide commit delay change as "the fix" | It raises opponent lag for everyone. Use per-player lead (N3). |
| Making lead decrease mid-round | I10. Lead may only increase mid-round (≤1 frame per step). Decreases happen at round start. |
| Calling `match.*` directly when a recorder exists | Route through `room.recorder` exactly as `rooms.ts` does. Never call both. |
| Changing `Match` behaviour without bumping `MATCH_VERSION` | I5. A behaviour change requires a version bump, a frozen old engine (M4-A) and golden tests. |
| Re-encoding stored replay JSON | Breaks digests and links. Store the sealed bytes. |
| Recording or sharing practice games | I7. Tests must cover practice through reconnect/restart/share. |
| Using `Date.now()`/`performance.now()` inside core/match/replay | I6/I14. |
| Confusing a prediction correction with server divergence | Corrections are client-only. The server is never "fixed" toward a client. |
| Forgetting simultaneous attacks / reconnects in tests | [07](07-TESTING-AND-ACCEPTANCE-PLAN.md) lists mandatory scenarios per milestone. |

---

## N2-0 — Close the N1-B post-stall ordering gap

**Status of N1-B.** Landed as `a4a9e8e` (648 tests pass, `bun run check` clean). Its recovery
is correct when it runs. Review of the code found no seq-reuse path: every sent item before a
stale unsent item is itself stale, so the `stale[0] === firstUnsent` guard forces a release in
that case.

**Objective.** Make N1-B's recovery apply regardless of whether the browser runs the
trailing-flush timer, a key press, or the queued checkpoints first after a stall.

**Evidence.** In the harness, recovery succeeded only when the post-stall checkpoint was
processed before anything flushed. Delaying that checkpoint by 20–30 ms produced
`INPUT_REJECTED` + `stale-prediction` reset in 3/3 orderings (timer first, key press first,
1 s stall) ([03 §3.6](03-LATENCY-AND-FAILURE-ANALYSIS.md#36-browser-stalls-vs-network-stalls-measured-traces)).
The cause is that `flushInputs` (`session.ts:247-262`) transmits stale unsent items without
checking them, and once `transmitted` they can no longer be retracted.

**Files.** `packages/web/src/session.ts` (`flushInputs`, a new private helper),
`packages/web/netplay-latency.test.ts`.

**Required behaviour.**

```ts
// Before transmitting: is the oldest unsent item probably already committed on the server?
private staleByClock(): boolean {
  const cp = this.checkpoint, first = this.pending.find(i => !i.sent);
  if (!cp?.state || !first || cp.clock.frozen) return false;
  const estCommittedMs = cp.clock.simulationNow + Math.max(0, this.serverNow() - cp.serverNow) - cp.clock.commitDelayMs;
  return (first.frame + first.subframe) * FRAME_MS < estCommittedMs - FRAME_MS;   // one frame of slack
}
// in flushInputs, before building the batch:
if (this.staleByClock() && this.options.now() - this.deferredSince < DEFER_MAX_MS) {
  this.deferredSince ??= this.options.now();
  this.cancelScheduledFlush(); this.resync();   // resync is already rate-limited (500 ms)
  return;                                         // the next processed checkpoint runs rebuild(true) → recover()
}
this.deferredSince = null;                        // reset on every send and on every identity change
```

* `DEFER_MAX_MS = 500`. After that, fall back to today's behaviour: send, and accept the
  likely reset. Never wait indefinitely.
* After each processed checkpoint, if unsent items remain, schedule a flush as today
  (`session.ts:433-434`).
* New key presses during the deferral are predicted and queued as usual. `recover()` already
  renumbers the remaining unsent tail.

**Decide and test one ordering question first.** The N1-B commit message says *"the freed
numbers go to the correction first"*. The code (`session.ts:338-355`) does the opposite: it
renumbers the remaining unsent tail from `cp.owner.nextSeq` first, then appends the corrective
transitions at `target()`. After N2-0, a stale held transition plus a newer unsent key press
becomes common. The order then matters: is Left released before or after a rotation pressed
after the stall? Choose deliberately. The release-first variant stamps corrections at the first
remaining item's stamp, with lower seq. Write the test before changing either the code or the
commit description.

**Invariants.** I1 (no seq transmitted twice with different content; deferral changes no seq),
I2 (stale one-shots still dropped, never re-timed), I10, I13. Normal play must never trigger
the deferral: unsent items are ≤34 ms old, far from `commitDelay`.

**Edge cases.** Downstream also stalled (checkpoints late): bounded by `DEFER_MAX_MS`. Lead > 0
(N3) makes the condition rarer. That is correct, because the stamp is ahead. A paused or frozen
clock disables the check. Identity changes clear the deferral.

**Tests.** Port the three orderings from Appendix A (`exp/n1b-order.ts`) into
`netplay-latency.test.ts`: 300 ms stall with checkpoints delayed 20 ms (timer first); a key press
at stall end before checkpoints; a 1 s stall. Each asserts `staleRecovery.count === 1`, no
`INPUT_REJECTED`, no release, the same generation, and the server's held state matching the
physical keys. Plus: high-RTT runs (RTT 200–300 with lead) never defer. Plus: the
`DEFER_MAX_MS` fallback releases exactly once when no checkpoint arrives.

**Acceptance.** All N1-B tests still pass. The three new ordering tests pass. The [03](03-LATENCY-AND-FAILURE-ANALYSIS.md)
RTT matrix is unchanged.

**Rollback.** Revert. N1-B's behaviour is unaffected.

**Risk.** Low–medium. The danger is deferring in a case that is not a stall. The clock
condition and the 500 ms cap bound that.

---

## N2-A — Diagnostics for the Singapore/Antideploy question

**Objective.** Make the failure classes F1–F7 ([03 §5](03-LATENCY-AND-FAILURE-ANALYSIS.md#5-failure-modes-catalogue))
distinguishable from a single `__42trisNetDiagnostics.snapshot()` plus optional server logs.
Upstream the N-player harness.

**Files.** `packages/web/src/session-diagnostics.ts`, `packages/web/src/session.ts` (call sites
only), `packages/web/src/online-view.ts` (byte counting at the transport),
`packages/web/netplay-harness.ts` (generalise to N clients; port from
[Appendix A](appendix-A-experiment-harness.md)), `packages/server/src/rooms.ts` +
`app.ts` (counters behind `NETPLAY_METRICS=1`).

**Required behaviour.**

* Client snapshot gains:
  * `checkpoints.ageMs: { last, p50, p95, max }` where age = `(receivedAt + offset) − cp.serverNow`.
    Document that it carries the clock-estimate bias `(U*−D*)/2`.
  * `transport: { bytesPerSec, messagesPerSec, maxMessageBytes }`. Read the raw WebSocket
    `message` event size. Check how the installed Eden client exposes the raw socket. If it
    cannot, count `JSON.stringify(message).length` as an approximation and label it so.
  * `clock: { offsetSamples: last 16 implied offsets, driftMsPerMin }` from every pong, not
    just the best one.
  * `control: { blockedMs, blockedPct }`: time with `connected && phase=playing && owner alive
    && !canPlay`.
  * `inputs.marginAtSendMs: { p5, p50 }` = `stamp − (estServerNow − 100)` at send time.
* Server (env-gated, default off): per room, every 10 s, one JSON log line with per-seat
  accepted, late, future, `pending-full` counts, a lateness histogram (`0–10, 10–25, 25–50,
  50–100, >100 ms`, where lateness = `match.frame·F − stamp` for late rejections),
  checkpoints sent/skipped, bytes sent, and `process.cpuUsage()` delta.
* Ring buffers stay bounded. No tokens, names or boards. JSON-serialisable.

**Must remain unchanged.** Gameplay, protocol, checkpoints, journals. When diagnostics are
disabled, `OwnerPrediction.saveState` is never called (I11).

**Sequence.** 1) Port the N-player harness as a test helper (keep the 2-client API working for
existing tests). 2) Add client fields plus unit tests. 3) Add server counters plus a fake-clock
test. 4) Update the `?diagnostics` docs.

**Edge cases.** No pong yet (offset from welcome). Reconnect resets ages. Checkpoints during
pause (`frozen`). Identity changes. Very large messages.

**Tests.** See [07 §T-D](07-TESTING-AND-ACCEPTANCE-PLAN.md#diagnostics-tests). With exact fake
clocks, age equals the configured downlink delay ±1 ms. Lateness histogram buckets match a
scripted late input.

**Acceptance.** An owner can run the [03 §6](03-LATENCY-AND-FAILURE-ANALYSIS.md#6-diagnosis-plan-for-antideploysingapore)
plan and classify F1/F2/F5/F6 from one snapshot plus server logs.

**Rollback.** Revert. No data or protocol is affected.

**Risk.** Low. The one risk is overhead in the hot path, so keep all of it O(1) per event.

---

## N2-B — Checkpoint diet: events window and shared snapshot

**Objective.** Cut checkpoint size by ~5–20× and snapshot CPU by ~N×, with no change to
gameplay, protocol schema or replays.

**Evidence.** `events` is 79–85% of checkpoint bytes. A 2-player checkpoint grows to ~95 KB.
`saveState()` runs per seat. Measured 0.56–1.9 MB/s per client
([03 §4](03-LATENCY-AND-FAILURE-ANALYSIS.md#4-bandwidth-and-queueing-the-oversized-checkpoint-finding)).

**Files.** `packages/server/src/rooms.ts` (`checkpoint`, `broadcastCheckpoint`, `snapshots`).
Tests in `packages/server/test/`.

**Required behaviour.**

1. Checkpoint `events` = the latest `roundEnd` of the current round (if any) + the latest
   `setEnd` (if any) + at most the last 16 events. Keep `room.events` internally exactly as it is.
   The tick logic depends on it for aborted-set filtering (`rooms.ts:498-501`).
2. `broadcastCheckpoint` computes the shared parts **once** (`serverNow`, `room` view,
   `matchId`, `state = match.saveState()`, `clock`, `roundDurations`, `events`), then sends each
   seat `{...shared, serverSequence: ++this.serverSequence, owner: ack(seat)}`. A single-seat
   `checkpoint(room, seat)` (input ack, resync, release) uses the same builder.
3. Optional (N2-B3): cap input-triggered checkpoints at one per seat per 20 ms. A burst of
   batches inside that window gets a single checkpoint at the end of the window, sent via a
   timer. **Skip N2-B3 if it complicates the ack tests.**

**Must remain unchanged.** `MatchState` content, `Checkpoint` schema, the ack semantics per
seat, `ephemeral` handling, results text in `online-view.ts:327`, resync behaviour, recorder.

**Invariants.** I3, I5, I12, I13. Every checkpoint is still a complete authoritative state.
Each seat's `owner` ack describes *that* seat.

**Edge cases.** `roundResult`/`setResult` after >16 later events (forfeits). Aborted-set
supersession (`rooms.ts:498-501`). A waiting room (`state: null`). A rematch (new `matchId`,
events reset in `prepare`).

**Tests.** 8-player checkpoint after 300 events < 30 KB. 2-player < 8 KB. Spy:
`Match.saveState` is called once per broadcast. Results text appears correctly in round and set
results after many events. All existing server and web tests pass. Golden replays unchanged.

**Acceptance.** Harness: 2p steady-state downstream ≤ 150 KB/s per client; 8p ≤ 600 KB/s per
client; 8p server CPU per sim-second reduced ≥ 4×.

**Rollback.** Revert. Clients tolerate both shapes, because the schema is identical.

**Risk.** Low. Watch for clients that might start depending on the full event history; none do
today.

---

## N3-A — Server future window for lead

**Objective.** Let clients stamp inputs up to `MAX_INPUT_LEAD_MS` ahead without rejection.

**Files.** `packages/protocol/src/index.ts` (export `MAX_INPUT_LEAD_MS = 250`),
`packages/server/src/rooms.ts:363`.

**Required behaviour.** Reject if `item.frame > floor(simNow/F) + ceil(MAX_INPUT_LEAD_MS/F) + 2`.
Nothing else changes. The pending cap (128) still applies.

**Invariants.** I4 (no change to the lower bound), I1, I13.

**Tests.** Accept an input at now+250 ms. Reject at now+250 ms+3 frames. A late input is still
rejected. A replay containing lead-stamped inputs verifies. Rate and pending limits are
unchanged.

**Acceptance.** All tests pass. Deploy **before** N3-B.

**Rollback.** Revert. Clients without lead are unaffected.

**Risk.** Very low. Security: future-stamping cannot accelerate play, because commits are
server-paced.

---

## N3-B — Client fixed lead (opt-in)

**Objective.** Add `lead` to `Session.target()`, settable only via `?lead=<ms>` while
diagnostics are enabled, to validate on real networks.

**Files.** `packages/web/src/session.ts` (`target()` `:223-228`, a new `lead` field),
`packages/web/src/main.ts` (parse the query parameter alongside `?diagnostics`),
`session-diagnostics.ts` (report lead).

**Required behaviour.**

```ts
private target() {
  const cp = this.checkpoint!;
  const elapsed = cp.clock.frozen || this.room?.phase !== "playing" ? 0 : Math.max(0, this.serverNow() - cp.serverNow);
  return Math.max(this.prediction?.atMs ?? 0, cp.state!.frame * FRAME_MS,
    Math.min(cp.clock.simulationNow + elapsed + this.lead, cp.state!.frame * FRAME_MS + 2000));
}
```

`lead` is clamped to `[0, MAX_INPUT_LEAD_MS]`. It changes only between rounds in this
milestone.

**Invariants.** I10 (monotonic, enforced by the existing `max`), I1, I4, I8 (lead 0 by default).

**Edge cases.** A lead change while `prediction` exists (apply at the next identity change).
`frozen`. The 2000 ms cap (`lead ≤ 250` keeps it far below the cap). Pause/resume.

**Tests.** Harness: RTT 300 lead 104 → 0 rejections, 0 resets, opponent lag unchanged against
lead 0. RTT 40 lead 0 → identical metrics to baseline. 4p mixed with per-player leads → all
100%. Stamps never below `cp.state.frame` or above the server bound.

**Acceptance.** Matches the measured scratchpad results
([03 §3.5](03-LATENCY-AND-FAILURE-ANALYSIS.md#35-candidate-mitigations-measured)) inside the
upstreamed harness. Then a real far-host test per [07 §T-R](07-TESTING-AND-ACCEPTANCE-PLAN.md#real-browser-and-real-network-tests).

**Rollback.** Remove the parameter. Default behaviour is already lead 0.

**Risk.** Low.

---

## N3-C — Adaptive lead policy

**Objective.** Choose lead automatically, so nearby players get 0 and distant or jittery
players get enough.

**Files.** `session.ts` (an RTT ring independent of diagnostics, plus a policy),
`session-diagnostics.ts` (report lead and changes).

**Policy (normative).**

```text
constants: THROTTLE = 34, SAFETY = 15, STEP = ceil(F) = 17, MAX = MAX_INPUT_LEAD_MS, COMMIT = cp.clock.commitDelayMs
at each round start (identity change into a new round, before countdown ends):
    s = last ≤16 RTT samples (need ≥3; else keep previous lead, initially 0)
    base   = median(s) / 2
    spread = p95(s) − min(s)
    want   = ceil(base + spread + THROTTLE + SAFETY − COMMIT)
    lead   = clamp(max(want, lead − STEP), 0, MAX)     // decrease by ≤1 frame per round
during a round:
    on INPUT_REJECTED for a late input, or a stale-prediction release:
        lead = min(MAX, lead + STEP)                    // increase only; local time jumps ≤17 ms
```

**Invariants.** I8 (nearby → 0), I10, I1. Lead is never negative and never decreases mid-round.

**Edge cases.** Too few RTT samples at the first round. A route change mid-set. Spikes during
the countdown. A player at MAX who still sees lates (report it in diagnostics; do not exceed
MAX).

**Tests.** Harness: RTT 40 → lead 0 over 5 rounds. RTT 300 → lead converges ≤110 in round 1
with ≤1 reset. RTT 60 + 5% 150 ms spikes → after ≤2 rounds, ≤1 reset per minute.
RTT that drops from 300 to 40 mid-set → lead decreases ≤1 frame per round. Prediction
monotonic throughout.

**Acceptance.** [07 metrics](07-TESTING-AND-ACCEPTANCE-PLAN.md#quantitative-targets) Q1–Q4 met
in the harness.

**Rollback.** Revert to the N3-B fixed lead (0 by default).

**Risk.** Medium. The policy needs tuning on real data from N2-A.

---

## N3-D — Sliding-window clock estimate

**Objective.** Follow clock drift and route changes.

**Files.** `session.ts:449-460`.

**Required behaviour.** Keep the last 8 `(rtt, impliedOffset)` pong samples and use the offset
from the lowest-RTT sample in the window. The offset may change by at most ±2 ms per update.
The prediction's `max()` keeps time monotonic.

**Tests.** The harness gains a drift option (client clock rate `1 + δ`). At δ = 50 ppm for 30
simulated minutes at RTT 100: 0 rejections (baseline would accumulate lateness). Route change
(RTT 40 → 120 → 40): the offset follows within 8 pings.

**Rollback.** Revert.

**Risk.** Low.

---

## N2-C — Silence and outage policy

**Objective.** Stop the server from simulating stale held keys for seconds, and stop the client
from predicting inputs it cannot deliver.

**Evidence.** Traces: during a 3 s outage or a 6 s freeze, the server kept Left held for the
whole period. Inputs pressed in the first 2 s of an outage were rejected later
([03 §3.6](03-LATENCY-AND-FAILURE-ANALYSIS.md#36-browser-stalls-vs-network-stalls-measured-traces)).

**Files.** `rooms.ts` (tick: a silence check), `session.ts` (`canPlay` threshold).

**Required behaviour.**

* Server: during `playing`, if a seat has sent **no command at all** (pings arrive every 2 s
  from a live tab) for `SILENCE_MS = 3000`, call `invalidate(seat)` once. That releases controls
  through the recorder (a journaled `release`) and bumps the generation. Then send a checkpoint.
  Do not pause the room. Do not forfeit.
* Client: `canPlay` additionally requires `now − receivedAt < STALL_MS`, with
  `STALL_MS = max(750, lead + commitDelay + 400)`, replacing the 2000 ms constant only for
  input acceptance. Keep `resync` at 2000 ms.

**Owner decision (do not implement without it).** Should a lease loss (≥6 s) keep pausing the
whole room (current), or continue the round with the absent board's controls released for a
grace period, then pause? Document whichever is chosen in `packages/match/RULES.md`.

**Invariants.** I9 (only journaled `release`), I13, I7.

**Edge cases.** A player legitimately idle (not pressing) still pings, so is not affected. Pause
phases. Countdown. Silence exactly at round end. Reconnect within `SILENCE_MS`.

**Tests.** 3 s outage: no `INPUT_REJECTED`; the server releases at ~3 s; the journal has a
`release`; the replay verifies. A 6 s freeze with pongs alive: the server releases at 3 s, the
client resumes with a new generation and no stuck keys. RTT 60 + spikes: no false blocks
(`blockedPct` unchanged ±0.5).

**Rollback.** Revert both parts independently.

**Risk.** Medium (lifecycle). Keep the constants in one place.

---

## N4-A — Opponent replicas (smooth 60 Hz boards)

**Objective.** Draw opponents every frame by simulating them from the latest authoritative
checkpoint, at the same lag as today and without the 20 Hz stepping.

**Files.** New `packages/web/src/opponent-replicas.ts`. `online-view.ts:350-380` draws from
replicas instead of `cp.state.players[i].game`.

**Required behaviour.**

```ts
class OpponentReplicas {
  // rebuilt per checkpoint
  onCheckpoint(cp) { for each opponent id (not withdrawn): replicas[id] = new OwnerPrediction(cp.state, id); } // backlog enqueued by ctor
  // per animation frame
  displayTime(now) = max(lastDisplay, min(cp.state.frame*F + (serverNow() − cp.serverNow), cp.state.frame*F + REPLICA_MAX_AHEAD /*100 ms*/))
  frame(now) { t = displayTime(now); for each replica: replica.advanceToTime(t); draw(replica.gameState()) }
}
```

* Never go backwards (I10 for presentation). On round or match change, reset.
* Never send anything. Ignore replica events except for cosmetic notices.
* If a replica throws, for example on an invalid backlog after a reset, fall back to drawing the
  checkpoint state for that player.

**Why it is exact.** Anything stamped at or before the committed frame is in the checkpoint
state. Inputs in the backlog are accepted authoritative inputs. Packets sent after the
committed frame cannot become eligible within 333 ms, and the display is ≤100 ms ahead of
committed. So `t ≤ committed + 100 ms` is exact except for opponent inputs still in flight to
the server, which shows as at most a ≤100 ms local mispredict of that opponent.

**Must remain unchanged.** Own prediction, protocol, server, replay viewer.

**Tests.** Harness: for every rendered frame, the replica state at `t ≤ cp.state.frame·F`
equals the server `Match` state for that player at `t` (deep compare). Distinct opponent states
per second ≥ 55 at a 60 fps frame rate. Display time is monotonic. CPU per frame with 7
opponents < 0.5 ms (bench).

**Acceptance.** Opponent lag p50 within ±10 ms of baseline. The visual update rate goes from
~21 Hz to ~60 Hz.

**Rollback.** Feature flag `replicas=false` → draw checkpoint states.

**Risk.** Medium (presentation correctness, performance on weak laptops).

---

## N4-B — Live ops streaming *(gated)*

**Gate.** Only if, after N2-B, 8-player room egress exceeds what the chosen free host allows
(measure with the N2-A server counters).

**Objective.** Send incremental authoritative operations instead of full states at 20 Hz.

**Design.** The server keeps a per-room **live ops log**, separate from `MatchRecorder`, because
practice has no recorder and has extra ops (`practiceUndo`, `practiceReset`,
`setAttacksEnabled`). It broadcasts `{type:"ops", matchId, round, fromSeq, ops[], committedFrame,
digestEvery?}` at 20 Hz, sends full checkpoints on join, resync, identity change and every N
seconds, and sends a `stateDigest` every M frames. Clients keep a full `Match.fromState` replica
and apply ops in order. On a gap or digest mismatch they request a full checkpoint.

**Invariants.** I12 is replaced by "replica digest equals server digest at checkpoints". I3
(the client never sends ops). Ops order equals server application order.

**Tests.** Replica equals server over 10 min of 8-player harness play with spikes. Forced gaps
cause a resync. Digest mismatch (corrupt an op in test) causes a resync. Practice ops are
covered.

**Risk.** High (a new protocol surface). Do not start without N2-A data.

---

## N5 — Piece-guarded late re-timing *(gated; Match version bump)*

**Gate.** After N3-C, real-network diagnostics still show > 2 resets per minute caused by bursts
above a p99-sized lead.

**Objective.** Accept late inputs by re-timing them to the committed boundary, while
guaranteeing one-shots act on the intended piece.

**Design.** Optional `pieceSeq` on `InputItem`: the client's predicted board `sequence` (lock
count) at input time. `MatchInput` gains `pieceSeq?`. In `Match.advanceToFrame`, a one-shot
input whose `pieceSeq` differs from `game.state.sequence` at application time is **ignored**
(and journaled as a submitted input, so replays reproduce the ignore). Late inputs are
re-stamped by the server to `(match.frame, 0)` with a fresh `order` and acknowledged with a new
disposition `retimed`. The client treats `retimed` as accepted and rebuilds.

**Versioning.** `MATCH_VERSION` 3 → 4. Replay `matchState: 4`. Freeze the v3 engine in
`packages/engines/` and register it (M4-A). Update `packages/match/RULES.md`.

**Tests.** Wrong-piece regression (late hard drop followed by an on-time rotate). Held-transition
re-timing preserves DAS semantics. Golden v3 replays still verify with the v3 engine. New v4
replays verify.

**Risk.** High. Touches the simulation contract.

---

## N6 — Architecture C prototype *(conditional, experimental branch only)*

**Gate.** N5 shipped (or was rejected) and the owner still sees unacceptable input loss.

**Scope.**
1. Branch `experiment/netplay-c`. **No merge to main without an explicit owner decision.**
2. Phase 1, model only: implement C's rules ([04 §4](04-ARCHITECTURE-OPTIONS.md#4-architecture-c--hybrid-free-running-local-boards-server-scheduled-interactions))
   in the harness as a separate simulator. Replay identical recorded network traces (from
   N2-A logs) through A+ and C. Compare resets, corrections, garbage timing deviations and
   exploit windows.
3. Phase 2, only if C wins by the [07](07-TESTING-AND-ACCEPTANCE-PLAN.md#rejection-criteria-for-an-architecture-proposal)
   criteria: specify the `match-stream` replay kind, the server re-simulation, and anti-cheat
   bounds (Λ, ε) in `RULES.md` form **before** writing production code.

**Risk.** Very high. Most likely outcome: not needed.

---

## Replay track (M4)

All replay milestones follow [05](05-REPLAY-COMPATIBILITY.md). They are independent of netplay
decisions.

**Rollback (whole track).** M4-A is a pure refactor and can be reverted. M4-B…D add routes and
stored documents that are purely additive, so put them behind a feature flag. Disabling the
flag hides sharing without touching gameplay or the in-room replay flow. **Never delete stored
documents as a rollback step**, because share links depend on them. **Risks:** M4-A low; M4-B
medium (choosing storage that survives restarts on a free host); M4-C medium (authorisation
must mirror M3-B1 exactly); M4-D low; M4-E low.

### M4-A — Replay engine registry
* **Objective.** Route decode, verify and playback through `engineFor(header)` with exact-match
  keys. Register the current Sprint and Match engines.
* **Files.** New `packages/replay/src/registry.ts`. `decode.ts`, `verify.ts` and `match-playback.ts`
  callers, `web/replay-request.ts`, `web/sprint-playback.ts`.
* **Must remain unchanged.** Decoding strictness, error codes, all existing tests.
* **Tests.** Every existing replay test passes through the registry. An unknown key gives
  `unsupported`. The registry is immutable at runtime.
* **Rollback.** Revert (a pure refactor).

### M4-B — Replay store + golden corpus
* **Objective.** A `ReplayStore` interface with memory, filesystem/SQLite and blob backends.
  Add `packages/replay/fixtures/` with ≥5 sealed competitive replays and 2 Sprint replays.
* **Invariants.** Stored bytes = sealed canonical JSON (gzipped). The digest equals
  `integrity.digest`.
* **Tests.** put/get round-trip byte-identical. Golden corpus decodes, verifies and reaches the
  identical final digest.

### M4-C — Share endpoint + appearance records
* **Objective.** `POST /api/rooms/:code/replay/share` (same authorisation as M3-B1) stores the
  verified artifact and creates a `ShareRecordV1` with the sharer's appearance (built-in skins
  only). `GET /api/share/:id`, `GET /api/replays/:digest`.
* **Invariants.** I7 (practice → 404). Appearance never enters the journal or digest. Tokens are
  only ever sent in headers.
* **Tests.** Authorisation matrix (copied from the M3-B1 tests). Idempotent per digest. Size and
  rate limits. Invalid appearance is rejected or normalised to Classic.

### M4-D — Public viewer route
* **Objective.** `/r/:shareId` opens the existing competitive viewer without a session.
  Verification runs in the browser via the registry.
* **Tests.** Loads with no token. A tampered blob fails integrity. Unknown engine → clear
  message. Appearance applied. Exit returns to the homepage.

### M4-E — Cross-version CI
* **Objective.** A CI test that loads every fixture through the public read path on every commit.
  When an engine version changes, the PR must add the frozen engine and new fixtures.
* **Acceptance.** Fails if any golden replay stops verifying.

---

## Coordination notes

* `rooms.ts` is touched by N2-A, N2-B, N2-C, N3-A and M4-C. **Do not run two of these in
  parallel on the same branch.**
* `session.ts` is touched by N2-0, N2-A, N3-B, N3-C, N3-D and N2-C. Same rule.
* Every milestone updates `packages/match/RULES.md` or `docs/ARCHITECTURE.md` where a documented
  contract changes. The README says to do this.
* Every milestone re-runs `bun run test` and `bun run check`, and reports the test count.
