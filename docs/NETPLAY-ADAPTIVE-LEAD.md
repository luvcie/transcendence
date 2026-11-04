# Experimental adaptive input lead (N3-C)

N3-C implements the reviewed round-boundary design against HEAD
`299ed7033bb57b8aae94de4d4752bffeb5a53807`. The original baseline passed all
916 tests. This is an explicitly enabled experiment, **not approved for automatic
competitive rollout**. No server admission rule, shared clock, commitment delay,
Match rule or replay format changes.

## Configuration

Use `?diagnostics&lead=auto`. Configuration is read once when the page initializes;
reload to change it. Nothing stores lead in localStorage. Every player must opt in
separately. Generated invitations remove every `lead` parameter, including on
clipboard failure or when the clipboard API is absent.

| URL query | Mode |
| --- | --- |
| omitted, `diagnostics`, or `lead=auto` without URL diagnostics | zero |
| `diagnostics&lead=0` | fixed zero |
| `diagnostics&lead=104` | fixed 104 ms |
| `diagnostics&lead=auto` | adaptive |
| `diagnostics&lead=104&lead=auto` | fixed 104 ms |
| `diagnostics&lead=auto&lead=104` | zero |
| `diagnostics&lead=auto&lead=auto` | zero |

Only exact lowercase `auto` is accepted, and it must be the only `lead` parameter.
Numeric requests retain first-value precedence, unsigned decimal syntax, and the
250 ms manual maximum. Invalid numeric values still normalize to zero. A
localStorage diagnostics preference does not authorize either experiment.

## Observations and calculation

`adaptive-input-lead.ts` owns its observations independently of the diagnostics
RTT ring. It retains at most 16 matched, current-connection timestamped pongs for
32 seconds. Nonfinite timestamps, RTT outside 0–2,000 ms, and probes spanning a
detected browser scheduling gap greater than 250 ms are rejected. Collection
continues during waiting, preparation, countdown, play and pauses: process time
continues while simulation time is frozen.

Only adaptive mode probes every 500 ms until a calibration satisfies the span
and freshness requirements below. Retaining three observations alone is not sufficient.
There are at most four outstanding probes, expiring after two seconds. Normal
probing then returns to two seconds. Preparation and countdown are never delayed.
A decision requires the newest three observations to span at least one second,
all to be at most six seconds old, and the newest to be at most three seconds old.

At the decision boundary, choose the lowest RTT among those three; ties select
the newest. Latch its midpoint clock offset:

```ts
roundOffset = selected.serverPongMs
  - (selected.sentAtClientMs + selected.receivedAtClientMs) / 2;
effectiveTransit = sample.serverPongMs - sample.sentAtClientMs - roundOffset;
wanted = Math.ceil(p95EffectiveTransit + 34 + 20 - checkpoint.clock.commitDelayMs);
futureFrames = Math.ceil(MAX_INPUT_LEAD_MS / FRAME_MS) + 2;
ceiling = clamp(Math.floor(futureFrames * FRAME_MS - 20 - selected.rttMs / 2), 0, 160);
candidate = clamp(wanted, 0, ceiling);
```

The constants are throttle 34 ms, safety 20 ms, automatic maximum 160 ms and
decrease hysteresis 17 ms. Commitment uses the actual checkpoint value, currently
100 ms. RTT minimum, median and nearest-rank p95 and effective-transit median and
nearest-rank p95 are calculated over the valid bounded window. Even-count medians
average both central values. Nearest-rank p95 uses `ceil(.95 * n) - 1`; at this
window size it is the observed maximum, not a reliable population p95 estimate.
No extra RTT spread term is added.

Effective transit includes processing delay relative to the chosen clock. It is
not physical one-way latency. A sampled upstream delay can raise the proposal;
a downstream-only spike need not do so. The policy does not observe every burst.

Stable-path policy calculations are 0/44/54/104 ms at RTT 40/180/200/300 ms. At
RTT 300, the uncertainty ceiling is 113 ms. A request above its ceiling is marked
capped, even when a particular finite gameplay run happens to admit every item.

