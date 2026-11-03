# 03 — Latency and failure analysis

> Commits `fe92d946` (N1-A) and `a4a9e8e95fff86ab43e081220c8bac36de1a55f7` (N1-B, current `main`),
> 2026-11-03. Production code was not modified. Experiments ran on **scratchpad copies** of
> those commits, using the real `Rooms`, `Match`, `MatchRecorder` and web `Session` under a
> fake clock. The harness is reproduced in [Appendix A](appendix-A-experiment-harness.md).
>
> **N1-B re-run.** Every scenario group (RTT, jitter, bursts, spikes, asymmetric, mixed,
> variants, stalls, outages) was re-run on `a4a9e8e`. Acceptance, resets and blocked time stay
> within run-to-run noise: N1-B changes message timing, which changes the seeded jitter
> draws. Every conclusion holds, and every replay still verifies. N1-B does not touch the
> latency cliff, because those resets come from **transmitted** late inputs. The tables below
> show the `fe92d94` numbers. §3.6 has the N1-B-specific stall results.
>
> Labels: **[measured]** = produced by the harness. **[modelled]** = harness output that
> depends on a modelling assumption stated next to it. **[derived]** = follows from source
> code by reasoning. **[hypothesis]** = plausible, not demonstrated.

Related: [01 architecture](01-CURRENT-42TRIS-ARCHITECTURE.md) · [04 options](04-ARCHITECTURE-OPTIONS.md) ·
[06 roadmap](06-IMPLEMENTATION-ROADMAP.md) · [07 tests](07-TESTING-AND-ACCEPTANCE-PLAN.md).

---

## 0. Headline results

1. **[measured] The input deadline has a cliff at ~160–250 ms RTT.** Inputs are 100% accepted
   up to 140 ms RTT. Rejections start at 160 ms (≈1%), reach ≈22% at 200 ms and ≈50% at
   220 ms, and **at ≥250 ms essentially every input is rejected**. Every rejection triggers a
   full control reset (~1 RTT of blocked control plus a board snap-back). At 250 ms RTT players
   lose control **~40% of the time**.
2. **[derived + measured] The relevant quantity is `RTTmin/2 + throttle wait + jitter`**, not
   upstream delay and not RTT. Asymmetric splits of a 200 ms RTT give the same ~20% rejection
   rate.
