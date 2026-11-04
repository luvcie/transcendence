# Experimental fixed client input lead (N3-B)

N3-C now adds an explicit `?diagnostics&lead=auto` experiment. See
[NETPLAY-ADAPTIVE-LEAD.md](NETPLAY-ADAPTIVE-LEAD.md) for its reviewed policy,
round clock latch, measured results and limitations. The fixed-lead measurements
below remain the historical N3-B results; numeric fixed behavior is preserved.

Implemented against HEAD `a91ee98` on 2026-11-04. **READY FOR REVIEW for controlled experiments only.** Lead is disabled by default. The baseline was confirmed locally: **797 passing tests, 0 failures**. No accessible `review.md` was found in the project; the owner's supplied Astra requirements take precedence over the older roadmap.

The application reads `?diagnostics&lead=104` once at page load and forwards the normalized value through `mountOnline` to its real Session. Explicit URL diagnostics authorization is required. localStorage diagnostics alone cannot authorize lead. Omitted lead and explicit zero have identical timing. Finite unsigned decimal values from 0 through `MAX_INPUT_LEAD_MS` (250 ms) are accepted; malformed, negative, empty, nonfinite and out-of-range values become zero. Exponent, hexadecimal and whitespace forms are rejected. The first duplicate numeric lead parameter wins; diagnostics retains its existing presence-based semantics, including `diagnostics=false`. Reload to change the request; there is no runtime configuration interface. Adaptive mode is a separate N3-C opt-in.

Generated room invitations preserve the room and existing URL fields but remove every `lead` parameter. Clipboard success, fallback text and clipboard failures all use the same lead-free URL. Opening an ordinary invite therefore requests zero lead; copying it does not change the sender's active lead. Explicitly constructed experimental URLs still use the existing strict opt-in rules.

Session captures the request at construction. Its separate lead identity is `(room.code, matchId, state.round)`, using fields present in authoritative checkpoints. It latches the request before rebuilding the first prediction for that round. Generation and practice epoch remain part of the existing recovery identity, but do not change the lead latch. Recovery, release, checkpoint expiry, reconnect and pause/resume preserve the active lead. A new room/match/round initializes its own latch from the immutable request. Leave, session expiry and a checkpoint with no match state clear the applied value until a round checkpoint arrives. A fresh Session without configuration always starts at zero.

The target is exactly:

```ts
const base = cp.state.frame * FRAME_MS;
const running = !cp.clock.frozen && room.phase === "playing";
const elapsed = running ? Math.max(0, serverNow() - cp.serverNow) : 0;
return Math.max(
  prediction?.atMs ?? 0,
  base,
  Math.min(
    cp.clock.simulationNow + elapsed + (running ? activeLeadMs : 0),
    base + 2000,
  ),
);
```

Only prospective input timestamps and owner prediction gain lead. Existing timestamp conversion, frame/subframe rounding, 34 ms batching, sequencing, retransmission fingerprints, checkpoint reconciliation and N1-B/N2-0 recovery are preserved. No previously transmitted input or surviving one-shot is restamped. Preparation, countdown, pause, results and frozen clocks add no lead. `Math.max` can preserve a prediction already rendered ahead when a pause arrives, but repeated paused checkpoints do not advance it further. The 2,000 ms cap bounds the candidate target; monotonic preservation remains outside that minimum, as in the original implementation.

Diagnostics now expose `lead.requestedMs`, `lead.appliedMs`, the gameplay offset, best pong RTT and a calibrated flag, in addition to existing offset samples and drift. Requested means the normalized request, not the raw URL text. In zero/fixed modes these measurements do not drive a timing policy. Adaptive mode owns a separate bounded observation window.

The following measurements use actual Session, Rooms, Match, recorder and replay verifier paths. Harness seed is 42, per-player play-script seed is 8, with 30 seconds of physical input scheduling plus 500 ms to drain in-flight inputs. Inputs, early failures and recovery resets are included for the whole run. No clock offset is manipulated to imitate lead. Fixed-delay cases use no jitter or bandwidth limit. Unless the row says mixed, client b has RTT 40 ms and zero lead. Admission percentages count actual per-item server admission decisions, excluding duplicate fingerprints and commands rejected before per-item admission. Blocked physical actions are not counted as accepted; their effect is reported separately by blocked-control time. Outcomes and action counts can differ because lead changes legitimate gameplay timing.

The regular matrix calibrates during the real preparation/countdown, before play. All its admitted inputs are therefore post-pong. Explicit cold-clock cases below withhold application pongs through the first two seconds of play, while retaining checkpoints, then allow normal probing to calibrate. The before/after split labels calibration at server admission time. Complete per-client data, counts, distributions, corrections and clock checks are in [netplay-fixed-lead-results.json](netplay-fixed-lead-results.json).

