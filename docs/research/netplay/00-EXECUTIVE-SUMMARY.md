# 00 — Executive summary: 42tris netplay investigation

**Date** 2026-11-03 · **Code audited** `main` = GitHub `main` = `a4a9e8e95fff86ab43e081220c8bac36de1a55f7`
(N1-B; the pipeline was first audited at its parent `fe92d94`, N1-A) · **Scope** research and
documentation only; no production code was changed.

**What was done.**
* Read the full online pipeline: browser input → `Session` → WebSocket → `Rooms` → `Match` →
  checkpoints → reconciliation → rendering → replay recorder.
* Read Techmino's client and Techrater's server source.
* Collected TETR.IO's public statements and evaluated the ZBB anecdotes.
* Ran ~60 reproducible fake-time experiments: the real server and client code, 2–8 players,
  10–600 ms RTT, jitter, spikes, stalls, outages and bandwidth limits.

---

## N1-B status

N1-B (stale-input recovery) is on `main` as `a4a9e8e`. 648 tests pass and type checks are
clean. I re-ran every experiment on it: **no conclusion changes**. N1-B does not affect the
latency cliff, because those resets come from inputs that were already sent.

**One gap found.** N1-B recovers only if the browser processes a fresh checkpoint *before*
anything sends the stale input.

* If the delayed-send timer or a new key press runs first after the stall, the stale input
  goes out, is rejected, and the old full reset happens.
* The harness reproduced this in 3 of 3 such orderings.
* Which order a real browser uses is not verified.