## Round and recovery behavior

The first checkpoint of `(room.code, matchId, state.round)` arms a decision.
Samples may continue arriving through countdown. Immediately before rebuilding
prediction from the first playing, unfrozen checkpoint, Session finalizes both
lead and clock offset. Both remain constant for the round. Later pongs only
inform future proposals; neither rejection nor stale-prediction release changes
the active decision. Generation, practice epoch and same-round reconnect cannot
reopen it. The existing target, monotonicity, frame floor, 2,000 ms cap, batching,
sequence ownership and timestamp conversion remain in use.

Insufficient or stale calibration selects zero for the entire round, with
`fallback-unwarmed` or `fallback-stale`. No adaptive offset is installed: the
existing zero-lead clock path remains active. Later calibration can only select
lead for a later round. There is no fixed-104 startup substitution.

A connection replacement clears observations and probes, while preserving a
completed same-round lead and calibration. A different room or match resets the
previous lead and decrease confirmation. Fresh observations from the same live
server connection may still be used. Leave, expiry and invalid match identity
clear the active decision.

A decrease needs three successive qualifying proposals spanning at least four
seconds. Each recommends at least 17 ms less than active lead; zero also
qualifies if active lead is below 17 ms. Apply the full confirmed decrease at the
next genuine boundary. A lower uncertainty ceiling takes precedence over
hysteresis. A 300→40 ms improvement may need the full 32-second window plus
confirmation time. A 40→300 ms deterioration can still cause failures for the
rest of a long round. There is no promise of immediate recovery.

No control release is introduced to force adaptation. N2-0 retains its absolute
500 ms recovery deadline. Transmitted inputs and surviving unsent Hard Drop,
rotation and Hold timestamps remain unchanged.

## Diagnostics

The existing snapshot retains RTT, age, margins, corrections, blocked-control
accounting, rejections and releases. Additions:

- `lead.mode`, `requestedMs` (null for auto), `appliedMs`, `proposedNextMs`,
  `wantedMs`, `ceilingMs`, `reason`, `capped`.
- `adaptive.sampleCount`, `newestSampleAgeMs`, `rttMin`, `rttMedian`, `rttP95`,
  `effectiveTransitMedian`, `effectiveTransitP95`, `decreaseConfirmed`.
- `clock.effectiveOffsetMs`, `selectedSampleAgeMs`, `selectedSampleRttMs`,
  `quality` (`unwarmed`, `fresh`, `stale`, `capped`).
- `adaptive.decisions`: at most 32 actual decisions/fallbacks with anonymous
  ordinal, previous/applied lead, reason and statistical inputs.

Proposed-next lead and statistical/quality fields describe the latest eligible
proposal; selected-sample age/RTT and effective offset identify the active
calibration. The selected sample can grow old while its round offset remains
latched. Decision history preserves the boundary's wanted value, ceiling and
reason, including caps. `clock.estimatedOffsetMs` and `bestRttMs` retain the
legacy estimator observation; gameplay uses `effectiveOffsetMs`.

A boundary checkpoint's age is sampled after its calibration is installed.
History excludes credentials, names, room codes and raw gameplay. Browser
`INPUT_REJECTED` remains a general rejection: it cannot distinguish all server
admission causes. The harness uses exact server admission classification.

## Deterministic measurements

[netplay-adaptive-lead-results.json](netplay-adaptive-lead-results.json) contains
all eleven scenarios, every player's counts, decision history, margins,
corrections, and clock checks. Run `runLeadExperiment` with `adaptiveExperiments`
and `routeExperiments` to reproduce it. Harness seed 42 and physical script seed
8 use real Session, Rooms, Match, recorder and replay verifier paths. No test
patches input stamps or clock offsets to simulate adaptive lead.

Every matrix case schedules the established physical input script for 30 seconds
plus 500 ms drain after calibration. Route scenarios first run five seconds of
taps/rotations on the changed route, then continue the same round for 46 seconds
total so old observations expire and lower proposals can confirm. They verify
immutable timing every 250 ms, end the round through normal gameplay, then run
30 seconds of the established script in the next round. Counts include the
transition inputs and failures; they are not discarded as warm-up.