| Scenario (up/down ms) | Lead ms | Accepted/attempted | Accepted % | Late | Recovery resets | Blocked % | Send margin p5/p50 ms | Checkpoint age p50/p95 ms | Replay prefix |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 20/20 omitted lead | 0 | 152/152 | 100 | 0 | 0 | 0.04 | 72/100 | 20/20 | pass |
| 20/20 | 0 | 152/152 | 100 | 0 | 0 | 0.04 | 72/100 | 20/20 | pass |
| 90/90 | 0 | 96/124 | 77.42 | 28 | 28 | 20.64 | 72/81 | 90/90 | pass |
| 90/90 | 44 | 152/152 | 100 | 0 | 0 | 0.08 | 116/144 | 90/90 | pass |
| 100/100 | 0 | 73/125 | 58.4 | 52 | 35 | 28.56 | 71/81 | 100/100 | pass |
| 100/100 | 60 | 152/152 | 100 | 0 | 0 | 0 | 131/160 | 100/100 | pass |
| 150/150 | 0 | 0/150 | 0 | 150 | 38 | 45.96 | 71/100 | 150/150 | pass |
| 150/150 | 100 | 150/150 | 100 | 0 | 0 | 0 | 171/200 | 150/150 | pass |
| 150/150 | 104 | 150/150 | 100 | 0 | 0 | 0 | 175/204 | 150/150 | pass |
| 150/150 | 120 | 150/150 | 100 | 0 | 0 | 0 | 191/220 | 150/150 | pass |
| 175/175 | 0 | 0/71 | 0 | 71 | 29 | 41.05 | 72/100 | 175/175 | pass |
| 175/175 | 160 | 150/150 | 100 | 0 | 0 | 0.12 | 231/260 | 175/175 | pass |
| 20/180 | 0 | 70/121 | 57.85 | 51 | 34 | 27.84 | 72/81 | 100/100 | pass |
| 180/20 | 0 | 62/118 | 52.54 | 56 | 36 | 29.02 | 72/81 | 100/100 | pass |
| 20/180 | 84 | 152/152 | 100 | 0 | 0 | 0.12 | 156/184 | 100/100 | pass |
| 180/20 | 84 | 151/151 | 100 | 0 | 0 | 0.08 | 156/184 | 100/100 | pass |
| 30/30 + 5% 150 ms spikes | 0 | 132/148 | 89.19 | 16 | 7 | 2.56 | 72/100 | 30/170 | pass |
| 30/30 + 5% 150 ms spikes | 120 | 152/152 | 100 | 0 | 0 | 0.16 | 192/220 | 30/174 | pass |
| 150/150 cold clock | 100 | 134/146 | 91.78 | 12 | 4 | 4.9 | 171/200 | 150/150 | pass |
| 150/150 cold clock | 104 | 134/146 | 91.78 | 12 | 4 | 4.9 | 175/204 | 150/150 | pass |
| 150/150 cold clock | 120 | 134/147 | 91.16 | 13 | 4 | 4.9 | 191/220 | 150/150 | pass |

Spikes are seeded per-message additions on either direction, preserving ordered transport delivery. Send margin is stamp minus the estimated committed boundary at send, **before remaining upstream transit**, not a guarantee of admission. Checkpoint age includes estimator bias: for asymmetric 20/180 and 180/20 links it reports approximately 100 ms, rather than the physical downstream delay. Distributions in this artifact retain the entire measured run, unlike the browser's bounded recent rings. No future-window or other per-item admission rejection occurred in any of the 23 scenarios.

For comparison, Astra's supplied zero-lead measurements were 100%, 76.9%, 63.1%, 0%, 0% at RTT 40, 180, 200, 300, 350 ms. This implementation's controlled fixture measured 100%, 77.42%, 58.4%, 0%, 0%. Those are separate fixtures, not interchangeable baselines. Its corresponding positive-lead runs reached 100% with 44, 60, 100/104/120 and 160 ms respectively. The 40 ms omitted-versus-zero regression compares complete commands, checkpoints, authoritative states, diagnostics and sealed replay content for equality.

At RTT 300 with cold clock, leads 100 and 104 admitted 134/146 inputs overall (91.78%): 0/12 before calibration and 134/134 after. Lead 120 admitted 134/147 (91.16%): 0/13 before and 134/134 after. Each cold run had four recovery resets and 4.90% blocked time. These startup failures remain visible; N3-B does not change welcome seeding or the best-RTT estimator.