3. **[measured] A per-player input lead** (the client stamps inputs `lead` ms ahead of its
   server-time estimate; the server's future window is widened to match) **removes all
   rejections** at 200, 300 and 500 ms RTT and under bursty jitter. It does not change opponent
   lag for low-latency players. A room-wide `commitDelay = 200` also fixes 300 ms RTT, but
   adds ~90 ms of opponent lag for everyone.
4. **[measured] Checkpoints are oversized.** Each one carries the last ≤256 Match events.
   They reach ~95 KB for 2 players and ~106 KB+ for 8, and are sent ≥20×/s per seat. Measured
   downstream: 0.56–0.93 MB/s per client (2p), 1.6–1.9 MB/s (8p).
   **[modelled]** If the effective downlink drops below ~0.5–1 MB/s and the kernel send buffer
   hides backpressure, checkpoint age climbs into **seconds**.
5. **[measured] Bursty jitter on a nearby server** (60 ms RTT, 5% of messages +150 ms) causes
   7–10% rejections and **9–18 resets per minute**. This is a strong candidate for the earlier
   intermittent rubber-banding.
6. **[measured] A path outage of ~6 s** closes the heartbeat lease, **pauses the whole room**
   and costs ~9.7 s of play including preparation and the 3 s countdown. A 3 s outage does
   not disconnect. Inputs pressed during its first 2 s are rejected on arrival (one reset), and
   the server keeps a held key held for the whole outage.
7. **[measured] Simulation is cheap; serialisation is not.** 8-player Match simulation costs
   <0.5 ms per second. Checkpoint creation and serialisation cost ~45–50 ms per second (Ryzen
   7 9800X3D, in-process).
8. **[measured] N1-B works only for one post-stall ordering.** It retracts stale unsent inputs
   without a reset when the post-stall checkpoint is processed first. If the trailing-flush
   timer or a key press runs first, the stale input is transmitted and the full reset still
   happens (3/3 alternative orderings). It has no effect on the latency cliff (item 1).

What is **not** established: the real Antideploy RTT, jitter, throughput, proxying and CPU.
§6 is the measurement plan.

---

## 1. Existing harness coverage (N1-A)

`packages/web/netplay-harness.ts` + `netplay-latency.test.ts` (11 latency tests, 6 diagnostics
tests). Strengths: real `Rooms`/`Match`/`Session`, deterministic fake time, ordered delivery,
seeded jitter, browser stalls (frames, timers, inbound and input handling paused), downstream
holds, diagnostics assertions.

Gaps that matter for architecture decisions:

| Gap | Consequence |
|---|---|
| Exactly two clients (`"a" \| "b"`) | No 3–8 player or mixed-RTT evidence. |
| No upstream hold / outage | Cannot reproduce "sent into the void, rejected on arrival". |
| No bandwidth, serialisation or queueing model; `ephemeral` flag ignored | Cannot see the checkpoint-size problem. |
| No native heartbeat model | Cannot reproduce 6 s lease closure → room pause. |
| No scripted "human" input stream; tests press keys ≥40–60 ms apart | The 34 ms throttle wait is never exercised under latency. |
| Client clock offset uses the real algorithm, but no clock drift | Cannot test long-session drift. |

`SessionDiagnostics` (`session-diagnostics.ts`) records: connection changes, checkpoint arrival
gaps, stale checkpoints, batches that waited ≥34 ms, rejections by code, releases by reason,
correction flags at equal simulation time, frame gaps ≥32 ms, the last 16 RTT samples
(min/avg/max/jitter). **It does not record** checkpoint age (server send → client receive),
bytes or messages received, the per-pong implied clock offset, how late an input was, or
time spent with `canPlay === false`. These are needed for the Antideploy diagnosis (§6) and
are specified as milestone N2-A in [06](06-IMPLEMENTATION-ROADMAP.md#n2-a--diagnostics-for-the-singaporeantideploy-question).

---

## 2. Experimental method

Harness (scratchpad only): `NetN` generalises the N1-A harness to N clients. It adds:

* per-client up/down delay, uniform jitter, and a "spike" process (probability p per message
  of +X ms). Delivery stays ordered, like TCP head-of-line blocking;
* two-way outages (held messages are delivered after the outage, as TCP retransmission would);
* a native heartbeat model: ping every 2 s, lease closed after 6 s without a pong. Pongs are
  answered by the network stack, so they are **not** blocked by browser stalls;
* an optional downlink capacity model. A message occupies the link for `bytes/capacity`. An
  optional "kernel buffer" is subtracted before Bun's `getBufferedAmount()` would see the
  backlog. Ephemeral checkpoints are skipped when that visible backlog exceeds 64 KiB, as in
  `app.ts:75`;
* a scripted player bot at ~1.6 pieces/s per player. Each piece is a burst: optional rotate,
  a tap (25–75 ms) or DAS hold (140–260 ms) of Left/Right, an optional 180°/soft drop/hold,
  then Hard Drop 5–50 ms later. Consecutive inputs are often <34 ms apart. Key-ups after a
  local reset are suppressed, as `pressed.clear()` does. A key-up while blocked calls
  `release()`, mirroring `lateRelease`;
* experiment knobs patched **only in the scratchpad copy**: `Rooms.commitDelay` (default 100),
  `Rooms.futureFrames` (default 2), `Session.lead` (default 0). With defaults the code is
  byte-for-byte production behaviour.

Metrics: per-input server lateness `L = simNow − stamp` at arrival; accepted/late/future;
releases by reason; corrections; **blocked %** (share of animation frames during
`phase=playing` with the owner alive where `canPlay` is false); opponent lag (true server sim
time − rendered checkpoint frame, sampled every frame); checkpoint age (receive time −
`serverNow`); delivered downstream bytes; server CPU (real `performance.now()` spent in
`tick`/`snapshots`/`receive`/stringify per simulated second). After each run a recorder prefix
was sealed and **verified with `verifyMatchReplayExecution`; every run produced a verifiable
journal**.

Runs: 30 s of play after match start (60 s for bandwidth and spike sets). Seeds fixed.
Results are deterministic for a given seed. "a / b" in a cell means the two symmetric clients
differed.

---

## 3. Measured results

### 3.1 Symmetric RTT sweep (2 players, no jitter) [measured]

| RTT (ms) | Accepted | Resets / 30 s | Blocked % | Lateness p95 | Opponent lag p50 / p95 | Ckpt age |
|---|---|---|---|---|---|---|
| 10 | 100% | 0 | 0.1 | 31 | 140 / 160 | 5 |
| 40 | 100% | 0 | 0.3 | 46 | 160 / 182 | 20 |
| 60 | 100% | 0 | 0.5 | 56 | 158 / 177 | 30 |
| 100 | 100% | 0 | 0.8 | 75 | 173 / 195 | 50 |
| 120 | 100% | 0 | 0.8 | 85 | 188 / 213 | 60 |
| 140 | 100% | 0 | 0.9 | 96 | 212 / 232 | 70 |
| **160** | **99%** | 2 | 2.4 | 105 | 208 / 230 | 80 |
| **180** | **89%** | 10–11 | 9 | 115 | 218 / 247 | 90 |
| **200** | **77–78%** | 20–23 | 16–18 | 124 | 223 / 245 | 100 |
| **220** | **50–52%** | 35–42 | 25–31 | 135 | 238 / 255 | 110 |
| **250** | **0–1%** | 45–49 | 37–41 | 148 | 253 / 270 | 125 |
| 300 | 0% | 37–38 | 36–38 | 174 | 278 / 295 | 150 |
| 400 | 0% | 31–32 | 41–43 | 225 | 328 / 345 | 200 |
| 600 | 0% | 24 | 48 | 323 | 428 / 445 | 300 |

Reset reasons are `rejected-input` and `stale-prediction`. Low-RTT runs show 0–1 `wrong-phase`
resets, which come from the bot pressing at round transitions and are excluded. "Blocked %"
includes downlink delay at round starts, which is why it is ~2% at high RTT even with no
resets.

**Interpretation [derived].** Lateness p95 ≈ RTT/2 + ~25–35 ms (the throttle wait). The cliff
sits where lateness crosses the ~100–127 ms acceptance threshold
([01 §4.3](01-CURRENT-42TRIS-ARCHITECTURE.md#43-the-input-deadline-derived)). Above it, *every*
reset blocks control for ≥1 RTT, and the next inputs are also late, so the player is stuck in
a reset loop.

### 3.2 Jitter and bursts [measured]

| Scenario | Accepted | Resets | Blocked % | Lateness p95 |
|---|---|---|---|---|
| RTT 40 ±15 ms uniform | 100% | 0 | 0.5 | 51–59 |
| RTT 100 ±15 | 100% | 0 | 0.8 | 79–82 |
| RTT 160 ±15 | 91% / 96% | 9 / 4 per 30 s | 7.7 / 3.8 | 108–117 |
| RTT 200 ±15 | 61–74% | 24–30 per 30 s | 19–23 | 125–133 |
| RTT 250 ±15 | 3–6% | 42–47 per 30 s | 36–40 | 158 |
| **RTT 60, 5% of msgs +150 ms** | **89–94%** | **9–18 per 60 s** | 3–7 | 131–180 |
| RTT 160, 5% +150 ms | 86–88% | 17–19 per 60 s | 9–10 | 225 |

**[hypothesis]** Short Wi-Fi or congestion bursts on a *nearby* server produce exactly the
reported pattern of occasional heavy rubber-banding while the opponent looks fine. Opponents
are not reset by *your* late inputs; only you are.

### 3.3 Asymmetric links [measured]

All at 200 ms RTT: up 20/down 180 → 77–78% accepted. Up 180/down 20 → 78–81%. Up 60/down 140
→ 78–81%. Lateness p95 = 124 ms in all three. **Asymmetry does not matter for acceptance**
because the NTP-midpoint offset error cancels the upstream delay
([01 §4.3](01-CURRENT-42TRIS-ARCHITECTURE.md#43-the-input-deadline-derived)). It does matter for
opponent lag: down 180 → 307 ms; down 20 → 160 ms.

### 3.4 Mixed-latency rooms [measured]

| Room | Per-player RTT → accepted | Notes |
|---|---|---|
| 4p 20/60/180/300 | 100% / 100% / 91% / **0%** | The 300 ms player has 33 resets / 30 s and is blocked 39% of the time. Others unaffected. |
| 8p 10/20/40/60/100/150/200/300 | 100% ×6 / **78%** / **0%** | 150 ms is fine (lateness p95 101). |
| 8p all 40 ms | 100% | Per-client downstream 1.84–1.96 MB/s. |

### 3.5 Candidate mitigations [measured]

| Scenario | Accepted | Resets | Opponent lag p50/p95 | Notes |
|---|---|---|---|---|
| 2p RTT 300, baseline | 0% | 37–38 / 30 s | 278 / 295 | |
| 2p RTT 300, **commitDelay 200** | 100% | 0 | **370 / 397** | Everyone's opponents are ~92 ms later. |
| 2p RTT 300, **lead 104 ms** | 100% | 0 | 277 / 295 | Opponent lag unchanged. |
| 2p RTT 200 ±15, baseline | 60–62% | 27–32 | 239 / 263 | |
| 2p RTT 200 ±15, **lead 84** | 100% | 0 | 237 / 256 | |
| 2p RTT 500, **lead 204** | 100% | 0 | 377 / 395 | Still playable. Opponents ~380 ms behind. |
| 4p 20/60/180/300, **lead 0/0/44/104** | 100% all | 0 | 140/158 for the 20 ms player (= baseline) | High-latency players carry their own cost. |
| 2p RTT 60 + spikes, lead 40 | 91–94% | 11–17 / 60 s | | A lead below the spike size barely helps. |
| 2p RTT 60 + spikes, **lead 120** | 100% | 0 | | Must cover p99 including spikes. |
| 2p RTT 160 + spikes, lead 60 / **170** | 93% / **100%** | 9–10 / **0** | | |
| 2p RTT 40, lead formula → 0 | 100% | 0 | 160 / 182 | No change for healthy links. |

Lead formula used: `lead = max(0, ceil(RTT/2 + 34 + 2·jitter + 20 − 100))`, with
`futureFrames = ceil(lead/F) + 2`. In the spike runs the lead was set by hand.

**What lead costs [derived].** (1) A leading player's actions take effect `lead` ms later on
the shared timeline. Their attacks arrive later and they have `lead` ms less warning of
incoming garbage relative to their own board. (2) Their prediction runs `lead` ms further
ahead of committed state, so incoming-garbage insertion mispredictions become possible once
`commitDelay + D + checkpointAge + lead > 333 ms` (§3.8). (3) A modified client gains nothing
by choosing a larger lead: stamping later only delays its own actions. The backdating window
stays bounded by `commitDelay`.

### 3.6 Browser stalls vs. network stalls [measured traces]

| Case | What happened |
|---|---|
| 300 ms / 1 s / 3 s browser stall, bot play (RTT 40) | No resets in these runs. Checkpoints queue and are applied in order after the stall (age max 320 / 1 020 / 3 020 ms). After a 3 s stall `canPlay` stays false until the first queued checkpoint is processed. |
| **300 ms stall between a keypress and its trailing flush** (key-down then key-up 5 ms later) | `fe92d94`: `stale-prediction` reset. **`a4a9e8e` (N1-B), checkpoints processed first:** no reset. 1 input retracted, 1 corrective Left-up re-issued, server Left released, same generation (`netplay-latency.test.ts:187`). |
| **Same, but the first post-stall checkpoint is processed 20–30 ms after the stall ends** (N1-B) | The trailing-flush timer (or a key press at stall end) runs first. `flushInputs` transmits the stale Left-up, the server rejects it as late (`INPUT_REJECTED`), and the client takes the **full `stale-prediction` reset** (generation 2 → 3). The same happens for a 1 s stall. Recovery count 0 in all three orderings. **N1-B only helps when a checkpoint is processed before anything flushes.** Whether real browsers run input, timer or network tasks first after a long task is **not verified**. |
| 6 s browser freeze, pongs still answered (Left held) | No disconnect, no reset. **The server keeps Left held for the whole freeze.** The piece slides and falls without the player. The key-up is dispatched after the freeze, stamped then, and accepted. The local board jumps to the authoritative state. |
| 3 s two-way **network** outage while Left held; Left-up and rotate pressed in the first 2 s | `canPlay` stays true for 2 s, so those inputs are predicted locally and sent into the outage. On recovery they arrive late → 2 × `INPUT_REJECTED` → one reset. **The server held Left for 3 s.** |
| 6 s two-way network outage | `canPlay` false after 2 s. Heartbeat closes the lease at ~6 s → **room paused for everyone** → reconnect (~0.7 s backoff) → preparation → 3 s countdown → play resumes. Outage start → play: **~9.7 s**. |

**[derived] Why these differ.** A browser freeze cannot send inputs, but its *network stack*
keeps the socket alive. The server sees "a player who is not pressing anything". A network
outage lets the client keep predicting inputs the server cannot receive in time. Under the
current rules those inputs are invalid, so they are rolled back. Neither case can be hidden
from opponents: what the server simulates *is* what opponents see.

**[hypothesis] The reported ~3 s pause** matches either (a) a socket close (network change,
proxy idle cut, or heartbeat), which forces the pause → preparation → **3 s countdown**
sequence for the whole room, or (b) a 2 s checkpoint staleness plus `resync` round trip. The
diagnostics distinguish them: (a) logs `connection: false/true` events; (b) shows a checkpoint
gap ≥2000 ms without a connection event.

### 3.7 Server CPU, memory and bandwidth [measured]

Per simulated second, Bun 1.4.2 on a Ryzen 7 9800X3D, in-process (excludes real socket syscalls
and TLS):

| Room | tick (simulation) | snapshots (saveState + events, per seat) | receive (admission + ack checkpoint) | JSON.stringify | Total |
|---|---|---|---|---|---|
| 2 players | 0.1–0.3 ms | 2.1–3.3 ms | 0.4–0.9 ms | 0.5–1.6 ms | ≈ 3–6 ms (0.5% of a core) |
| 4 players | 0.25–0.33 | 9.4–9.6 | 2.4 | 3.0–3.5 | ≈ 15 ms |
| 8 players | 0.41–0.48 | 34–35 | 7.1–7.5 | 10.2–11.4 | ≈ 52–55 ms (5.5%) |

Microbenchmarks: `Match.saveState()` 0.044 / 0.082 / 0.161 ms (2/4/8 players).
`JSON.stringify(checkpoint)` 0.025 / 0.046 / 0.079 ms. `OwnerPrediction` rebuild + advance
0.013–0.022 ms. 10 s of idle 8-player `Match` simulation: 1.3 ms. Client `JSON.parse` of a
95 KB checkpoint: 0.11 ms; with `Session.receive`: 0.16 ms (desktop Bun; a slow laptop
browser is probably 5–10× slower **[hypothesis]**).

**Conclusions.** (1) Full server simulation is **not** what makes hosting expensive. The
Match is cheap enough to run a few dozen rooms on a fraction of a shared vCPU **[derived:
scale by an unknown 3–10× slower free-tier core]**. (2) The per-seat `saveState()` plus the
256-event copy is the dominant CPU cost and scales as O(players²) per room. (3) Bandwidth is
the dominant *cost* for free hosting. A 2-player room can push ~1 MB/s of egress (~3.5 GB per
hour of play) **[measured rate, extrapolated volume]**.

### 3.8 Garbage interaction under latency [derived; experiment specified, not run]

An attack sent at committed time `s` becomes known to a client at real time ≈
`s + commitDelay + tickPhase + D + checkpointAge`. Its eligibility is `s + 333 ms`. The
owner's prediction at that moment is at `now + lead`. A **predicted insertion is wrong** only if
the owner locks a non-clearing piece in
`[s + 333, s + commitDelay + D + checkpointAge + lead]`. That interval is empty while
`commitDelay + D + checkpointAge + lead < 333 ms`:

| Configuration | Window (approx.) | Insertion mispredictions possible? |
|---|---|---|
| Nearby (D 20), lead 0 | 100 + 20 + 25 = 145 ms | No |
| RTT 300 (D 150), lead 104 | 100 + 150 + 25 + 104 = 379 ms | Yes, for locks in a ~46 ms slice after eligibility |
| RTT 300, commitDelay 200 | 200 + 150 + 25 = 375 ms | Yes, similar |
| RTT 500 (D 250), lead 204 | ~580 ms | Yes, a ~250 ms slice |

Cancellation and meter mispredictions (`garbage`/`sent` corrections) are possible at any RTT,
because the prediction does not know about attacks sent after the committed frame. These are
corrections, not resets. I tried a forced-attack harness experiment, but repeatedly replacing
`room.match` mid-session disturbed the clients' input flow, so the numbers were not
trustworthy and are **not reported**. The correct experiment is specified in
[07 §T-G1](07-TESTING-AND-ACCEPTANCE-PLAN.md#fairness-and-garbage-tests). The existing test
`netplay-latency.test.ts:298` already shows a garbage correction being classified without a
reset.

---

## 4. Bandwidth and queueing: the oversized-checkpoint finding

### 4.1 Facts [measured, source]

* `Rooms.checkpoint` copies `room.events` (≤256 entries, `rooms.ts:557,583`) into every
  checkpoint. The window saturates after ~90 s of 2-player play (~256 events, mostly `lock`
  events of ~350 bytes each).
* 2p checkpoint after 90 s: **95 085 bytes**. The client uses only the latest
  `roundEnd`/`setEnd` from it (`online-view.ts:327`).
* Checkpoints go to every seat every 50 ms **and** to the sender after every input batch.
* `saveState()` runs once **per seat** per broadcast (`rooms.ts:578`).

### 4.2 Modelled effect of limited downlink throughput [modelled]

2 players, RTT 200 ms, 60 s. "Kernel buffer" is how much backlog is invisible to
`getBufferedAmount()` (0 = Bun sees everything; 1 MB = Linux autotuned send buffer absorbs it
first). Which value applies to Bun on a given host is **not verified**.

| Downlink | Kernel buffer | Accepted | Ckpt age p50 / p95 / max | Opponent lag p50 / p95 | Skipped ckpts |
|---|---|---|---|---|---|
| ∞ | – | 78–83% | 100 / 100 / 100 | 227 / 245 | 0 |
| 2 000 KB/s | 0 / 1 MB | 81% | 115 / 131 / 160 | 243 / 270 | ~1 |
| 500 KB/s | 0 | 79–80% | 230 / 300 / 318 | 390 / 457 | ~370 |
| 500 KB/s | 1 MB | **47–53%** | **720–1 230 / 2 330 / 2 340** | **1 860–2 230 / 2 490** | ~200 |
| 250 KB/s | 1 MB | 34–85% | **3 650–3 800 / 4 525 / 4 540** | **4 630 / 4 700** | ~340 |
| 120 KB/s | 1 MB | 26–30% | **8 070–8 330 / 9 280 / 9 310** | **9 350 / 9 465** | ~565 |

At RTT 40 with a 2 MB/s downlink: age 40 / 73 / 133 ms. Harmless.

**[hypothesis] Contribution to the Singapore report.** Long paths get less TCP throughput (it
scales roughly with window/RTT and with 1/√loss), and free tiers may shape egress. If the
effective rate fell below ~1 MB/s, the input-deadline cliff (§3.1) would combine with seconds
of checkpoint queueing: inputs rejected, opponents seconds behind, resyncs. Neither the
throughput nor the buffer behaviour has been measured on Antideploy. §6 says how.

### 4.3 Why this is cheap to fix [derived]

Send only the events a client needs (current-round result events, plus a short recent window
if animations want it), and build each checkpoint body **once per broadcast** instead of once
per seat. Neither changes `Match`, the protocol schema shape, or replays. Expected effect
(from the measured composition): 2p checkpoint ~95 KB → ~5 KB, 8p ~106 KB → ~19 KB, and
snapshot CPU divided by ~N. See [06 N2-B](06-IMPLEMENTATION-ROADMAP.md#n2-b--checkpoint-diet-events-window-and-shared-snapshot).

### 4.4 Security note: egress amplification

A client can make the server send it a full checkpoint for every `inputBatch` or `resync`
(≤40 commands/s per socket, ≤128 sockets, any guest can create a room and play). At ~95 KB per
checkpoint that is several MB/s per socket of server egress, bounded only by the 64 KiB
ephemeral skip. On metered or free hosting this is a cost and availability risk. N2-B reduces it
by ~20×. A per-seat checkpoint budget (e.g. ≤25/s) closes it fully. **This report documents
the issue and does not change code.**

---

## 5. Failure modes catalogue

| # | Mode | Trigger | Who notices | Today | Root cause class |
|---|---|---|---|---|---|
| F1 | Deadline cliff | `RTTmin/2 + W + j > ~100 ms` | the late player | reset loop | timing model |
| F2 | Burst/spike lates | transient queueing | the late player | intermittent resets | timing model |
| F3 | Unsent stale inputs after stall | stall inside the throttle window | the stalled player | N1-B recovers **if** a checkpoint is processed first; otherwise reset (ordering gap) | client recovery |
| F4 | Outage inputs | outage < 6 s with keys pressed | outage player | reset; server held keys meanwhile | timing model |
| F5 | Lease loss | outage ≥ 6 s, network change, proxy cut | **everyone** | room pause + prep + 3 s countdown | lifecycle policy |
| F6 | Downlink queueing | big checkpoints × low throughput | the slow-link player (acks, opponents); everyone if the server CPU saturates | seconds of lag | payload size |
| F7 | Clock drift | long sessions | one player | slowly rising lates | clock estimation [hypothesis] |
| F8 | Wrong-piece one-shots | late one-shot rejected, later one-shot accepted before reset | late player | inputs hit the wrong piece | per-item admission |
| F9 | Opponent stepping | 20 Hz full-state updates, no smoothing | everyone | jerky boards ~150+ ms behind | presentation |
| F10 | Garbage misprediction | prediction horizon > 333 ms | high-RTT / lead player | correction (not reset) | prediction horizon |

---

## 6. Diagnosis plan for Antideploy/Singapore

Goal: decide which of F1, F2, F5, F6 and server CPU caused "extremely laggy", using numbers
rather than guesses. Steps 1–3 need **no code change**.

1. **Location and path.** From each player: `curl -w '%{time_connect} %{time_appconnect}\n'
   -o /dev/null -s https://<host>/api/health` ×20 (TCP and TLS handshake ≈ 1 and 2 RTT). Also
   `mtr`/`traceroute` to the host, and the `serverNow` field of `/api/health` to check the
   process is up. Record whether the hostname resolves to a regional edge proxy rather than the
   Singapore origin. A proxy hop adds a second leg the game cannot see.
2. **Diagnostics run.** Each player opens the game with `?diagnostics` and plays ≥3 minutes.
   Then run in the console: `copy(JSON.stringify(__42trisNetDiagnostics.snapshot()))` and save it.
   Read: `rtt.min/avg/max/jitter` (if `max ≫ min` while playing, suspect downlink queueing:
   pongs wait behind checkpoints), `rejections.byCode.INPUT_REJECTED`,
   `releases.byReason` (`rejected-input`/`stale-prediction` → F1/F2), `checkpoints.maxGapMs`
   (≥2000 → stalls or queueing), `connection` events (→ F5), `frames.maxGapMs` (local
   browser stalls → F3).
3. **Browser DevTools.** Network → WS → Messages: frame sizes (expect 30–100 KB checkpoints)
   and arrival cadence. Performance panel: main-thread long tasks while playing.
4. **After N2-A (diagnostics extension):** checkpoint age p50/p95/max, bytes per second, implied
   offset drift, input lateness histogram (from new server-side counters), blocked-time %.
   Decision rules:
   * age p95 ≲ RTT/2 + 60 ms and lates > 1% → **F1/F2** dominate. Apply N3 (lead).
   * age p95 > 300 ms or growing → **F6** dominates. Apply N2-B (checkpoint diet) first.
   * connection events present → **F5**. Check the host's proxy idle timeouts and
     WebSocket support.
   * CPU: from the host dashboard or a `process.cpuUsage()` log behind an env flag. Sustained
     >50% of the allotted vCPU during one room → server scheduling delay adds to lateness.
5. **Control run.** Repeat steps 2–4 against Fly.io Paris (known good) with the same players.
   The difference between the two runs attributes the effect.

Things the fake-time harness **cannot** show: real routing and peering, TLS/proxy behaviour
(edge termination, buffering, idle cut-offs), browser rendering and GC pauses, actual TCP
congestion control and kernel buffering, CPU steal on shared VMs, Bun's real
`getBufferedAmount()` semantics, and Antideploy-specific limits.

---

## 7. Observed facts vs. hypotheses (summary)

| Statement | Status |
|---|---|
| Inputs are stamped at estimated server-now; the commit delay is 100 ms; the deadline depends on RTTmin/2 + throttle + jitter | **Fact (source + measured)** |
| ≥250 ms RTT → ~all inputs rejected; 200 ms → ~22% | **Measured (harness)** |
| Per-player lead removes rejections without hurting low-latency players | **Measured (harness)**; real-network validation pending |
| Checkpoints are ~95–106 KB and sent ≥20 Hz per seat | **Measured** |
| Large checkpoints cause seconds of lag on slow links | **Modelled**; depends on throughput and kernel buffering |
| Paris→Singapore datacenter RTT ≈ 150 ms (min 144, max 164) | **Third-party measurement** ([Hats Network, 2026-08](https://hatsnet.io/docs/network/latency/pairs/par-sin-rtt)); residential + proxy RTT unknown |
| The Antideploy lag was F1 (+F6) | **Hypothesis**, consistent with the numbers |
| The earlier rubber-banding was F2/F3 | **Hypothesis** |
| The ~3 s pause was F5 (countdown) or a 2 s resync | **Hypothesis** |
| Clock drift matters in long sessions | **Hypothesis** (not measured) |
| Antideploy servers are in Singapore | **Owner observation**; no public confirmation found |