Admission denominators count per-item server admission decisions. They exclude
commands rejected before admission and retransmissions. The table separately
reports WRONG_PHASE commands at round transitions. Each such command carries one
item in these fixtures. Thus RTT 300 has 150/150 admitted items but 152 items
sent and two WRONG_PHASE outcomes; it is not an overall 100% success claim.
Blocked-control percentage comes from the harness's independent event-interval
integration over the full eligible play time, including the route-observation
wait. Networking resets exclude deliberate user and wrong-phase releases.
Correction counts are classifications at matching prediction time, not counts
of distinct visible errors.

| Scenario, observed client | Selected lead ms | Admission accepted/total | Late/future/other | WRONG_PHASE | Network resets | Blocked % | Corrections piece/board/garbage | Replay |
| --- | ---: | ---: | --- | ---: | ---: | ---: | --- | --- |
| RTT 40, a | 0 | 152/152 | 0/0/0 | 0 | 0 | 0.0408 | 0/0/0 | pass |
| RTT 180, a | 44 | 152/152 | 0/0/0 | 0 | 0 | 0.0816 | 0/0/0 | pass |
| RTT 200, a | 54 | 152/152 | 0/0/0 | 0 | 0 | 0 | 0/0/0 | pass |
| RTT 300, a | 104 | 150/150 | 0/0/0 | 2 | 0 | 0 | 0/0/0 | pass |
| RTT 60 + seeded 5% 150 ms spikes, a | 133→133→134 | 152/152 | 0/0/0 | 0 | 0 | 0.4062 | 0/0/0 | pass |
| Mixed RTT 20, a | 0 | 152/152 | 0/0/0 | 0 | 0 | 0.0812 | 0/0/0 | pass |
| Mixed RTT 60, b | 0 | 152/152 | 0/0/0 | 0 | 0 | 0.0813 | 0/0/0 | pass |
| Mixed RTT 180, c | 44 | 152/152 | 0/0/0 | 0 | 0 | 0.0814 | 0/0/0 | pass |
| Mixed RTT 300, d | 104 | 152/152 | 0/0/0 | 0 | 0 | 0.0816 | 0/0/0 | pass |
| Asymmetric 20/180, a | 54 | 152/152 | 0/0/0 | 0 | 0 | 0.1223 | 0/0/0 | pass |
| Asymmetric 180/20, a | 54 | 151/151 | 0/0/0 | 2 | 0 | 0.0816 | 0/0/0 | pass |
| Route 300→40, a | 104→0 | 177/177 | 0/0/0 | 0 | 0 | 0 | 0/0/0 | pass |
| Route 40→300, a | 0→104 | 150/174 | 24/0/0 | 2 | 8 | 3.3655 | 0/0/0 | pass |
| Route 180/20→20/300, a | 54→103 capped | 176/176 | 0/0/0 | 2 | 0 | 0.0279 | 0/0/0 | pass |

Across these eleven competitive scenarios, 41,219 active server ticks match the
unchanged authoritative pace with zero violations. Every competitive prefix
verifies. Mixed players choose independently, without adding shared commitment
delay. Asymmetric calibration shifts from +80 to −140 ms only at the next
boundary. The new route wants 114 ms, capped at 103 ms by its 320 ms RTT. That
cap is a policy result, not a claim of complete latency compensation.

## Regression coverage and adversarial review

Pure policy tests cover exact statistics for counts 1–16, stable formulas, RTT
validation, freshness/span, tie selection, scheduling contamination, connection
isolation, bounded probes/samples/decisions, ceilings, decreases and nonfinite
values. Session tests cover URL authorization and duplicates, countdown timing,
cold fallback, round/connection/generation/epoch identities, reset/undo, frozen
checkpoints, clock paths, and sanitized diagnostics.