The four-player room uses RTTs 20/60/180/300 ms. Lead is enabled only for the two distant clients:

| Run | Client | RTT ms | Lead ms | Accepted/attempted (%) | Late | Resets | Blocked % | Send margin p5/p50 ms | Checkpoint age p50/p95 ms | Replay |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| mixed zero | a | 20 | 0 | 68/68 (100%) | 0 | 0 | 0.19 | 72/100 | 10/10 | pass |
| mixed zero | b | 60 | 0 | 68/68 (100%) | 0 | 0 | 0.19 | 72/100 | 30/30 | pass |
| mixed zero | c | 180 | 0 | 130/161 (80.75%) | 31 | 31 | 18.31 | 71/100 | 90/90 | pass |
| mixed zero | d | 300 | 0 | 0/192 (0%) | 192 | 48 | 47.25 | 72/100 | 150/150 | pass |
| mixed lead | a | 20 | 0 | 152/152 (100%) | 0 | 0 | 0.08 | 71/100 | 10/10 | pass |
| mixed lead | b | 60 | 0 | 152/152 (100%) | 0 | 0 | 0.08 | 71/100 | 30/30 | pass |
| mixed lead | c | 180 | 44 | 152/152 (100%) | 0 | 0 | 0.08 | 115/144 | 90/90 | pass |
| mixed lead | d | 300 | 104 | 152/152 (100%) | 0 | 0 | 0.08 | 175/204 | 150/150 | pass |

Low-RTT clients keep lead zero, 100% admission, a 100 ms median send margin and their own 10/30 ms checkpoint ages. Their action counts differ between rooms because high-RTT inputs now execute and can change elimination/round timing. No assertion requires identical scores, boards, attacks, lifetimes or game outcomes across lead settings. There is no room-wide commitment delay. Across all 23 runs, **57,264 active server ticks** matched the unchanged authoritative target `floor(max(0, simulationNow - 100) / FRAME_MS)` with **zero clock violations**. A maximum-lead regression separately proves that a queued rotation has not executed at its stamped frame boundary and executes only when authority advances past its subframe. Maximum 250 ms lead was also accepted on real midpoint-biased 20/180, 180/20 and 150/150 paths.

All 38 positive-lead N1-B/N2-0 recovery and ordering cases pass, alongside the same suites at zero lead. Assertions cover timer-first and key-first stalls, 300 ms/1 s/1.8 s stalls, neutral taps and held releases, partial prefix recovery, expiry during deferral, full release, gap retry, generation/epoch/round isolation, real reconnect and cancelled callbacks invoked after fresh inputs. They preserve per-generation sequence ownership and exact retransmission fingerprints. Corrective Left/Right/Soft Drop releases precede newer one-shots at their original stamps. Newly stale one-shots are dropped. Repeated partial recovery retains the original 500 ms deadline; overdue key handlers cannot renew it. A stale transmitted-input fixture uses a 500 ms upstream hold for positive lead, because 104 ms legitimately covers the original steady link; the zero-lead fixture remains unchanged. The partial-recovery success fixture allows an additional lead interval for the corrective future-stamped release to execute, without changing the recovery deadline or assertions. No recovery implementation was changed to pass these tests.

Garbage tests use the real Match engine. Future-queued and on-time submissions from identical synthetic initial states produce equal states/events for same-frame attack crossing, FIFO cancellation and locks just before/at the 20-frame (~333 ms) eligibility boundary. Practice Session fixtures at leads 0/104/250 reconcile incoming garbage without input rejection or control reset. A withheld incoming attack with 250 ms lead causes a board correction across Hard Drop and Hold near a piece transition, then converges; Hold's transmitted timestamp remains unchanged. Synthetic boards are not replay-verifiable fixtures. They run without a recorder or as standalone Match comparisons. Ordinary competitive latency runs and the completed-set replay use original seeds/configuration without synthetic board changes.

The authoritative journal remains the source of truth. All 23 scenario prefixes verify, as do the recovery fixtures that build prefixes and a completed competitive set containing positive-lead inputs. Accepted inputs retain their recorded frames/subframes. Replay format, engine versions and journal semantics are unchanged; lead is not a replay gameplay field. Practice reset/epoch changes still create no recorder.

