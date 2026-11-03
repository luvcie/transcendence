# 04 — Architecture options A, B, C, D

> Commit `a4a9e8e` (N1-B; the netplay pipeline was first audited at `fe92d94`), 2026-11-03. Numbers marked [measured] come from
> [03](03-LATENCY-AND-FAILURE-ANALYSIS.md). Code facts come from
> [01](01-CURRENT-42TRIS-ARCHITECTURE.md). External facts come from
> [02](02-EXTERNAL-GAMES-RESEARCH.md).

**Bottom line.** Recommend **A+**: keep the server-authoritative shared timeline and fix the
three measured problems.
1. Per-player input lead removes the latency cliff.
2. A checkpoint diet removes the bandwidth problem.
3. Opponent replicas give smooth 60 Hz boards.

Keep **C** as a documented fallback, prototyped only if real-network measurements after A+ show
that input loss from jitter or outages remains a dominant complaint (falsification criteria in
§7). Do not pursue **B** or **D** for competitive play.

---

## 1. The real design question

The question is not "server-authoritative or not". It is **what happens when information
arrives late**:

| Late thing | A (shared timeline) | B/C (independent timelines) |
|---|---|---|
| My own input reaches the server late | Must be rejected or re-timed: the timeline is already committed | Never late; my timeline is mine |
| An opponent's attack reaches me late | My *prediction* is corrected; truth was never wrong | Truth is defined by when I received it, within bounds |
| A player stops sending | Server keeps simulating them (keys held or released) | Their timeline stops; opponents' view of them freezes |

A trades **own-input robustness** for **interaction exactness and a tight cheating bound**.
B and C make the opposite trade. The measurements show A's own-input weakness was mostly
**self-inflicted**: it came from stamping at "now" with a fixed 100 ms window. It can be
removed (lead) without giving up the shared timeline. The open question for B/C is whether
the *remaining* A failure modes (bursts larger than the lead, multi-second outages) matter
enough to pay for a new model.

---

## 2. Architecture A+ — improved authoritative timeline (recommended)

### 2.1 Data flow

```
 Client P (lead_P)                         Server (authority)                     Client Q
 ─────────────────                         ──────────────────                     ────────
 key ─► stamp T = estServerNow + lead_P     admit if match.frame ≤ frame(T)
        predict own board at T                ≤ nowFrame + ceil(LEAD_MAX/F) + 2
        send batch ─────────────────────►   Match.submit (journaled)
                                            tick: commit to now − commitDelay
                       ◄─ checkpoint(ack + state, small) ─┬─ checkpoint(state) ─►  replicas of all
        rebuild own prediction                            │                        boards advance
        replicas of opponents (A6)                         └─ (optional A7) journal ops stream
```

Authority: the server's `Match` owns every board, every interaction and every result.
Clients own nothing but their speculative views.

### 2.2 Components

| ID | Change | Where | Changes Match/replay? | Evidence |
|---|---|---|---|---|
| A1 | Room-wide commit delay (static or adaptive) | `rooms.ts:534` | No (admission only) | [measured] 200 ms fixes RTT 300 but adds ~92 ms opponent lag **for all**. Not preferred. |
| **A2** | **Per-player input lead**: client stamps at `estServerNow + lead`; server future window = `LEAD_MAX` | `session.ts:212-217`, `rooms.ts:363` | No | [measured] 100% accepted at 200/300/500 ms RTT, mixed rooms and spikes (lead ≥ spike). Low-RTT players unaffected. |
| A3 | Clock estimate: sliding-window minimum RTT (e.g. best of last 16 pongs) instead of the all-time minimum | `session.ts:380-391` | No | [derived] removes drift/route-change bias. Not measured. |
| A4 | Non-destructive late handling (see §2.4) | client + server; **A4b changes Match semantics** | A4a no; A4b yes (new Match/replay version) | [derived] |
| **A5** | **Checkpoint diet**: result-only events; one `saveState()` per broadcast; per-seat checkpoint budget | `rooms.ts:551-587` | No | [measured] events = 79–85% of checkpoint bytes; snapshot CPU is O(N²). |
| **A6** | **Opponent replicas**: per opponent, an `OwnerPrediction`-style replica from the latest checkpoint plus its input backlog, advanced every frame to a display time | web only (`online-view.ts`) | No | [measured] rebuild 0.013–0.022 ms. [derived] gives 60 Hz motion at the same lag. |
| A7 | Journal streaming: server streams recorder ops (`submit`, `advance` watermark) incrementally; full state only on join/resync/periodic hash | protocol addition, server, web | No (reuses the replay op format) | [derived] bandwidth → ~KB/s. Opponent boards exact. |
| A8 | Silence rule: release a seat's held controls after ~2.5–3 s with no message (frozen tab or outage) | `rooms.ts` tick | No (a journaled `release`) | [measured trace] the server holds keys for whole stalls/outages. |
| A9 | Outage UX: client stops predicting new inputs when it has had no checkpoint for `> lead + commitDelay + 400 ms`; shows "connection unstable" | `session.ts` `canPlay` | No | [measured trace] inputs during the first 2 s of an outage are lost later anyway. |