The N3-B suites retain their numeric zero/fixed fixtures and their gameplay
assertions. Additive diagnostic metadata is compared independently where mode
now distinguishes omitted zero from explicit fixed zero. The manual best-pong
selection still uses the all-connection minimum and strict lower-RTT replacement.
Omitted versus explicit zero compares commands, checkpoints, authority and
sealed replay content. Adaptive zero compares gameplay and journals under the
same clock mapping, excluding legitimate bootstrap ping differences.

All 38 existing recovery cases also run with a positive adaptive decision,
collected from actual high-RTT waiting pongs before returning to the original
recovery link. Numeric fixtures remain unchanged. This isolates recovery ordering
from steady transport lateness without injecting a policy decision. Coverage
includes checkpoint/timer/key-first recovery, 300 ms/1 s/1.8 s stalls, partial
prefixes, original absolute deadlines, full release, stale callbacks and exact
surviving/retransmitted input fingerprints.

Synthetic attack fixtures compare future-queued versus on-time submissions at
adaptive policy values 0/44/54/104 for crossing attacks, cancellation, locks and
garbage eligibility. Separate real Session practice fixtures compare adaptive
and fixed modes at each stable RTT with equal lead/clock mapping, including
Hard Drop, Hold, incoming garbage, exact batches, authoritative states/events and
prediction. They explicitly compare predicted piece/sequence against the first
authoritative lock and the predicted Hold piece against the authoritative held piece. No intended-piece mismatch was observed in these fixtures.
Synthetic boards are not used as competitive replay evidence.

The adversarial self-review checked activation, invitations, zero/fixed behavior,
warm-up, connection contamination, round clock immutability, rejection/recovery
triggers, identity changes, route future bounds, double offset/lead, bounded
state, frozen prediction, timestamps/fingerprints, reconnects, deadlines, piece
claims, caps and diagnostic privacy. It found and corrected one diagnostic
ordering defect: the first checkpoint at a new boundary could record age using
the previous calibration. Its regression asserts the new offset at the boundary.
No N2-0 implementation change was needed.

Initial N3-C validation:

- `bun test packages`: 1,052 passing tests across 65 files, zero failures;
  136 tests added to the confirmed 916-test baseline.
- Focused policy/Session/networking/recovery/Match/replay run: 536 passing tests
  across 19 files; additional boundary/diagnostics regressions: 102 passing tests.
- Strengthened positive-adaptive recovery suite: 133 passing tests; synthetic
  gameplay/piece comparison suite: eight passing tests.
- `bun run check`, `bun run build`, and `git diff --check`: pass.
- A separate strict TypeScript check of all five new test/experiment entry files
  passes. Code and documentation surface scans report no high-severity findings.

Modified files:

- `docs/NETPLAY-DIAGNOSTICS.md`
- `docs/NETPLAY-FIXED-LEAD.md`
- `packages/web/netplay-harness.ts`
- `packages/web/netplay-latency.test.ts`
- `packages/web/netplay-lead-experiment.ts`
- `packages/web/netplay-lead.test.ts`
- `packages/web/online-view.test.ts`
- `packages/web/session-diagnostics.test.ts`
- `packages/web/session-lead.test.ts`
- `packages/web/src/main.ts`
- `packages/web/src/netplay-options.ts`
- `packages/web/src/online-view.ts`
- `packages/web/src/session-diagnostics.ts`
- `packages/web/src/session.ts`

New files:

- `docs/NETPLAY-ADAPTIVE-LEAD.md`
- `docs/netplay-adaptive-lead-results.json`
- `packages/web/adaptive-input-lead.test.ts`
- `packages/web/netplay-adaptive-experiment.ts`
- `packages/web/netplay-adaptive-garbage.test.ts`
- `packages/web/netplay-adaptive.test.ts`
- `packages/web/session-adaptive.test.ts`
- `packages/web/src/adaptive-input-lead.ts`

All milestone changes remain unstaged and uncommitted. HEAD remains
`299ed7033bb57b8aae94de4d4752bffeb5a53807`. The two pre-existing untracked
research notes are preserved. Nothing was pushed or deployed.

