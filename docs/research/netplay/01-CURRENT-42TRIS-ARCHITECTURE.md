# 01 — Current 42tris online architecture: source audit

> **Snapshot.** Audited at `main` = `origin/main` = `a4a9e8e95fff86ab43e081220c8bac36de1a55f7`
> ("netplay: recover stale unsent inputs without resetting controls", i.e. N1-B), on
> 2026-11-03. The rest of the pipeline was first audited at its parent `fe92d94` (N1-A); N1-B
> changes only `session.ts`, `session-diagnostics.ts` and `netplay-latency.test.ts`. All
> `path:line` references point at `a4a9e8e`. The full suite passes **648** tests and
> `bun run check` is clean. The code is the authority when this document disagrees with it.
>
> **N1-B review finding.** Stale-input recovery runs only inside `rebuild()`, i.e. when a
> checkpoint (or a new key press) triggers a prediction rebuild against a checkpoint that
> already shows the stale frame. If the trailing-flush timer or a key press runs **before**
> the first post-stall checkpoint is processed, the stale unsent inputs are transmitted, then
> rejected, and the old full reset happens ([03 §3.6](03-LATENCY-AND-FAILURE-ANALYSIS.md#36-browser-stalls-vs-network-stalls-measured-traces)).
> That is not a regression, just a coverage gap that depends on browser task ordering. See
> [06 §N2-0](06-IMPLEMENTATION-ROADMAP.md#n2-0--close-the-n1-b-post-stall-ordering-gap).

Related: [00 summary](00-EXECUTIVE-SUMMARY.md) · [03 latency analysis](03-LATENCY-AND-FAILURE-ANALYSIS.md) ·
[05 replay compatibility](05-REPLAY-COMPATIBILITY.md).

---

## 1. One-paragraph model

The server runs one deterministic `Match` per room on a **single shared simulation
timeline**. The timeline is round-relative milliseconds in 60 Hz frames with fractional
subframes. Clients stamp each input with **their estimate of the server's current simulation
time**, predict their own board immediately, and send sequenced input batches over one
WebSocket. The server **commits** frames 100 ms behind its simulation clock. It accepts an
input only if its timestamp is not already committed and not more than two frames in the
future. It then broadcasts **full-state checkpoints** (all boards, queues, RNG states, an
input backlog and the last ≤256 Match events) at 20 Hz. It also sends one to the sender after
every input batch. On each checkpoint the client discards its prediction, rebuilds it from the
authoritative state, and replays its unresolved inputs. Opponent boards are drawn
straight from the latest checkpoint, with no interpolation. The competitive replay journal is
a recording of exactly the operations the server applied to that one `Match`.

```
 keyboard ─► gameplay-input.ts ─► Session.input()            (browser main thread)
                                    │ stamp = estimated server sim time "now" (+0 lead)
                                    │ seq = nextSeq++ ; pending.push
                                    │ rebuild() : OwnerPrediction(cp.state) + replay pending
                                    ▼
                         flushInputs(): ≥34 ms since last batch? send : trailing timer
                                    │  inputBatch{matchId,generation,epoch,items[≤32]}
         ═══════════ WebSocket (TCP, ordered, TLS via host proxy) ═══════════
                                    ▼
 Rooms.receive ─► Rooms.input(): generation/epoch/seq checks;
                   reject if frame < match.frame (committed) or > nowFrame+2
                   else recorder.submit(input) → Match.submit
                   → checkpoint(room, seat)   (full state, to sender only)
 Rooms.tick() every 10 ms: advanceToFrame(floor((simNow − 100)/F))   ← commit
 Rooms.snapshots() every 50 ms: checkpoint to every seat (full state)
                                    ▼
 Session.receive(checkpoint): filter pending by ack; release on any rejection;
                              rebuild prediction; flush remaining
 main.ts frame(): Session.tick() → prediction.advanceToTime(target())
                  render own board = prediction; opponents = cp.state.players[i]
```

---

## 2. Packages and responsibilities (as implemented)

| Package | Role in netplay | Key files |
|---|---|---|
| `core` | One board: movement, rotation, gravity, lock delay, clears, attacks, exact snapshots. Inputs are discrete events at timestamps. | `packages/core/src/game.ts` (`Input` enum `:12-24`, `apply` `:276-319`) |
| `match` | Interleaves all boards on one timeline; garbage queues, routing RNG, crossing cancellation, deaths, rounds, sets. `OwnerPrediction` runs the same rules for one board. | `match.ts`, `clock.ts`, `garbage.ts`, `placement.ts`, `prediction.ts` |
| `protocol` | TypeBox schemas for client commands (strict) and server envelopes (nested `MatchState` trusted). | `packages/protocol/src/index.ts` |
| `server` | Guest seats, rooms, input admission, scheduler, checkpoints, pause/reconnect, recorder ownership, replay HTTP. | `packages/server/src/rooms.ts`, `app.ts` |
| `web` | Key mapping, `Session` (transport, clock, pending, prediction), rendering, diagnostics. | `session.ts`, `online-view.ts`, `main.ts`, `gameplay-input.ts`, `session-diagnostics.ts` |
| `replay` | Journal format, strict decode, deterministic verification, recorders, playback drivers. | `packages/replay/src/*` |

---

## 3. Input lifecycle (key press → render)

### 3.1 Physical event → `Session.input`

1. `mountGameplayInput` listens to `keydown`/`keyup` on `window`
   (`packages/web/src/gameplay-input.ts:18-61`). It ignores auto-repeat (`e.repeat`), tracks
   physical keys in `pressed`, and maps actions to `Input` ids. Held actions (Left, Right,
   Soft Drop) emit `*Down` once and `*Up` on release. One-shots (rotations, Hard Drop, Hold)
   emit once.
2. If the UI is "blocked" (`main.ts:537`: dialogs, home, replay, or `!session.canPlay`),
   keydown is dropped. **A keyup while blocked calls `session.release()`** (`lateRelease`,
   `gameplay-input.ts:57-58`, `main.ts:553`). That is a full control reset if the session is
   connected and not already releasing.
3. `applyInput` → `online.session.input(input)` (`main.ts:497-499`).

**Timestamp source.** The stamp is taken when the *handler runs*
(`Session.target()` uses `options.now()` = `performance.now()`), not from
`KeyboardEvent.timeStamp`. During a main-thread stall the event is dispatched late and stamped
late. This is the safe choice: it never backdates.

### 3.2 `Session.input` (`packages/web/src/session.ts:229-246`)

```ts
if (!this.canPlay) return;                         // :230  (see canPlay below)
if (this.pending.length >= 128) release("pending-overflow");
queue(input):                                      // :238-246
  at = this.target();                              //   estimated server sim time
  frame = floor(at / FRAME_MS); subframe = at/FRAME_MS − frame
  pending.push({ seq: nextSeq++, frame, subframe, input, sent: false, transmitted: false });
rebuild();                                          // :235  prediction shows it immediately
flushInputs(now);                                   // :236
```

`sent` means "included in the latest transmission of this seq". A gap retry can reset it to
`false`. `transmitted` (added by N1-B) means "has ever left the browser" and is never cleared.

`target()` (`session.ts:223-228`):

```ts
elapsed = frozen || phase≠playing ? 0 : max(0, serverNow() − cp.serverNow);
return max(prediction.atMs, cp.state.frame·F,
           min(cp.clock.simulationNow + elapsed, cp.state.frame·F + 2000));
```

* `serverNow() = performance.now() + offset` (`:190`).
* So the stamp is **the client's estimate of the server's current simulation time**. It is
  *not* "committed time + something". Local prediction runs at that same time.
* It is monotonic: `max(prediction.atMs, …)` means clock corrections never move the
  prediction backwards.
* Hard cap: at most 2000 ms beyond the last checkpoint's committed frame.

`canPlay` (`session.ts:216-222`) requires: connected, not releasing, no sequence gap,
phase `playing`, a prediction exists, the checkpoint clock is not frozen, **the last checkpoint
arrived less than 2000 ms ago**, and the owner is not withdrawn, eliminated or topped out.

### 3.3 Batching and transmission (`session.ts:247-275`)

* Unsent items (≤32 per batch) are sent immediately if ≥34 ms have passed since the last
  batch. Otherwise a cancellable trailing timer fires at `lastFlush + 34` (`scheduleFlush`).
  These are the two "initial transmission optimizations".
* A batch carries `matchId`, `generation`, `epoch` and the items without `sent`.
* Consequence: **an input can wait up to 34 ms before leaving the browser**. The wait
  counts against the 100 ms server window (§4.3).

### 3.4 Server admission (`packages/server/src/rooms.ts:344-382`)

Before `Rooms.input`, the message passes the transport limits in `app.ts:85-96` (40 msgs/s,
burst 80 per socket; overflow closes the socket). `Rooms.receive` then applies a per-connection
command bucket (40/s, burst 80, `rooms.ts:109,121`) and strict schema validation
(`InputItemSchema`, `protocol/src/index.ts:154`).

| Check | Line | Result on failure |
|---|---|---|
| phase `playing`, seat active | `:348` | `WRONG_PHASE` error |
| `matchId`, `generation`, `epoch` current | `:349` | `STALE_INPUT` error (whole batch) |
| seat input bucket 240/s, burst 64 | `:350` | `RATE_LIMIT` error |
| `seq < nextSeq` and fingerprint matches history | `:353-357` | duplicate ignored; unknown → `SEQ_EXPIRED`; mismatch → `SEQ_CONFLICT` + socket closed |
| `seq > nextSeq` | `:359` | `SEQ_GAP`, rest of batch dropped |
| **`item.frame < match.frame`** (already committed) | `:363` | per-item `INPUT_REJECTED` in `seat.rejections` |
| **`item.frame > floor(simNow/F) + 2`** (future) | `:363` | per-item `INPUT_REJECTED` |
| `seat.pending.size ≥ 128` | `:363` | per-item `INPUT_REJECTED` |
| `Match.submit` throws `RangeError` | `:366-374` | per-item `INPUT_REJECTED` |

Accepted inputs get a server-global `order` (`room.order++`, `:365`), go through
`recorder.submit` (competitive) or `match.submit` (practice), and are remembered in
`seat.pending` until committed. The seq number is consumed **whether accepted or rejected**
(`:360`). The server then sends **a full checkpoint to the sender** (`:381`).

### 3.5 Authoritative simulation (`rooms.ts:533-540`, `match.ts:249-278`)

`Rooms.tick()` runs every 10 ms (`app.ts:109`):

```ts
target = max(match.frame, floor(max(0, simulationNow − 100) / FRAME_MS));   // :534
recorder ? recorder.advanceToFrame(target) : match.advanceToFrame(target);
drop seat.pending entries with frame < match.frame;  collect events;  result();
```

`simulationNow = now − origin − pausedTotal` while playing (`:339-342`). `Match.advanceToFrame`
processes half-open frames. Inside a frame it repeatedly takes the earliest of
(next queued input time, every board's `nextStepAt` deadline) and ticks or applies it.
**Deadlines run before inputs at equal times; inputs sort by (frame, subframe, order)**.
At each frame end it reconciles crossing attacks (`flushOutgoing`) and resolves deaths
(`finishFrame`).

### 3.6 Acknowledgement (`rooms.ts:573-584`)

Every checkpoint carries the owner's `InputAck`:
`generation`, `epoch`, `nextSeq`, `resolvedThroughSeq` (= lowest still-pending seq − 1),
`pendingAccepted` (accepted but uncommitted, with server `order`) and `rejections` (last ≤256).

### 3.7 Client reconciliation (`session.ts:399-442`, `276-358`)

On each checkpoint, in order:

1. Drop it if `serverSequence ≤` the last one seen (`:400`).
2. If `matchId:round:generation:epoch` changed → `invalidate()` (clear pending, prediction,
   keys), adopt the server's `nextSeq`, clear `releasing` (`:405-415`).
3. Prune `pending`: keep items with `seq > resolvedThroughSeq`, not rejected, and either not
   yet seen by the server (`seq ≥ nextSeq`) or in `pendingAccepted` (`:421-422`).
4. **If any local pending item was rejected → `release("rejected-input")`** (`:424`).
5. If a `SEQ_GAP` was outstanding: either retransmit from the server's `nextSeq` (mark
   `sent=false`) or release (`gap-recovery`) (`:425-431`).
6. `rebuild(true)` (`:276-312`):
   1. **N1-B stale recovery** `recover(cp, accepted)` (`:314-358`). It runs when some pending,
      unaccepted items have `frame < cp.state.frame` ("stale"). It succeeds only if *every*
      stale item has **never been transmitted**, the stale items form the head of the unsent
      tail, and no gap retry is pending (`!sent && transmitted`). On success:
      * the stale items are retracted, so the server never sees them;
      * the remaining unsent items are renumbered contiguously from the server's `nextSeq`,
        so freed numbers were never used and nothing transmitted is renumbered;
      * for each held control (left, right, soft drop) the **last** stale transition wins. If it
        differs from the held state in the checkpoint, one corrective `*Down`/`*Up` is queued at
        the current `target()`;
      * stale one-shots (rotations, Hard Drop, Hold) are **dropped**, never replayed onto a
        later piece;
      * diagnostics record `staleRecovery {retracted, reissued}`.

      If recovery is not possible → `release("stale-prediction")` (`:289`).
   2. New `OwnerPrediction(cp.state, me)`, which already enqueues the server's backlog of *my*
      accepted inputs (`prediction.ts:85`). Then re-submit every pending item not in
      `pendingAccepted` with order `2^48 + seq`. A remaining item with `frame < cp.state.frame`
      → `release("stale-prediction")` (`:293`). Advance to `max(previous prediction time, target())`.

**When N1-B can and cannot help.** Recovery only happens inside `rebuild()`, against the
checkpoint the client currently holds. After a stall, the browser may run the trailing-flush
timer or a fresh keydown **before** it processes the queued post-stall checkpoints. In that
case `flushInputs` transmits the stale items, which turns them into `transmitted`, the
server rejects them, and the client takes the full release. Measured in the harness by
delaying the first post-stall checkpoint by 20–30 ms: a full reset in 3/3 orderings
([03 §3.6](03-LATENCY-AND-FAILURE-ANALYSIS.md#36-browser-stalls-vs-network-stalls-measured-traces)).
Which order a real browser uses (input, timer and network task queues) is **not verified**.

`release(reason)` (`:199-210`) clears local keys, drops all pending inputs and the prediction,
sets `releasing`, and sends `releaseControls`. The server then runs `invalidate(seat)`
(`rooms.ts:325-337`): `Match.releaseControls(seat)` releases held keys and **drops that seat's
queued (uncommitted) inputs**, `generation++`, `nextSeq = 1`, and history and rejections are
cleared. It answers with a checkpoint. When that arrives, the identity change ends
`releasing`. **Play is blocked for at least one RTT, and every input in flight is
discarded.**

### 3.8 Rendering

`main.ts:556-599`: each animation frame calls `online.update()` → `session.tick()`
(`session.ts:501-529`). That tick pings every 2 s, requests `resync` when no checkpoint has
arrived for 2 s, advances the prediction to `target()` and flushes inputs. The frame then
draws the prediction's `GameState` as the local board. Local input-to-render latency
is therefore **one animation frame**, independent of RTT, as long as `canPlay` holds.

### 3.9 Per-input-type behaviour

| Input | Core semantics (`game.ts:276-319`) | Network consequence |
|---|---|---|
| `LeftDown`/`RightDown` | Sets held flag. Immediate move. DAS timer `moveAt = now + das·F` (charged instantly at a wall). | Level transition. Re-timing it shifts DAS start. Losing it leaves the key "up" on the server. |
| `LeftUp`/`RightUp` | Clears held flag. Recomputes direction. | **Losing it leaves the key held on the server** (piece keeps auto-shifting). This is why any rejection forces a full reset. |
| `SoftDropDown`/`Up` | Held. Falls one or two cells on press, then repeats at `sdarr`. | As above. |
| Rotations, `HardDrop`, `Hold` | One-shot. Acts on the *current* piece at that time. | Applying it at a different time can hit a **different piece**, if a lock happened in between. |
| Continuous movement (DAS/ARR) | Generated by core deadlines (`moveAt`), not by network messages. | Correct on the server as long as the Down/Up pair is correct. |

**Existing wrong-piece hazard (current code).** A rejection is per item. Later items in the
same or following batches can still be accepted until the server processes the
`releaseControls` one RTT later. Example: a late `HardDrop` is rejected, and a `RotateCw` sent
40 ms later arrives in time and is accepted. The server then rotates the *undropped* piece,
which the player meant for the next piece. The full reset limits how long this can happen but
does not prevent it. Any recovery design must state its piece-ownership invariant
([06 invariants](06-IMPLEMENTATION-ROADMAP.md#global-invariants)).

### 3.10 Reordering, gaps, reconnects, generations

* WebSocket over TCP preserves order. Messages are never reordered, only delayed and
  bunched. A loss shows up as head-of-line delay.
* `SEQ_GAP` happens only if the client skipped a sequence (e.g. a lost batch after a reconnect
  race). The client retransmits from the server's `nextSeq` or releases (`session.ts:425-431,
  488-492`).
* **Generations**: every `invalidate(seat)` bumps `seat.generation`. This happens on hello,
  release, pause, round start, practice undo/reset and set end. Batches with an old generation
  are rejected as a whole (`STALE_INPUT`), so a stale timer cannot inject old inputs into a new
  connection (tests `session.test.ts:187,239`).
* **Epochs**: per-board epoch (`Match.playerEpoch`) bumps on round change, practice undo and
  reset.
* **Reconnect**: socket close → `Rooms.disconnect` (`rooms.ts:384-401`) → if the room is
  active, **the whole room pauses** (`pause`, `:403-412`): simulation clock frozen, every seat
  invalidated. Each disconnected seat has a 40 s reservation. On `hello` with the resume token,
  the seat is re-bound (`:207-242`). When all eligible seats are connected, `resume` → `prepare(room,
  true)` → every client must answer `prepared` (10 s deadline) → **3 s countdown** → playing.
  Any socket loss during play therefore costs **every player** at least
  RTT + 3 s of frozen play.
* **Heartbeat**: the server sends native WebSocket pings every 2 s and closes a lease after
  6 s without a pong (`app.ts:112-121`). Browsers answer pings in the network stack, so a JS
  freeze alone should not trigger this. A path outage longer than ~6 s will.

---

## 4. Clock and simulation model

### 4.1 Clocks that exist

| Clock | Where | Notes |
|---|---|---|
| Server wall clock | `performance.now()` in Bun (`Rooms.now`) | Monotonic. |
| Server simulation clock | `simulationNow = now − origin − pausedTotal` (`rooms.ts:339-342`) | Round-relative. Frozen when not playing. Reset per round (`:522`). |
| Committed frame | `match.frame` | `floor((simNow − 100)/F)` at the last 10 ms tick. |
| Client offset estimate | `Session.offset` | Initialised from `welcome.serverNow` (one-way, biased by the downlink delay). Then replaced by **the single lowest-RTT ping sample ever seen** on this connection: `offset = serverNow − (sent + received)/2` (`session.ts:449-460`; welcome at `:373`). Pings every 2 s. |
| Client prediction time | `prediction.atMs` | Advances to `target()` every frame. Monotonic. |

There is **one shared simulation timeline** for all players of a room. Every board advances
through the same frames in the same `Match`, so players share the same committed timeline.

### 4.2 What each party is looking at

| Party | Time it shows |
|---|---|
| Own board (prediction) | ≈ server sim time **now** (± clock-estimate error). |
| Opponent boards | Last checkpoint's committed frame ≈ server now − 100 ms − (≤17 ms frame quantisation) − (≤10 ms tick phase) − downlink delay − age of the checkpoint (0–50 ms). Measured p50 at 10 ms RTT: **140 ms** behind; 200 ms RTT: **223 ms**; 600 ms RTT: **428 ms** ([03 §3](03-LATENCY-AND-FAILURE-ANALYSIS.md#3-measured-results)). |
| Server authority | Committed frame (100 ms behind its own sim clock). |

### 4.3 The input deadline, derived

Notation: `F = 1000/60 ms`. `U`, `D` = current up/down one-way delays. `U*`, `D*` = the delays
during the best ping sample. `W` = throttle wait (0–34 ms). `j` = extra queueing/jitter
above `U*`.

* The client's estimate of server time has error `e = (U* − D*)/2` (the standard NTP
  midpoint assumption).
* The input is stamped `T = S_send + e`. It reaches the server at sim time `S_arr = S_send + W + U`.
* **Lateness at arrival**: `L = S_arr − T = W + U − e = W + (U* + D*)/2 + j = W + RTTmin/2 + j`.

The asymmetry terms cancel. What matters is **half the minimum RTT plus throttle wait plus
jitter**, not the upstream delay alone. This matches the measurements: 20/180, 180/20 and
60/140 ms splits all reject about 20% of inputs at 200 ms RTT ([03 §3.3](03-LATENCY-AND-FAILURE-ANALYSIS.md#33-asymmetric-links-measured)).

* Accept iff `floor(T/F) ≥ match.frame`, where `match.frame = floor((S_tick − 100)/F)` and
  `S_tick ∈ (S_arr − 10, S_arr]`.
* **Always accepted** if `L ≤ 100 ms`. **Always rejected** if `L ≥ ~127 ms` (100 + one frame
  + one tick). In between it depends on frame phase.

So "commit delay 100 ms" does **not** mean "RTT > 100 ms fails". With no jitter and no throttle
wait, RTT up to ~200 ms is accepted. In practice `W` and `j` eat the margin. The measured
onset is 160 ms RTT, and **from 250 ms RTT essentially every input is rejected**.

**Upper bound**: `frame > floor(simNow/F) + 2` rejects inputs stamped more than ~2 frames in
the future. With the NTP-style estimate a stamp is always in the past on arrival, so this
only fires on clock error larger than ~33 ms in the "ahead" direction. That would take a
large offset change or drift. It is also the mechanism that **prevents faster-than-real-time
play** (§8).

### 4.4 Clock-estimate weaknesses (code facts, impact hypotheses)

1. **The offset never adapts while connected unless a new minimum RTT appears.** Relative
   drift between the server's and browser's monotonic clocks therefore accumulates for the
   life of the WebSocket, which can span many rematches. At 20–50 ppm that is 1.2–3 ms per
   minute: 36–90 ms after 30 minutes, which is the whole margin. *Not measured.* The
   diagnostics do not record the implied offset per pong. See [03 §6](03-LATENCY-AND-FAILURE-ANALYSIS.md#6-diagnosis-plan-for-antideploysingapore).
2. **Route changes** that *raise* the minimum RTT leave the offset biased. Route changes that
   *lower* it are adopted.
3. Before the first pong, the welcome-based offset underestimates server time by `D`. In
   practice preparation plus a 3 s countdown give one or two pings first.

### 4.5 Latency, jitter, clock error, scheduling delay, browser stalls

| Factor | Where it enters | Effect in the current model |
|---|---|---|
| Base latency (RTTmin/2) | `L` | Consumes the 100 ms window. Opponent boards lag by `D`. |
| Jitter / bursts | `j` | Spikes beyond the margin → late → **reset**. TCP head-of-line delay means one spike delays every later message too. |
| Clock-estimate error / drift | `e` drift | Shifts `L` slowly. Can move a healthy connection to the cliff (hypothesis). |
| Server scheduling delay | 10 ms tick, `setInterval` jitter, GC, CPU steal on shared VMs | Late ticks *lengthen* the window (commit happens later). Late input processing (event-loop backlog) *adds to `L`*. |
| Browser stall (main thread) | Events dispatched late; checkpoints processed late; trailing flush fires late | Inputs are stamped at dispatch (safe). Unsent inputs queued before the stall go stale. **N1-B retracts them** (held controls re-issued, one-shots dropped) **if a checkpoint is processed before the trailing flush or the next keypress**; otherwise they are transmitted, rejected and fully reset (§3.7). Stalls > 2 s also make `canPlay` false until a checkpoint is processed. |
| Network outage | Up/down paths blocked | Inputs pressed during the first 2 s of the outage are sent into the void and rejected on arrival → reset. The server keeps held keys held. After ~6 s the heartbeat closes the lease → room-wide pause. |
| Downlink congestion | Large checkpoints queue in the TCP send buffer | Checkpoint age grows → acks, opponents and results arrive late. Pongs queue too. See §6.3 and [03 §4](03-LATENCY-AND-FAILURE-ANALYSIS.md#4-bandwidth-and-queueing-the-oversized-checkpoint-finding). |

### 4.6 Unequal acceptance conditions

The commit delay is room-wide, but each player's lateness `L` depends on their own path. A
20 ms player and a 250 ms player in the same room have the same timestamp rules. The first has
~80 ms of margin; the second has a negative margin and loses essentially every input
(measured: 4-player 20/60/180/300 → 100/100/91/0% accepted). The rules are equal but the
outcome is not. When an input *is* accepted, it takes effect at the player's estimated
physical time, so a high-latency player's accepted inputs are effectively backdated by
`RTT/2`. This is the "lag compensation" end of the trade-off.

---

## 5. Client reconciliation in detail

### 5.1 What causes visible rubber-banding vs. genuine input loss

| Symptom | Cause in code | Inputs lost? |
|---|---|---|
| **Board snaps back, keys "stop working" for ~1 RTT** | `release()` from `rejected-input` / `stale-prediction` / `gap-recovery` / `sequence-expired` / `rate-limit` / `wrong-phase` (`session.ts:199-210, 289, 293, 424, 428, 493-497`) | **Yes.** Every pending and in-flight input is discarded, and the server drops queued inputs. Held keys are released on both sides. Subsequent presses are ignored until a new-generation checkpoint arrives. |
| Board briefly freezes then jumps forward | `canPlay` false (no checkpoint for ≥2 s, frozen clock, releasing). The display keeps the last prediction (`main.ts:574-576`). | Presses during the freeze are **ignored** (not queued). |
| Small correction (garbage appears, piece shifts by a cell) | `rebuild(true)` with a different authoritative input: opponent garbage, cancellation, target change, or own-input timing quantisation. Classified by `classifyCorrection` (`session-diagnostics.ts:73-86`). | No. |
| Board jumps forward after a browser stall | The prediction catches up to `target()` in one step. | No (unless the stall also triggered a reset). |

**Prediction corrections are not server-side divergence.** The server simulation is the only
authority, and replays prove it is deterministic. A "correction" means the client's
*speculative* board differed from the authoritative one at the same simulation time. Most
of these differences are external interactions the prediction cannot know about yet
(`prediction.ts:160-169`: it never invents incoming garbage).

### 5.2 The 2-second checkpoint timeout

`canPlay` requires `now − receivedAt < 2000` (`session.ts:220`). `tick()` sends a `resync`
(rate-limited to once per 500 ms) once that passes (`:524`). The server's `resync` handler just
sends a checkpoint (`rooms.ts:156`). No reset happens: once a checkpoint arrives, play resumes
with the same generation, if the pending inputs are still valid.

### 5.3 Sequence ownership rules (must not be broken)

* A seq number belongs to one `(generation)` and is consumed by the server whether accepted
  or rejected (`rooms.ts:360`). It must never be reused for a different input in the same
  generation. Reuse with a different fingerprint is `SEQ_CONFLICT`, which **closes the
  socket** (`:356`).
* After a generation change the client restarts at the server's `nextSeq` (`session.ts:412`).
* The N1-B review found real defects here (in-flight seq reuse, recovered-control ordering,
  retransmission tail). Any recovery code must keep these as tested invariants.

---

## 6. Opponent visualisation and costs

### 6.1 How opponents are drawn

`online-view.ts:307-380`: on each animation frame, if the latest checkpoint's
`serverSequence` changed, every opponent board is redrawn with `drawMultiplayerBoard(board,
cp.state.players[i].game, skin)` (`multiplayer-board.ts:44`). There is:

* **no interpolation, extrapolation, buffering or local simulation of opponents**;
* an update rate equal to the checkpoint arrival rate: 20 Hz broadcast, plus extra checkpoints
  when *you* send inputs. Measured: ~21–22 distinct opponent states per second;
* a lag equal to the commit delay + downlink delay + checkpoint age (§4.2).

Visually, opponents move in ~50 ms steps about 140–160 ms behind on a nearby server.
Gravity and DAS motion visibly step at 20 Hz.

### 6.2 What a checkpoint contains (`rooms.ts:573-584`)

`room` view, `matchId`, **`state: room.match.saveState()`** (all boards with full
`GameState`, garbage queues and RNG states, routing RNG, **all players' uncommitted input
backlog**, undrained events), the owner ack, clock data, `roundDurations`, and
**`events: [...room.events]` — the last ≤256 Match events of the set** (`collect`, `:551-558`).

The client uses `events` for exactly one thing: finding the latest `roundEnd`/`setEnd` for the
results text (`online-view.ts:327`).

### 6.3 Measured sizes and costs (Bun 1.4.2, Ryzen 7 9800X3D; [03 §4](03-LATENCY-AND-FAILURE-ANALYSIS.md#4-bandwidth-and-queueing-the-oversized-checkpoint-finding))

| Players | Checkpoint after 20 s | of which `events` | `state` | Per-seat at 20 Hz | Room egress at 20 Hz |
|---|---|---|---|---|---|
| 2 | 27.7 KB | 21.8 KB (63 events) | 4.7 KB | 540 KB/s | 1.1 MB/s |
| 4 | 53.2 KB | 41.7 KB (116) | 9.9 KB | 1.0 MB/s | 4.2 MB/s |
| 8 | 105.7 KB | 84.5 KB (235) | 19.0 KB | 2.1 MB/s | 16.5 MB/s |

Once 256 events have accumulated (≈90 s of 2-player play), a 2-player checkpoint is
**~95 KB**. Input-triggered checkpoints come on top of the 20 Hz broadcast. Measured average
delivered downstream was 0.56–0.93 MB/s per client (2 players) and 1.6–1.9 MB/s per client
(8 players).

Server CPU per simulated second (in-process harness, excluding socket I/O): 2 players ≈ 5 ms,
4 ≈ 15 ms, 8 ≈ 52–55 ms. **The Match simulation itself is < 0.5 ms/s even with 8 players.**
Almost all cost is `saveState()` + copying `events` **once per seat per checkpoint** and
JSON-stringifying it per seat.

`app.ts:75` skips an *ephemeral* checkpoint when Bun reports >64 KiB buffered. Two caveats:
(1) a single checkpoint already exceeds that, and (2) whether `getBufferedAmount()` sees the
kernel send buffer is **not verified**. If it does not, data queues invisibly in the kernel and
latency grows before backpressure is ever detected (modelled in [03 §4](03-LATENCY-AND-FAILURE-ANALYSIS.md#4-bandwidth-and-queueing-the-oversized-checkpoint-finding)).

### 6.4 Can this layer survive an architecture change?

The renderer (`drawMultiplayerBoard`, `drawSnapshot`) needs only a `GameState` per player and a
garbage total. Any architecture that can produce a `GameState` per opponent per frame can
reuse it unchanged. That includes local replicas, interpolated snapshots, or
independent-timeline reconstruction. The data source (`cp.state.players[i]`) is what would
change.

---

## 7. Garbage and multiplayer interactions

All of this is in `Match`, so it runs only on the server. Prediction runs a one-board subset.

| Step | Code | Rule |
|---|---|---|
| Attack generation | core `resolveClear` → `LockResult.attacks` | From the clear, spin, combo/B2B, all-clear. Never client-supplied. |
| Settlement at lock | `Match.settle` (`match.ts:280-298`) → `settlePlacement` (`placement.ts:10`) | For each packet: cancel own incoming queue FIFO, including not-yet-eligible packets, with an opener bonus while ≤14 pieces and pending ≥ sent. The remainder is sent. |
| Target selection | `match.ts:285-289` | One random living, non-withdrawn, non-topped-out opponent per placement bundle, from the routing RNG (seeded per round). |
| Staging | `this.outgoing` | Packets wait until the end of the frame. |
| Crossing cancellation | `flushOutgoing` (`match.ts:300-322`) | Opposite-direction packets **within the same frame** cancel 1:1 FIFO before queueing. Packets from different frames do not cross. |
| Queueing | `:313-320` | Pushed to the recipient queue with `eligibleAtMs = lock time + 20 frames (333.3 ms)` (`garbage.ts:4`). Discarded if the recipient is withdrawn or topped out. |
| Insertion | `GarbageQueue.insert` (`garbage.ts:240-256`) | At the recipient's **non-clearing** lock, eligible packets insert up to 8 rows (cap), with the hole from the recipient's hole RNG. A line clear blocks insertion. |
| Deaths | `finishFrame` (`match.ts:328-353`) | All top-outs within a frame are resolved together. 0 survivors = draw. 1 survivor scores. `firstTo` completes the set. |
| Forfeit | `match.ts:218-234` | Withdraws a seat. Its queue is discarded; packets it already sent remain. |

**Single-board events** (affect only one board): movement, rotation, lock, clear, insertion
of already-queued garbage, top-out of that board.

**Multi-player events** (need arbitration): target choice, packet existence/size (derived
from the sender's lock), cancellation against the recipient's queue at the recipient's lock
time, crossing within the same frame, **which packets are in a recipient's queue at the
moment of its lock** (this depends on cross-board ordering), simultaneous deaths, round/set
outcomes.

**The prediction knows incoming packets only as of the checkpoint.** Packets sent by opponents
after the committed frame are unknown. The 333 ms eligibility delay hides most of this: an
unknown packet can only change a predicted *insertion* if the client predicts more than ~333
ms past the committed frame. That needs `commitDelay + D + checkpointAge (+ lead) > 333 ms`.
At current settings that is ≈ RTT/2 > ~200 ms. Unknown packets *can* change predicted
*cancellation* (meter, sent count) at any RTT. That shows up as a `garbage`/`sent`
correction, not a board correction.

---

## 8. Server authority and what a modified client can do today

| Attack | Current status |
|---|---|
| Claim boards, attacks, scores, targets | **Prevented.** Strict schema; attacks are derived from inputs. |
| Faster-than-real-time play | **Prevented.** Stamps > now + 2 frames are rejected; the server clock paces commits. |
| Backdating | **Bounded to ~100 ms** (the uncommitted window). A modified client can stamp an input anywhere in [committed, now+2f]. That means up to ~100 ms of "thinking time" per action. It cannot see anything newer than the committed state it has. |
| Seeing the future | Clients receive all RNG states (bag, routing, holes) and every player's **uncommitted input backlog** (`MatchState.inputs`). A modified client can therefore know its whole future piece sequence (beyond 5 previews), future garbage hole columns and target choices, and see opponents' inputs up to ~100 ms before they are committed. This is **inherent to owner prediction** (the predictor needs the bag and hole RNG) and is a known, accepted exposure class. It is not a server bug. |
| Bots / macros / input assistance | **Not prevented** (no architecture prevents it). Deterministic verification proves legality, not humanity. |
| Reconnect abuse | Each disconnect pauses the room for everyone (preparation + 3 s). A griefer can repeatedly cause ≥3 s pauses. Another seat's disconnect does not extend an existing reservation (test `rooms.test.ts:196`), but after a successful reconnect, a new disconnect starts a fresh 40 s reservation (`rooms.ts:394`). Nothing limits the number of pauses per player. |
| **Bandwidth amplification** | Each `inputBatch`/`resync` returns a full checkpoint to the sender (~95 KB once events saturate). Within the rate limits (~40 commands/s/socket, ≤128 sockets) one actor can make the server emit several MB/s per socket. The "ephemeral" skip bounds per-socket queueing but not egress. **This is a cost/availability concern on metered free hosting.** See [03 §4.4](03-LATENCY-AND-FAILURE-ANALYSIS.md#44-security-note-egress-amplification). |

---

## 9. Replay coupling

Details are in [05](05-REPLAY-COMPATIBILITY.md). The essentials:

* `MatchRecorder` wraps the live `Match` (`rooms.ts:303`). Every `submit`, `advanceToFrame`,
  `releaseControls`, `forfeit` and `nextRound` the server performs is journaled as a
  `MatchRecord { seq, before:{round,frame}, op }` (`match-driver.ts:4-15`).
* Replay = the **server's operation log of one shared timeline**. Rejected inputs are not in
  it. Releases are, so network trouble leaves visible traces in replays.
* Verification re-executes the journal through `MatchDriver` (the real `Match`) and checks
  the final digest and summary (`verify.ts:169`).
* The viewer consumes only `MatchState` snapshots (`match-replay-view.ts:39`). It is
  independent of how the state was produced.
* Decoding pins exact `simulation`, `coreState`, `coreRules`, `matchState` and `garbage`
  versions and rejects anything else as `unsupported` (`decode.ts:130-150`). **Today a rules
  or Match version bump makes every older replay undecodable.** This matters for M4.
* Practice never creates a recorder (`rooms.ts:302`, `MatchRecorder` constructor throws).

**Everything in the current netplay pipeline that changes *admission* (which inputs are
accepted, at what timestamp) leaves the replay format untouched.** Only the journal content
changes. Changing *how* `Match` interleaves boards or applies garbage is a replay-format change.

---

## 10. Reconnect and timeout reference

| Event | Timer | Code |
|---|---|---|
| Client checkpoint staleness → stop inputs, resync | 2 000 ms | `session.ts:220,524` |
| Client `resync` rate limit | 500 ms | `session.ts:360-364` |
| Client reconnect backoff | 600·2^n ms, max 4 000, 8 attempts | `session.ts:154-161` |
| Server native ping / lease timeout | 2 s / 6 s | `app.ts:112-121` |
| Hello required | 5 s | `rooms.ts:488` |
| Seat reservation after disconnect | 40 s | `rooms.ts:394` |
| Preparation ack deadline | 10 s | `rooms.ts:318` |
| Countdown (start, resume, next round) | 3 s | `rooms.ts:179,469` |
| Empty room / idle result-lobby expiry | 60 s / 15 min | `rooms.ts:480-483` |
| Elysia `idleTimeout` | 10 s | `app.ts:32` |
| Backpressure close | 256 KiB | `app.ts:32` |

---

## 11. Existing test coverage relevant to netplay

* `packages/web/netplay-latency.test.ts` (N1-A + N1-B): 2 clients only (`ClientKey = "a" | "b"`,
  `netplay-harness.ts:16`). Covers 180 ms RTT with inputs ≥60 ms apart (so no throttle wait),
  seeded jitter, 400 ms and 2.5 s stalls, 250 ms upstream asymmetry, checkpoint bursts,
  round/generation isolation, garbage-correction classification and diagnostics bounds.
  N1-B adds a `stale input recovery` suite (`:334-487`): 300/500 ms stalls inside the throttle
  window, an unsent stale Hard Drop or rotation (dropped), a held direction and soft drop
  across a stall, repeated stalls, and a transmitted-but-unacknowledged stale input (still a
  full release).
* The harness models per-message delay, jitter, ordered delivery, stalls and downstream holds.
  At equal effective times it always delivers **queued messages before timers and before
  input actions**. That is the one post-stall ordering in which N1-B recovers (§3.7). It does
  **not** model upstream holds, bandwidth/queueing, server backpressure skipping, native
  heartbeat, more than two players, or the real browser event loop.
* `packages/web/session.test.ts`: throttle, batching, generation and sequence rules, stale
  snapshots, clock-correction monotonicity.
* `packages/server/test/rooms.test.ts` and `websocket.test.ts`: admission dispositions, future
  horizon, pause/resume, heartbeat, recorder integration, replay access control.