### 2.3 A2 per-player lead: precise semantics

```text
Client (Session):
  lead ∈ [0, LEAD_MAX]                 // LEAD_MAX is server-advertised or a shared constant (e.g. 250 ms)
  target() = max(prediction.atMs, cp.frame·F,
                 min(cp.simulationNow + elapsed + lead, cp.frame·F + 2000))
  choose lead at round start (countdown) from RTT samples:
     oneWay95 = p95(rttSamples)/2 ; burst = p99(rtt) − p50(rtt)
     lead = clamp(ceil(oneWay95 + 34 + burst + 15 − commitDelay), 0, LEAD_MAX)   // 34 = throttle
  during a round:
     increase only, by ≤ 1 frame per step, on a late/near-late signal
     never decrease (decrease at next round start)
Server (Rooms.input):
  reject if frame < match.frame                              // unchanged: no backdating beyond commit
  reject if frame > floor(simNow/F) + ceil(LEAD_MAX/F) + 2   // widened future bound
```

* **Fairness.** Everyone has the same backdating bound (`commitDelay`). A player with lead
  `ℓ` has their actions take effect `ℓ` ms later on the shared timeline than they physically
  happened. **High-latency players pay for their own latency**; low-latency players' feel and
  opponent lag are unchanged ([measured] 4-player mixed room). This is fairer than today, where
  high-RTT players are either locked out (rejections) or effectively backdated by `RTT/2` when
  accepted.
* **Prediction correction.** Changing `lead` mid-round moves the local timeline. An increase of
  Δ advances local gravity by Δ in one frame (a ≤17 ms jump per step is invisible). A decrease
  would need time to run backwards or slow down, so it is forbidden mid-round.