The fix is small: before sending, check whether the input is already too old, and if so wait
briefly for a checkpoint ([N2-0](06-IMPLEMENTATION-ROADMAP.md#n2-0--close-the-n1-b-post-stall-ordering-gap)).
The commit message's claim about sequence-number ordering also differs from what the code
does. That is worth a deliberate decision and a test.

---

## The current architecture in plain English

The server runs **one shared, deterministic game clock** for the whole room. Your browser:

1. guesses the server's current game time,
2. shows your key press **immediately** on your own board,
3. sends the press, tagged with that time.

The server "locks in" history 100 ms behind its clock. An input that arrives **after its moment
has been locked in is rejected**. When that happens, your browser throws away your pending
inputs, releases all keys, and waits about one round trip for the server to resync you. That
reset is the snap-back and "my keys stopped working" feeling.

Opponents' boards are not simulated in your browser. They are pictures from the server, about
20 per second, roughly 150 ms behind on a nearby server. Replays are a recording of exactly
what the server's game did, so they are fully verifiable.

## Main findings

1. **There is a sharp latency cliff, and it explains "extremely laggy" well.** What matters is
   *half* the round-trip time, plus up to 34 ms of send batching, plus jitter.
   * Up to **140 ms RTT**: every input is accepted.
   * At **160 / 180 / 200 / 220 ms**: 1% / 11% / 22% / 50% of inputs are rejected.
   * From **250 ms**: essentially **all** inputs are rejected. Control is blocked ~40% of the
     time, and the board keeps snapping back.

   Paris→Singapore is ~150 ms datacenter-to-datacenter (third-party measurement). With home
   connections and a hosting proxy it plausibly reaches 160–250 ms, which is right on the cliff.
   It is **not** "100 ms commit delay so anything above 100 ms fails". Inputs are stamped at the
   estimated *current* server time, which is why 100–140 ms works fine.
2. **Checkpoints are oversized.** Every one re-sends the last 256 game events (only used to
   show "X wins"). That reaches **~95 KB per message** in 2-player games and over **100 KB** with
   8 players, at 20+ messages per second per player. Measured: ~0.6–0.9 MB/s per player (2p),
   ~1.6–1.9 MB/s (8p). On a slow or long link this can queue for **seconds** (modelled). It is
   also the dominant hosting cost and a bandwidth-amplification risk.
3. **Running the game on the server is cheap.** Simulating 8 boards costs <0.5 ms per second.
   The expensive part is building and serialising those big checkpoints, once per player.
   **A relay-only server is not needed for free hosting.**
4. **Short jitter spikes on a nearby server also cause resets.** At 60 ms RTT with 5% of
   messages delayed 150 ms, players see 9–18 resets per minute. This is a likely explanation of
   the earlier intermittent rubber-banding. Browser stalls between a key press and its delayed
   send are another. N1-B handles that one when a checkpoint is processed first (see above).
5. **Outages behave badly but predictably.**
   * During a 3 s network drop, the server keeps your held key held, and the presses you made
     are rejected when they finally arrive.
   * A ≥6 s drop disconnects you and **pauses the whole room**, followed by a 3 s countdown
     (~9.7 s total). That pause-plus-countdown is a plausible cause of the "~3 s pause" report.
6. **A per-player "input lead" fixes the cliff without a rewrite.** Each browser stamps its
   inputs a little *ahead* (0 ms for nearby players, ~100 ms at 300 ms RTT), and the server
   accepts slightly-future inputs.
   * In the harness this gave **100% acceptance and zero resets at 200, 300 and 500 ms RTT**,
     and under spikes when the lead covers them.
   * Nearby players were completely unaffected.
   * Your own board still responds instantly.
   * The only cost is that a distant player's actions take effect slightly later on the shared
     clock. They pay for their own latency, which is fairer than today's lock-out.
7. **Techmino** runs every board on every client from input streams, and its server only
   relays. Its source shows **no server-side validation**: a modified client could run faster
   than real time or quietly ignore garbage. **TETR.IO**'s public notes confirm regional proxies
   ("spools") in front of game servers that stayed in France, but not its netcode internals.
   **ZBB**'s anecdote is a warning: a validator that treated *late* data as *invalid*, and
   rolled players back, made things worse.

## What caused what (honest status)

| Observation | Most likely cause | Status |
|---|---|---|
| Singapore host "extremely laggy" | Latency cliff (finding 1), possibly worsened by checkpoint queueing (finding 2) | **Hypothesis consistent with measurements.** Not measured on Antideploy. The [diagnosis plan](03-LATENCY-AND-FAILURE-ANALYSIS.md#6-diagnosis-plan-for-antideploysingapore) can confirm it in one session |
| Rubber-banding on an overloaded laptop, opponent fine | Jitter spikes (4) or stall-before-send. The latter was reported before N1-B; N1-B covers it only in one post-stall ordering. Resets only affect the late player | Hypothesis |
| ~3 s pause | Socket drop → room pause + 3 s countdown, or 2 s missing checkpoints + resync | Hypothesis; diagnostics can tell them apart |
| Paris/UK test smooth | Everyone well under 140 ms RTT | Consistent with the measurements |

## Is a rewrite justified?

**No.** The measured problems come from three specific, fixable choices: stamping at "now" with
a fixed window, oversized checkpoints, and drawing opponents from 20 Hz snapshots. None of them
is inherent to server authority. Independent player timelines (Architectures B/C) would trade
a ~100 ms bound on timing manipulation for a multi-second one. They would also require a new
replay format, driver, verifier and synchronisation scheme. In the [weighted
comparison](04-ARCHITECTURE-OPTIONS.md#7-weighted-decision-matrix) the improved current design
scores **86%** against 64–67% for B/C, and it still wins with "feel-first" weights.

## Recommendation: "A+" — keep the authoritative server, fix what was measured

1. **Close the N1-B ordering gap** (N2-0): a small `session.ts` change plus three tests.
2. **Diagnostics** (N2-A): add checkpoint age, bytes per second, clock drift and blocked
   time to `?diagnostics`, plus optional server counters. Then run the Singapore diagnosis.
3. **Checkpoint diet** (N2-B): send only the result events, and build each checkpoint once per
   broadcast. ~5–20× less bandwidth, ~N× less server CPU. No gameplay or replay change.
4. **Per-player input lead** (N3-A…C): server accepts up to 250 ms-ahead stamps; client
   chooses its lead from measured RTT and jitter (0 for nearby players). Plus a better clock
   estimate (N3-D).
5. **Outage policy** (N2-C): release held keys after ~3 s of silence. Stop accepting presses
   the client cannot deliver.
6. **Smooth opponents** (N4-A): simulate opponents locally from each checkpoint, so they move
   at 60 fps with the same delay as today.
7. **Replays (M4) in parallel**: add a **versioned engine registry first**. Today *any* rules
   change would make every stored replay unplayable. Then storage, share links with the
   sharer's skins, and a public viewer.

Optional later, only if measurements demand it: incremental "ops" streaming instead of full
states (N4-B), server re-timing of late inputs with a piece guard (N5, needs a new Match
version), and a Techmino-like hybrid prototype on a separate branch (N6).

## Risks and trade-offs

* A distant player's attacks land up to their lead (~100 ms at 300 ms RTT) later on the shared
  clock. Their view of incoming garbage can be corrected more often above ~300 ms RTT.
  Corrections, not resets.
* Spikes larger than the chosen lead still cause a reset. The adaptive policy raises the lead
  when that happens.
* A 6 s+ outage still disconnects. Whether the room should pause or keep playing for a grace
  period is **your product decision** ([N2-C](06-IMPLEMENTATION-ROADMAP.md#n2-c--silence-and-outage-policy)).
* Harness results are not internet results. Real tests ([07](07-TESTING-AND-ACCEPTANCE-PLAN.md#real-browser-and-real-network-tests))
  are required before calling it fixed.

## Do **not** change yet

* The 100 ms commit delay. Raising it slows every player's view of opponents.
* `Match`, core rules, the garbage profile or the replay format. Anything that changes
  simulation needs the M4-A engine registry first.
* Rollback of committed server state, in any form.
* Client-reported attacks, results or "trusted client" shortcuts.
* Recording practice rooms.
* The protocol schema's strictness (`additionalProperties: false`).
* Anything requiring paid or regional infrastructure.

## Read next

[README](README.md) for the reading order. [03](03-LATENCY-AND-FAILURE-ANALYSIS.md) for the
numbers. [06](06-IMPLEMENTATION-ROADMAP.md) for exactly what to build, in order.