## Limits and rollout

Expected timing tradeoffs include longer prediction ahead of authoritative
knowledge, waiting for the next round to change calibration/lead, conservative
capping and entire-round zero fallback on cold startup. The measured deterioration
case exposes failures during that wait; it is an explicit limitation of the
reviewed design. No claim extends these harness outcomes to every real browser,
burst, TCP queue or geographic route. The successful real-network fixed-104
sessions motivated this experiment; they are not measured adaptive results.

Unresolved competitive risks remain: future actions can be visible through
checkpoints or cancelled before execution; unknown garbage can diverge prediction;
Hard Drop/Hold can affect a different piece after divergence; midpoint clock bias
changes the physical input-to-stamp relationship; different valid leads can
produce different interaction outcomes. Converged boards and verified replays
do not establish intended-piece correctness or universal competitive fairness.
No piece guards or protocol changes are introduced. `lead=auto` remains an
experimental opt-in, with no automatic competitive rollout.

The original Opus roadmap and targets remain historical research. Their RTT-only
formula, rejection-driven increases and one-frame decrease limit are superseded
for N3-C by the reviewed design documented here.


## Bootstrap calibration correction

Independent review found that cadence used retained sample count while proposal
selection also required time span and freshness. A downstream hold could compress
several valid pong deliveries into the same instant, stopping fast probing before
calibration was eligible. Both paths now use the same `selectCalibration` function.
No formula, ceiling, round latch, recovery deadline or transport limit changes.
If calibration becomes stale, cadence returns to 500 ms until an eligible triple
exists again. This does not reopen an active or fallback round decision.

The focused reproduction uses real Session/Rooms/Match transport with seed 42,
25 ms browser frames, A at 90/90 ms and B at 20/20 ms. A downstream hold starts
at 675 ms during countdown and lasts 1,700 ms; browser frames continue. Valid
observations arrive at 380/2375/2375/2375/2380 ms. At 2425 ms, five samples are
retained but no eligible triple exists. Before the fix the next probe was at
4200 ms, and the first playing checkpoint at 3790 ms selected `fallback-stale`.

After the fix, probes continue at 2700 and 3200 ms. Their observations at 2880
and 3380 ms establish an eligible triple before the same 3790 ms playing
checkpoint, which selects 44 ms. Probing then returns to two seconds, with the
next probe at 5200 ms. The lead remains fixed throughout gameplay.

The established seed-8 physical script schedules 16 actions over 2,500 ms for A,
followed by 500 ms to drain the real transport. Before the fix, 13 items were sent
and reached admission: 10 accepted, three late, zero future. Three recovery
resets blocked the remaining physical actions. After the fix all 16 items were
sent and admitted: 16 accepted, zero late/future/other, zero recovery resets.
No WRONG_PHASE commands are omitted from the corrected fixture's denominator.
Both runs retain the same first-playing time, pass all 312 active authoritative
pacing checks, and verify their competitive replay prefixes.

Nine focused tests were added: compressed observation eligibility; both freshness
limits; connection replacement/stale-pong isolation; the countdown hold; and
omitted/zero/fixed-104/fixed-250 cadence compatibility. Existing cold-start tests
now also assert that recovery/generation changes cannot relatch a zero fallback.
The focused policy/clock/Session/network run passes 305 tests across eight files.
The four confirmed cadence/reproduction failures were observed before the fix
and pass after it. The original eleven-scenario result artifact above is retained
as the measurement from the initial N3-C implementation.


Bootstrap correction validation: `bun test packages` passes 1,061 tests across
66 files with zero failures (nine added to the 1,052-test review baseline).
`bun run check`, `bun run build`, `git diff --check`, and a separate strict
TypeScript check of the affected test entry files pass. Focused self-review
checked cadence transitions, identical eligibility gates, freshness expiry,
connection replacement, stale pongs, probe bounds and fallback immutability;
no further defect was found. All changes remain unstaged and uncommitted.