Practical fairness remains limited. Future stamping cannot accelerate authority, but a positive lead does not guarantee a stamp after the physical keypress. A real 20 ms upstream/180 ms downstream regression measures an offset of -80 ms: with 44 ms lead, the input receives a timestamp **36 ms before physical keypress simulation time** and is admitted by the unchanged rules. Lead can widen the interval in which prediction lacks incoming attack information. Unknown garbage or partial rejection can still make a one-shot affect a different piece, because this protocol has no piece-sequence guard. Existing full authoritative checkpoints may expose queued future inputs to modified clients; this disclosure was neither expanded structurally nor resolved. Long path outages, main-thread behavior, real-host deployment and subjective competitive acceptability remain outside these deterministic measurements. Browser/real-network trials and broader garbage gameplay sweeps are follow-ups requiring owner direction; they are not claimed complete here.

Adversarial review checked mid-round configuration mutation (captured immutably), generation and practice-epoch changes, new-room/match initialization, pauses/frozen/countdown clocks, monotonic stamps, transmitted/surviving one-shot immutability, deferral deadline renewal, upper future bound, welcome-only/pong bias, cross-player assumptions, forced garbage corrections, replay consistency and diagnostics URL authorization. Regression tests cover each class. No confirmed production defect remains from that review; startup timing and fairness limitations above remain experimental constraints.

The production diff is confined to client configuration, prediction and diagnostics. Server input admission, protocol schemas, Match rules, replay engines/journals, checkpoint cadence, authentication and deployment are unchanged. N3-C has not been started.

| Changed file | Purpose |
| --- | --- |
| `packages/web/src/session.ts` | Safe normalization, immutable request, round latch, reviewed target and diagnostic clock state |
| `packages/web/src/netplay-options.ts` (new) | Testable URL authorization and decimal parsing |
| `packages/web/src/main.ts` | Read the URL once and forward the option |
| `packages/web/src/online-view.ts` | Configure the actual Session and keep generated invites lead-free |
| `packages/web/src/session-diagnostics.ts` | Requested/applied lead and calibration fields |
| `packages/web/netplay-harness.ts` | Genuine independent per-client Session lead |
| `packages/web/netplay-latency.test.ts` | Preserve zero-lead assertions and run recovery at positive lead; garbage reconciliation |
| `packages/web/netplay-lead-experiment.ts` (new) | Seeded matrix and whole-run per-client measurement collection |
| `packages/web/netplay-lead.test.ts` (new) | Latency, clock authority, replay, fairness and synthetic attack regressions |
| `packages/web/session-lead.test.ts` (new) | Parsing, target, immutable lifecycle, reconnect and practice reset regressions |
| `packages/web/session-diagnostics.test.ts` | Assert the expanded unavailable-clock diagnostics shape |
| `packages/web/online-view.test.ts` | Assert Session forwarding and lead-free invites on clipboard success and fallback paths |
| `docs/NETPLAY-DIAGNOSTICS.md` | Experimental URL, deployment prerequisite, lifecycle and field documentation |
| `docs/NETPLAY-FIXED-LEAD.md` (new) | This implementation and review report |
| `docs/netplay-fixed-lead-results.json` (new) | Full measured scenario data |

Validation completed successfully:

| Check | Result |
| --- | --- |
| Baseline `bun test packages` before edits | 797 pass, 0 fail, 59 files |
| Final `bun test packages` after invitation regressions | 916 pass, 0 fail, 61 files; 46,744 assertions |
| Focused invitation, online-view, configuration, Session and lead suite | 146 pass, 0 fail, 5 files; 15,522 assertions |
| Focused `bun test packages/replay` | 122 pass, 0 fail |
| Seeded measurement generation | 23 replay prefixes pass; zero future/other admission rejections; zero authority-clock violations |
| `bun run check` | Pass for every configured package and root check |
| Strict standalone TypeScript check of the three new test/experiment modules | Pass |
| `bun run build` | Pass, Vite 7.3.6 production build |
| `git diff --check` | Pass |
| Code/prose surface scans plus manual scope and adversarial diff review | No confirmed implementation defect |

No browser or remote-host compatibility claim is made. N3-A must be confirmed deployed on the chosen server before using nonzero lead there. The protocol cannot negotiate support. Verdict: **READY FOR REVIEW, controlled experiments only**.

To reproduce the seeded matrix without changing clocks:

```bash
bun test packages/web/netplay-lead.test.ts
bun test packages/web/netplay-latency.test.ts packages/web/session-lead.test.ts packages/web/session-diagnostics.test.ts packages/web/online-view.test.ts packages/replay packages/server
bun test packages
bun run check
bun run build
git diff --check
```

To retain fresh measurements without overwriting the checked-in report data:

```bash
bun -e 'import {leadExperiments, runLeadExperiment} from "./packages/web/netplay-lead-experiment"; for (const scenario of leadExperiments) { const {result} = await runLeadExperiment(scenario); console.log(JSON.stringify(result)); }' > /tmp/42tris-n3b-results.jsonl
```
