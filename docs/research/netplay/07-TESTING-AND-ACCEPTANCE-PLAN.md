# 07 — Testing and acceptance plan

> Baseline `a4a9e8e` (N1-B; 648 passing tests), 2026-11-03. Every milestone in
> [06](06-IMPLEMENTATION-ROADMAP.md) must add the tests listed for it here and keep
> `bun run test` and `bun run check` green. Report the test count in each commit message or PR.

Related: [03 measurements](03-LATENCY-AND-FAILURE-ANALYSIS.md) · [Appendix A harness](appendix-A-experiment-harness.md).

---

## Test layers

| Layer | Tooling (no new dependencies) | Purpose | Where |
|---|---|---|---|
| Unit | `bun:test` | Pure functions: lead policy, clock window, diagnostics math, registry lookup, checkpoint builder | next to the source |
| Deterministic integration | `bun:test` + real `Rooms` / `Match` / `Session` in-process | Admission, ack, release, generation, recorder | `packages/server/test`, `packages/web/*.test.ts` |
| **Fake-time netplay harness** | N-player harness (port of [Appendix A](appendix-A-experiment-harness.md)) | Latency, jitter, spikes, stalls, outages, bandwidth model, mixed rooms, replay validity | `packages/web/netplay-*.test.ts` |
| Real sockets | Existing Elysia loopback tests | Transport limits, heartbeat, HTTP replay/share endpoints | `packages/server/test/websocket.test.ts` |
| Golden replays | Stored sealed fixtures | Backward compatibility of replays and links | `packages/replay/fixtures` (M4-B) |
| Real browser, real network | Manual protocol + OS network emulation (`tc netem` on Linux, Network Link Conditioner on macOS, `clumsy` on Windows; all free) + `?diagnostics` | What the harness cannot show: rendering, GC, TCP, TLS/proxies, hosts | [below](#real-browser-and-real-network-tests) |

**Harness rules.** Fixed seeds. No real sleeping. Assertions on metrics, never on wall time.
Scenarios run ≥30 simulated seconds of bot play (the scripted player in Appendix A, ~1.6
pieces/s with sub-34 ms bursts). After every scenario, seal the recorder prefix and run
`verifyMatchReplayExecution`.

---

## Quantitative targets

These are the numbers a milestone is accepted against. "Resets" = `releases.total` excluding
`user` and the bot's round-transition `wrong-phase`. "Blocked" = `control.blockedPct` (N2-A).

| ID | Condition (harness) | Baseline today [measured] | Target |
|---|---|---|---|
| Q1 | RTT ≤ 60, no spikes, 2–8 players | 0 resets, 100% accepted, opponent lag p50 158–160 ms | **Unchanged** (I8): 0 resets; opponent lag p50 ≤ baseline + 5 ms |
| Q2 | RTT 100–150 | 0 resets | 0 resets, ≥ 99.9% accepted |
| Q3 | RTT 180–300 (±15 jitter) | 11–38 resets / 30 s; 0–89% accepted | After N3-C: ≤ 1 reset in round 1, then ≤ 0.5 / min; ≥ 99.5% accepted; lead ≤ 120 ms |
| Q4 | RTT 300–350 | 0% accepted | ≤ 1 reset / min after round 1; lead ≤ 160 ms |
| Q5 | RTT 400–600 | 0% accepted | Degraded but playable: ≤ 2 resets / min; lead ≤ `MAX_INPUT_LEAD_MS` |
| Q6 | RTT 60 + 5% +150 ms spikes | 9–18 resets / min | ≤ 1 reset / min after 2 rounds |
| Q7 | Bandwidth, after N2-B | 2p 0.56–0.93 MB/s; 8p 1.6–1.9 MB/s per client | 2p ≤ 150 KB/s; 8p ≤ 600 KB/s per client (8p room egress is still ~4 MB/s; see N4-B gate) |
| Q8 | Server CPU per simulated second, 8p (reference machine) | 52–55 ms | ≤ 15 ms after N2-B |
| Q9 | Browser stall 300 ms / 1 s / 3 s, including a stall inside the throttle window | `a4a9e8e`: 0 resets when checkpoints are processed first; 1 reset in each of 3 alternative post-stall orderings | After N2-0: 0 resets in every ordering; no stuck keys |
| Q10 | 3 s two-way outage with keys pressed | 2 rejections + 1 reset; server held key 3 s | After N2-C: 0 `INPUT_REJECTED`; held keys released at ≤ 3.1 s and journaled |
| Q11 | Opponent update rate (60 fps client) | ~21 distinct states / s | After N4-A: ≥ 55 / s, lag p50 ≤ baseline |
| Q12 | Replay validity | 100% of runs verifiable | 100%, plus golden corpus green |
| Q13 | Garbage insertion corrections for RTT ≤ 200 with lead | not measured | 0 per attack (derived window < 333 ms) |

Targets for real networks ([below](#real-browser-and-real-network-tests)) are the same with a tolerance of ×2 on reset rates, because the
real network adds variance.

---

## Unit tests (per milestone)

| ID | Milestone | Test |
|---|---|---|
| T-U1 | N3-C | Lead policy: given RTT samples `[40×16]` → 0; `[300×16]` → 104 ± 2; with spikes → ≥ spike-sized; never exceeds MAX; decreases ≤ 1 frame per round; never decreases mid-round |
| T-U2 | N3-D | Sliding-window offset: follows a linear drift of 50 ppm; ignores a single low-RTT outlier older than the window; per-update change ≤ 2 ms |
| T-U3 | N2-A | Diagnostics percentiles and rings bounded; JSON round-trip; no `resumeToken`/names |
| T-U4 | N2-B | Checkpoint builder: events subset contains the latest `roundEnd`/`setEnd`; `owner` ack per seat; `state` identical object content for all seats in one broadcast |
| T-U5 | M4-A | Registry exact-key lookup; unknown → `unsupported`; registry frozen |
| T-U6 | N5 | `pieceSeq` mismatch ignores a one-shot; matching applies; held transitions unaffected |

---

## Deterministic integration and harness tests

### Latency matrix (port from [03 §3](03-LATENCY-AND-FAILURE-ANALYSIS.md#3-measured-results))

| ID | Scenario | Asserts |
|---|---|---|
| T-H1 | 2p symmetric RTT {10, 40, 60, 100, 140} | Q1/Q2 |
| T-H2 | 2p RTT {180, 200, 250, 300} ± 15 jitter, adaptive lead | Q3/Q4 |
| T-H3 | 2p RTT {400, 600}, adaptive lead | Q5 |
| T-H4 | Asymmetric 20/180, 180/20, 60/140 | Acceptance identical within ±3% (validates the offset model) |
| T-H5 | RTT 60 and 160 + 5% +150 ms spikes | Q6 |
| T-H6 | Bandwidth model 2 MB/s and 500 KB/s (kernel buffer 0 and 1 MB), after N2-B | Checkpoint age p95 ≤ RTT/2 + 80 ms at 500 KB/s |
| T-H7 | Lead does not change **other** players' metrics: 4p 20/60/180/300 with and without lead for the 180/300 players | 20 ms and 60 ms players' opponent lag and accepted % within ±2% |
| T-H8 | Drift 50 ppm, 30 min, RTT 100 (after N3-D) | 0 rejections |

### Stalls, outages, reconnection

| ID | Scenario | Asserts |
|---|---|---|
| T-C1 | Browser stall 300 ms / 1 s / 3 s, random bot timing + the throttle-window case | Q9; seq numbers unique; no stuck keys on the server (`leftHeld/rightHeld/softHeld` false after key-up) |
| T-C1b | N2-0 post-stall orderings: (a) checkpoints first, (b) trailing-flush timer first (first checkpoint delayed 20 ms), (c) key press at stall end before checkpoints, (d) 1 s stall with timer first, (e) no checkpoint within `DEFER_MAX_MS` | (a)–(d): `staleRecovery.count === 1`, 0 `INPUT_REJECTED`, 0 releases, same generation; (e): exactly one release; never a seq transmitted twice with different content |
| T-C2 | 3 s two-way outage with Left held, Left-up and Rotate in the outage | Q10; the journal contains `release` for the seat; the replay verifies |
| T-C3 | 6 s browser freeze with pongs alive | No lease loss; server releases at ~3 s (N2-C); the client resumes on a new generation |
| T-C4 | 6 s two-way outage | Lease closed at 6 s ±0.25; room paused; reconnect; preparation; countdown; Match resumes identical (`saveState` deep-equal before/after pause) |
| T-C5 | Disconnect during countdown / round result / preparation | Existing behaviour preserved (`rooms.test.ts:352,381`) |
| T-C6 | Reconnect while lead > 0 | Lead preserved per policy; first post-reconnect inputs accepted |
| T-C7 | Generation isolation under delayed downstream (existing N1-A test) with lead | Unchanged |
| T-C8 | Reconnect abuse: 5 disconnects in 60 s | Today each reconnect-then-disconnect starts a fresh 40 s reservation and a new room pause; assert the current behaviour, then whatever pause limit the owner chooses (policy decision) |

### Multi-player

| ID | Scenario | Asserts |
|---|---|---|
| T-M1 | 3p, one player disconnects and expires; FFA continues | Existing semantics; replay verifies |
| T-M2 | 8p all RTT 40 for 60 s | Q1, Q7, Q8 |
| T-M3 | 8p mixed 10…300 with adaptive lead | Every player ≥ 99% accepted after round 1; replay verifies |
| T-M4 | Simultaneous top-outs in one frame (scripted) under lead | Draw / survivor semantics unchanged |

---

## Fairness and garbage tests

| ID | Test | Method |
|---|---|---|
| **T-G1** | Garbage insertion mispredictions vs. prediction window | **Specified, not yet built.** (1) Run a real `Match` with a scripted attacker. Inject an initial board via `Match.fromState` **once before play**, then send only inputs that produce known tetrises, so the client stream is never disturbed mid-session (the scratchpad attempt replaced `room.match` repeatedly and was invalid). (2) Record the authoritative checkpoints. (3) Feed them to a recipient `Session` through a stub transport with configurable delay `D` and lead `ℓ`, while the recipient hard-drops on a fixed schedule. (4) Count `corrections.board` per attack. Assert 0 when `100 + D + 25 + ℓ < 333`, and > 0 for some schedule when it is larger. |
| T-G2 | Same-frame crossing attacks cancel FIFO (existing `match.test.ts`), with inputs arriving via lead stamps | Results identical to on-time stamps |
| T-G3 | Backdating bound identical for every lead | For leads {0, 50, 250}: an input stamped at `match.frame − 1` is rejected; at `match.frame` accepted |
| T-G4 | Lead does not let a client act earlier on the shared timeline | For any lead, an input's effective time ≥ its physical send time's server estimate |
| T-G5 | Determinism under transport variation | The same set of accepted `(stamp, order)` inputs yields the same final digest, regardless of arrival batching (re-run the journal with a different batch split) |

---

## Anti-cheat tests

| ID | Attempt | Expected |
|---|---|---|
| T-A1 | Extra fields in `inputBatch`/`hello` (boards, attacks, player IDs) | `INVALID_MESSAGE` (existing schema tests, keep them) |
| T-A2 | Stamp below the committed frame | `INPUT_REJECTED` |
| T-A3 | Stamp beyond now + `MAX_INPUT_LEAD_MS` + 2 frames | `INPUT_REJECTED` |
| T-A4 | Faster-than-real-time: send stamps advancing 2× wall time | Rejected once beyond the future bound; commits never outrun the server clock |
| T-A5 | Seq reuse with a different fingerprint | `SEQ_CONFLICT`, socket closed |
| T-A6 | Old generation / epoch / matchId | `STALE_INPUT` |
| T-A7 | Rate abuse: 100 `resync`/s or `inputBatch`/s | Rate limit; **after N2-B3, ≤ 1 checkpoint per seat per 20 ms and server egress for that socket ≤ the budget** |
| T-A8 | Tampered replay (one op changed, digest recomputed) | Verification fails (`simulation-mismatch`) when the claimed results disagree; an integrity-only change is detected by digest |
| T-A9 | Share endpoint with another room's token / a late joiner / practice | 403 / 404, exactly like the M3-B1 matrix |
| T-A10 | Appearance with custom URLs or invalid skins | Rejected or normalised to Classic; never stored as a URL |

Anti-cheat claims are bounded: none of these tests can detect bots, macros or human-speed
assistance. Do not write tests that pretend to.

---

## Replay tests

1. **Golden corpus** (M4-B/M4-E): every fixture decodes, verifies and plays to the end through
   the public read path, with an identical final digest. Run on every commit.
2. **Every harness scenario** seals a prefix and verifies it (already in Appendix A).
3. **Practice exclusion:** practice rooms through start, reconnect, undo, reset, rematch and a
   share attempt create no recorder, no store entry and no share (I7).
4. **No wall-clock dependence:** replay a fixture with playback speeds {0.5, 1, 2, 4},
   arbitrary seek sequences and `advance(maxFrames)` chunk sizes {1, 7, 600}. Final digest
   identical.
5. **Appearance isolation:** verification results are identical with any appearance record.
6. **Byte stability:** stored bytes gunzip to the exact sealed JSON. `sha256` matches
   `integrity.digest`.
7. **Engine version bump drill (before any N5-like change):** register a frozen copy, bump the
   live version, and confirm old fixtures still verify through the frozen engine while new
   recordings use the new key.

---

## Real browser and real network tests

### Emulated (one machine, free tools)

* Run the production build locally (`bun run build && NODE_ENV=production bun run start`).
* Apply OS-level emulation to the loopback or LAN interface (Linux example; run as root on a
  test machine only):
  `tc qdisc add dev lo root netem delay 100ms 10ms distribution normal` (≈200 ms RTT ±20).
  Add `loss 0.5%` for loss tests, and `rate 4mbit` for bandwidth.
* Two browser windows (two guests). Play 3 rounds per condition: {0, 50, 100, 150, 200} ms each
  way. Capture `__42trisNetDiagnostics.snapshot()` after each.
* Record subjective notes (rubber-banding, opponent smoothness) next to the numbers.

### Geographic (the real question)

| Run | Server | Players | Purpose |
|---|---|---|---|
| R1 | Fly.io Paris (known good) | Paris + UK + one more | Control |
| R2 | The Singapore host (Antideploy) | Two players in Paris | Reproduce the problem |
| R3 | The same as R2 after N2-B | same | Bandwidth effect |
| R4 | The same as R2 after N3-C | same | Latency-tolerance effect |
| R5 | A free European host, if available | Paris + farther players | Cheapest good option |

Procedure per run: the [03 §6](03-LATENCY-AND-FAILURE-ANALYSIS.md#6-diagnosis-plan-for-antideploysingapore)
diagnosis plan (path checks, diagnostics snapshots, DevTools WS frames, server metrics log), 3
rounds, the same handling settings. Store every snapshot as JSON next to the run notes.

Acceptance for N3-C on real networks: R4 meets Q3/Q4 with ×2 tolerance, **and** R1 shows no
regression against its pre-change snapshot (Q1).

---

## Rejection criteria for an architecture proposal

Reject (or send back) any netplay proposal, including future B/C prototypes, if any of these
hold:

1. It cannot state, in `RULES.md` form, **where authority resides** for inputs, attacks,
   cancellation, insertion, deaths and results, and **how a late event is resolved**.
2. It weakens I3 (client-claimed attacks), I4 (backdating window larger than today's
   `commitDelay` **without** a documented, owner-accepted anti-cheat trade-off), I5, I6 or I7.
3. It cannot replay the T-H matrix with metrics at least as good as A+ on Q1–Q6, or it
   regresses Q1 (nearby play) at all.
4. It requires a paid service or regional infrastructure.
5. It changes the replay format without a new versioned kind, a registered engine and golden
   tests, or it re-encodes stored replays.
6. It hides network problems by silently rewriting accepted history (rollback of committed
   state) instead of producing explicit journaled outcomes.
7. It has no rollback path (feature flag or a clean revert) and no migration plan for in-flight
   rooms.
8. Its tests rely on wall-clock time, real sleeping or non-seeded randomness.

---

## Diagnostics tests

| ID | Asserts |
|---|---|
| T-D1 | Checkpoint age equals the configured downlink delay (±1 ms) with an exact offset in fake time |
| T-D2 | `transport.bytesPerSec` within ±5% of the harness byte count |
| T-D3 | `clock.driftMsPerMin` ≈ the configured drift (T-H8 setup) |
| T-D4 | `control.blockedPct` equals the harness's blocked measurement |
| T-D5 | Server metrics (env on): lateness histogram counts a scripted 30 ms-late input in the 25–50 bucket; env off → no logs, no measurable overhead |
| T-D6 | Disabled diagnostics never call `OwnerPrediction.saveState` (existing test kept) |