* **Garbage.** The leading player's prediction horizon grows by `ℓ`. Insertion mispredictions
  appear once `commitDelay + D + ckptAge + ℓ > 333 ms` ([03 §3.8](03-LATENCY-AND-FAILURE-ANALYSIS.md#38-garbage-interaction-under-latency-derived-experiment-specified-not-run)).
  These are corrections, not resets.
* **Security.** A larger lead can only delay a cheater's own actions. The future bound still
  prevents faster-than-real-time play, because commits remain paced by the server clock.
* **Replay.** Unchanged format. Inputs are journaled with the stamps the server accepted.

### 2.4 A4 non-destructive late handling (two levels)

**A4a — client only, no protocol or Match change.** Keep the full reset only where it is
required for correctness:

* An **unsent** stale input (stall inside the throttle) is N1-B's case: recover held
  transitions and drop one-shots. **N1-B landed in `a4a9e8e`.** It covers this only when a checkpoint is processed before the next flush; N2-0 closes the ordering gap.
* A **rejected held transition** (`*Down`/`*Up`) leaves server key state wrong. The full reset
  stays as it is.
* A **rejected one-shot** (rotate, hard drop, hold) **while later inputs from the same burst
  may have been accepted**: the wrong-piece hazard
  ([01 §3.9](01-CURRENT-42TRIS-ARCHITECTURE.md#39-per-input-type-behaviour)). The reset
  continues to bound it. A4a must not try to "skip" the reset here. That needs A4b.

A4a's realistic gain is small. Its main value is clarity. With A2 in place, rejections are rare.

**A4b — server re-timing + piece guard (Match version bump; new replay `matchState`
version).** Add an optional `pieceSeq` to `InputItem` (the client's predicted lock sequence when
the input was made).

* Late held transitions are re-stamped to `(match.frame, 0)` and accepted, keeping order.
* Late one-shots are re-stamped similarly, **but `Match` ignores a one-shot whose `pieceSeq`
  differs from the board's current lock sequence at application time.** This is the only safe
  way to re-time discrete actions. It also fixes F8 for on-time inputs.

Cost: a Match behaviour change, a protocol field, a new `matchState` version, and keeping the
v3 engine for old replays ([05 §5](05-REPLAY-COMPATIBILITY.md#5-versioned-replay-design)). Only do this if
measured reset rates after A2 justify it.

### 2.5 High-RTT expectations under A+ [measured where marked]

| RTT | Own inputs | Opponent lag (p50) | Notes |
|---|---|---|---|
| ≤140 | 100% [measured], lead 0 | 140–212 ms | As today, but smooth with A6 |
| 160–300 | 100% with lead 0–104 [measured] | 208–278 ms | Garbage insertion mispredictions possible near 300 ms (rare) |
| 300–500 | 100% with lead 104–204 [measured] | 278–377 ms | Playable. Opponents visibly behind. More garbage corrections |
| bursts > lead | resets (F2) unless A4b | — | Lead sized at p99 covers most bursts [measured] |
| outage ≥ 6 s | lease loss → room pause | — | Policy (A8/A9) |

### 2.6 Advantages / disadvantages

\+ Keeps every existing guarantee: legality, derived attacks, frame-exact interactions,
deterministic replays, verification, the viewer, and all completed replay milestones (M2, M3).
\+ Each step is small, independently testable and reversible.
\+ The fix is measured, not speculative.
\+ The cheapest server profile once A5 lands.
− Own inputs can still be lost to bursts larger than the lead, and to outages (mitigated, not
removed, by A4b/A9).
− Opponents remain ≥ commitDelay + D behind. This is inherent to any server-relayed view.
− A high-latency player's interactions are delayed by their lead.

---

## 3. Architecture B — independent player timelines with server verification

### 3.1 Definition

Each client advances its own board on its local timeline `τ_P` (ms since round start), with no
server deadline. It sends an ordered stream:

```
{ kind: "input", τ, input }              // own inputs
{ kind: "tick",  τ }                     // heartbeat: "my clock reached τ" (e.g. every 100 ms)
{ kind: "recv",  τ, packetId }           // "packet entered my queue at τ"
```

The server re-simulates every board from its stream, in stream order, as data arrives. It
derives attacks from the simulated locks, routes them (server RNG) and relays packets to
recipients. Recipients apply packets at their local `τ` of receipt and acknowledge with `recv`.

### 3.2 What the server can and cannot verify

| Property | Verifiable? | How |
|---|---|---|
| Inputs form a legal sequence from the seed | **Yes, exactly**, whenever they arrive | Deterministic re-simulation (as replays do today) |
| Attacks/garbage claims | **Yes** | Derived server-side; the client never claims attacks |
| No faster-than-real-time play | **Yes, bounded** | Require `τ_P ≤ serverElapsed + ε` (ε ≈ 50–100 ms of clock slack) |
| Input really happened at local time τ | **No.** Only bounded: `τ ≥ serverElapsed(arrival) − Λ` | Λ = maximum tolerated lag (stall allowance) |
| Packet really arrived at τ_recv | **No.** Only bounded: `τ_recv ∈ [τ_P at relay time, τ_P at relay time + RTT + slack]` | Server knows the recipient's latest `tick` when it relayed |
| Player is not using lag to plan | **No** | Within Λ a client may withhold and then submit an optimised stream ("lag switch") |

**This is the key difference from A.** In A, the window in which timing can be manipulated is
the commit delay (100 ms). In B it is **Λ**, and Λ must be ≥ the stalls you want to forgive
(1–3 s, by the owner's own anecdotes). A legitimately delayed event and a deliberately delayed
one are indistinguishable inside Λ. That is exactly the ZBB lesson
([02 §3.3](02-EXTERNAL-GAMES-RESEARCH.md#33-delayed-vs-invalid-the-engineering-distinction)).
**[inference]** TETR.IO's rules explicitly ban "lagswitches", which suggests lag can be
beneficial in its model.

### 3.3 Hard sub-problems (all must be specified before building)

* **Death ordering / round result.** Boards top out at local `τ` on different timelines. Who
  died first? Options: compare `τ` (trusts clocks within ε/Λ) or server arrival (rewards
  latency). Neither is exact, and ties will be contested.
* **Crossing attacks.** Need a seen-count rule (Techmino) or server arbitration by arrival
  order (deterministic once journaled).
* **Stalls.** A frozen client's τ stops. On resume it must either stay behind (accumulating
  "time debt" up to Λ) or fast-forward (the board falls without the player). Either way,
  opponents see a freeze, then a jump.
* **Replay.** It needs per-player streams plus server routing/cancellation decisions plus
  receipt times. Synchronised viewing needs a mapping from each `τ_P` to a common axis.
  Otherwise a packet can appear to be received before it was sent. **New replay kind and
  driver.**

### 3.4 Pros / cons

\+ Own inputs are never rejected. Local feel is immune to RTT and jitter.
\+ Server simulation stays cheap. Bandwidth is tiny (input streams).
− Timing-manipulation window grows from ~100 ms to Λ (seconds).
− Interaction fairness becomes perspective-dependent ("latency favours the defender").
− New replay kind, recorder, driver, verifier and viewer adapter. A large migration.
− The most complex rules to get right: deaths, crossing, stalls, receipts.

---

## 4. Architecture C — hybrid: free-running local boards, server-scheduled interactions

### 4.1 Definition (authority made explicit)

* **Own board:** simulated by its client on local time `τ_P`. No input deadline. The server
  re-simulates it for legality (as in B).
* **Shared match clock:** server elapsed time `t`. Each client must keep
  `t − Λ ≤ τ_P ≤ t + ε` (as in B).
* **Interactions are scheduled on the shared clock by the server.** A packet created by P's
  lock at `τ_P = s` gets `eligibleAt = s + 333 ms`, a shared-clock instant, plus a recipient Q.
  It is relayed immediately.
* **Recipient rule:** Q's board treats the packet as present in its queue for every placement
  with `τ_Q ≥ s` (for cancellation) and insertable for `τ_Q ≥ eligibleAt`, **provided Q had
  received it by then**. If it arrives after Q has already passed those instants (Q is ahead
  or the network is slow), Q applies it at its first placement after receipt and records
  `recv(τ)`. The server accepts that late application only if its own relay time plus the
  observed RTT bound makes it plausible.
* **Divergence checks:** clients send a state hash every N placements. The server compares it
  with its re-simulation. On mismatch, the server sends the authoritative board (ZBB-style
  "send the board"), and the client adopts it **without rolling back unrelated history**.
* **Results:** the server decides deaths and rounds from its re-simulation, ordered by the
  shared-clock mapping of each death.

### 4.2 Compared with A+ and B

* Versus **B**: C keeps interaction timing close to the shared timeline when the network is
  fast enough (packets arrive before `eligibleAt`). It degrades to B's "apply on receipt"
  only for late packets. The manipulation window is still Λ.
* Versus **A+**: C never rejects own inputs, which survives bursts and outages without a
  reset. A+ never lets interactions deviate from the schedule, so mispredictions are corrected
  toward the schedule. **On a healthy connection the two feel the same** (A+ measured: 0
  rejections with an adequate lead). They differ only on unhealthy connections.
* **Does C meaningfully improve responsiveness over A+?** Only during events larger than the
  lead: spikes, multi-second outages. On those, C trades a local reset for a delayed,
  bounded-trust interaction plus a visible freeze/jump for opponents. Whether that trade is
  worth it depends on how often such events occur on real connections. That is exactly what
  N2-A diagnostics will measure.

### 4.3 Pros / cons

\+ Best local feel under bad networks. Interaction schedule preserved when possible.
\+ Server stays authoritative for legality, attacks and results.
− All of B's timing-trust issues within Λ, plus a two-mode interaction rule (on-time/late) that
must be identical in client, server and replay driver.
− The highest complexity of all options. A new replay kind (`kind: "match-stream"`).

---

## 5. Architecture D — Techmino-style relay (baseline only)

Server: rooms, seed, relay of input/event streams, history for joiners, client-reported
finish. Clients: simulate all boards from streams. Recipients derive attacks and record
receipt ([02 §1](02-EXTERNAL-GAMES-RESEARCH.md#1-techmino--techrater)).

\+ Minimal server (no simulation, tiny bandwidth). Graceful local play. Spectators are cheap.
− **No server verification**: bots, accelerated timelines, withheld or omitted garbage receipt
and fake finishes are all possible ([02 §1.2](02-EXTERNAL-GAMES-RESEARCH.md#12-anti-cheat-guarantees)).
− Replays cannot be verified as genuine server outcomes.
− It would discard 42tris's main investment. **Rejected for competitive play.** It might suit a
casual "friends" mode, but nothing requires that.

---

## 6. Cross-cutting questions

### 6.1 Late garbage (Paris → Chicago, 4 lines arrive after Chicago locked several pieces)

| Policy | Fairness | Cancellation | Replay determinism | Used by |
|---|---|---|---|---|
| Apply when received | Latency favours the defender; perspective-dependent | Against what the recipient has received | Only if receipt is journaled per recipient | Techmino (D), B |
| **Fixed eligibility on a shared timeline** (lock + 333 ms) | Equal rules for all. A late-knowing recipient's *prediction* is corrected | Exact (server queue at lock time) | Inherent (one timeline) | **42tris A/A+** |
| Fixed delay after receipt | Like "when received", with more time to cancel | Receipt-based | Receipt journaled | B variant |
| Rollback the recipient | Exact but disruptive (erases placements) | Exact | Yes, but ugly | Rejected ([02 §3.4](02-EXTERNAL-GAMES-RESEARCH.md#34-why-rolling-a-falling-block-board-back-is-so-disruptive-inference-grounded-in-42tris-mechanics)) |
| Verified pending queue with on-time/late modes | Close to shared timeline; bounded deviations | Mixed | New kind | C |

In A+, the Chicago player's *server* board never had the problem: the server inserted the
garbage at the right lock. Only Chicago's *prediction* may have shown a lock without garbage.
That happens only if Chicago predicted more than 333 ms ahead of what it knew, and it is
corrected on the next checkpoint.

### 6.2 Simultaneous attacks

* **A/A+ (today):** an attack first cancels the sender's own incoming queue, including
  in-flight not-yet-eligible packets. Same-frame opposite attacks cross-cancel FIFO at frame
  end (`match.ts:300-322`). This is fully server-arbitrated and needs no in-transit
  bookkeeping, because the shared timeline knows the order.
* **B/C:** need Techmino's seen-count rule, or server arbitration by arrival order, journaled.
  A simpler server-arbitrated rule: when the server relays an attack X→Y and holds an unacked
  Y→X packet, cancel FIFO before relaying. It is deterministic once journaled but depends on
  network timing.

### 6.3 Six-second interruption

| | Network down, browser running | Browser frozen, network up |
|---|---|---|
| Today (A) | Inputs from the first 2 s predicted, then rejected on arrival. Server holds keys. At ~6 s the lease closes → **room pause**, preparation, 3 s countdown ([measured]) | Lease stays open (pongs are network-level). Server keeps the last held keys for 6 s. Board continues. Keyup dispatched after the freeze. No reset ([measured]) |
| A+ (A8/A9) | After ~lead+500 ms without checkpoints the client stops accepting new inputs and shows "unstable". After ~3 s of silence the server releases held keys. At 6 s: lease loss → pause (or a grace policy; owner's call) | After ~3 s silence the server releases held keys. The board falls with no input. On resume the board jumps forward. No reset |
| B/C | Local play continues; stream resumes later. Opponents see a freeze, then fast-forward. Incoming garbage applied late. Beyond Λ → violation | Local τ stops. On resume: time debt or fast-forward (board falls). Opponents see a freeze |

**What cannot be hidden.** In every architecture, opponents either see the absent player's
board continue without them (A) or see it freeze and jump (B/C). There is no free lunch. The
policy choice (continue with released keys / pause the room / forfeit after N seconds) is a
product decision, recorded in the journal as `release`/`forfeit` operations in A.

### 6.4 Malicious clients

| Attack | A (today) | A+ | B | C | D |
|---|---|---|---|---|---|
| Faster timeline | prevented (future bound) | prevented (widened bound still paced) | prevented (τ ≤ t+ε) | prevented | **possible** |
| Backdate placements | ≤ ~100 ms | ≤ ~100 ms | **≤ Λ (s)** | **≤ Λ** | unbounded in time; but derived by viewers |
| Omit garbage reception | impossible (server inserts) | impossible | detectable only if receipt is bounded; manipulable within bounds | same as B, but bounded by schedule when on time | **possible, undetected** |
| Claim impossible attacks | impossible | impossible | impossible (derived) | impossible | impossible (derived) |
| Submit valid play faster than real time | prevented | prevented | prevented (bounded) | prevented | possible |
| Rewrite history | impossible (committed) | impossible | impossible after arrival; withholding within Λ | same as B | impossible after relay |
| Reconnect abuse | pause griefing (≥3 s per disconnect) | same; mitigable by policy | stall griefing within Λ | same | n/a |
| Different streams to different opponents | n/a (server relays state) | n/a | prevented (single server) | prevented | prevented (single relay) |
| Bots/macros | not prevented | not prevented | not prevented | not prevented | not prevented |
| Information leak (future pieces/holes, ~100 ms of opponent inputs) | yes (needed for prediction) | yes; replicas also need opponents' backlogs | yes | yes | yes |

### 6.5 Replay integrity per architecture

* **A/A+:** the authoritative order is the server's `Match` operation order (already
  journaled). Historical replays keep working as long as the v3 engine is kept. A+ (A2, A3,
  A5, A6, A7, A8, A9) **does not change the replay format**. A4b requires a new `matchState`
  version.
* **B/C:** the authoritative order is **per board** (own inputs plus receipt events) plus
  server routing and cancellation decisions. Each local timeline maps to the match timeline
  through the server's arrival log. Needs `kind: "match-stream"` (new format version) and a new
  driver. The existing viewer is reusable through an adapter that produces `MatchState`-shaped
  snapshots per common-axis frame ([05](05-REPLAY-COMPATIBILITY.md)).

### 6.6 Smooth live opponent boards

| Technique | A+ | B/C | D |
|---|---|---|---|
| Buffered remote input playback | **A6/A7**: replicas advance with known inputs to a display time just behind the newest committed watermark | native (streams) | native (Techmino) |
| Catch-up | small: replica advances by real time; jumps on resync | needed when streams burst | 1–20× ([02](02-EXTERNAL-GAMES-RESEARCH.md)) |
| Interpolation | unnecessary: replicas *simulate* gravity/DAS exactly | same | same |
| Extrapolation | only within the known input backlog (exact) | risky (unknown inputs) | none (freezes) |
| State snapshots | resync and hash check | desync repair | none |
| Freeze under ordinary latency | **no** (playout buffer ≥ checkpoint jitter) | no if buffered | yes (no data → no progress) |

### 6.7 Server performance (2 / 4 / 8 players)

| | A today [measured] | A+ after A5 [derived from measured composition] | A+ with A7 [estimate] | B/C [estimate] | D [estimate] |
|---|---|---|---|---|---|
| Server CPU per room | 5 / 15 / 52–55 ms/s | ~2 / ~4 / ~10 ms/s | < A5 | ≈ A's tick + parsing (< 2 ms/s at 8p) | ≈ 0 |
| Downstream per seat | 0.56–0.93 / 0.85–0.9 / 1.6–1.9 MB/s | ~0.15 / ~0.3 / ~0.5 MB/s (state × ~25 checkpoints/s) | ~1–5 KB/s + periodic hash/state | ~1–5 KB/s | ~1–5 KB/s |
| Room egress | 1.1–1.9 / ~3.5 / 13–16 MB/s | ~0.3 / ~1.2 / ~4 MB/s | tens of KB/s | tens of KB/s | tens of KB/s |
| Memory | Match + journal (~1.1 MB JSON per 2 min, 2p; 103 KB gzipped) | same | same | per-player streams + re-sim | streams |

Full server simulation is **not** the cost problem ([measured]: <0.5 ms/s for 8 boards).
Relay architectures are **not necessary** for free hosting. Checkpoint size is the problem,
and A5/A7 fix it.

---

## 7. Weighted decision matrix

Weights come from the owner's ranked priorities. Scores are 1 (poor) to 5 (excellent). A+ means
A2 + A3 + A5 + A6 + A8 + A9 (A7 and A4b optional later).

| Criterion (weight) | A today | **A+** | B | C | D |
|---|---|---|---|---|---|
| 1. Immediate, reliable local play (20) | 2 | 4 | 5 | 5 | 5 |
| 2. Smooth live opponents (15) | 2 | 4 | 3 | 3.5 | 3 |
| 3. Fair interactions (15) | 3 | 4 | 2 | 3 | 2 |
| 4. Server verification / anti-cheat (15) | 4 | 4 | 3 | 3 | 1 |
| 5. Deterministic verified replays (10) | 5 | 5 | 3 | 3 | 2 |
| 6. Preserve replay investment (10) | 5 | 5 | 2 | 2 | 2 |
| 7. Free / cheap hosting (10) | 2 | 5 | 4 | 4 | 5 |
| 8. Maintainability, small TS team (5) | 4 | 4 | 2 | 1 | 3 |
| **Weighted total (max 500)** | **315 (63%)** | **430 (86%)** | **320 (64%)** | **337 (67%)** | **295 (59%)** |

**Why these scores.** A+ local play is 4, not 5: bursts larger than the lead and outages still
cost a reset. B/C fairness and anti-cheat lose points for the Λ-sized timing window. B/C replay
scores reflect a new kind and driver. A-today hosting is 2 because of the measured bandwidth.

**Sensitivity.** With "feel-first" weights (local 35, opponents 15, fairness 10, anti-cheat 5,
replay 10, preservation 10, cost 10, maintainability 5), A+ still scores 86% against C at 74%
and B at 71%. **A+ loses its lead only if its local-play score falls to ≤2.5.** That happens if
real-network tests show frequent resets despite a correctly sized lead.

### Uncertainty and falsification

The recommendation is wrong if any of these is observed after N2-A, N2-B and N3-A…N3-C:

1. With A2 deployed, players on the problem host still see **> 2 control resets per minute**
   on average (N2-A diagnostics `releases`), and diagnostics show them caused by bursts above a
   p99-sized lead. → Prototype A4b, then C.
2. The required lead for typical players exceeds ~200 ms. That means interaction delay and
   garbage mispredictions become the complaint. → Re-evaluate C.
3. After A5, checkpoint age p95 on the problem host still exceeds ~2×RTT. That means bandwidth
   is not the issue and something else is, such as proxy buffering. → Diagnose the host
   before any architecture change.
4. Players report that opponents ~200–300 ms behind feel unfair in practice. B/C would not fix
   that (their opponents are also behind), but it changes the weighting.

---

## 8. Counterarguments considered

* *"Client-driven local simulation is how modern block games do it."* Techmino does. TETR.IO's
  public notes are compatible with it. But neither offers 42tris's verified-authority
  guarantees in public source (Techmino demonstrably does not). Popularity is not evidence of
  fit for 42tris's priorities.
* *"Lead is just input delay."* No. The local board responds within one frame. Only the
  shared-timeline effect of the input is delayed, and only for that player. Measured: low-RTT
  players are unaffected.
* *"A bigger commit delay is simpler."* It is one line. But it raises opponent lag for every
  player and increases garbage mispredictions for everyone ([measured] +92 ms). Per-player
  lead targets the cost.
* *"Full-state checkpoints are robust; deltas are risky."* True. That is why A5 keeps full
  state and only removes the unused 256-event history. A7 is optional and gated on
  measurement.
* *"Independent timelines would make replays easier to share."* No. They make them harder
  (multi-axis synchronisation, a new verifier).
