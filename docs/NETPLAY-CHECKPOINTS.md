# N2-B checkpoint measurements

N2-B changes outbound event selection and shares snapshot construction across
recipients. Every checkpoint still carries the complete Match state and its own
seat's acknowledgement. Protocol schemas, gameplay, admission, clocks, replay
engines, checkpoint frequency and transport backpressure handling are unchanged.

The implementation started at `62d66a8a3cd1592f28e3a217a3702724cac68ee4`.
The baseline suite passed 756 tests. The research under `research/netplay/`
describes an earlier baseline; these measurements use the current N2-A harness.

## Event retention

The initial 16-ordinary-event policy produced a mature two-player checkpoint of
11,680 bytes (13,247 bytes maximum over the measured interval), exceeding the
8,000-byte target. The owner chose a smaller recent window. Two ordinary events
still reached 8,019 bytes, so the final policy keeps one ordinary event.

Result retention is independent of that window. The latest `roundEnd` is retained
when the Match has ended its current round; the latest `setEnd` is retained when
that same Match is complete. Both must match `match.round`. This includes a paused
round-result countdown. Old round results are excluded after `nextRound()`, even
if they would have fallen inside the recent window. Rematch preparation already
resets the event history and Match ID. Selection preserves sequence order and
includes each event at most once.

Only the outgoing subset changes. `collect()` still maintains the original
256-event room history, expiry still filters superseded aborted-set events, and
MatchRecorder keeps its full operation journal and result summary.

## Reproducing the measurements

Run these sequentially without other tests or benchmarks running:

```sh
bun packages/server/test/checkpoints.bench.ts --legacy > /tmp/n2b-before.json
bun packages/server/test/checkpoints.bench.ts > /tmp/n2b-after.json
```

`--legacy` uses a test-only copy of the checkpoint path at the starting commit.
An actual pre-edit run was also collected; its deterministic payload sizes,
traffic totals, event counts and input counts match the reproduced baseline.
The helper changes only checkpoint construction and broadcasting. A regression
compares legacy and optimized authoritative states, client commands, complete
sealed replay objects and byte-identical journal JSON through reconnect, round
transition and forfeit, then decodes and verifies the original artifact again.

The benchmark uses real Rooms, Match, MatchRecorder and browser Sessions through
N2-A's NetHarness, with seed 42, 20 ms each way, no jitter or bandwidth cap,
10 ms server ticks, 50 ms snapshots and 60 Hz browser frames. Each seat runs the
existing 625 ms bot cycle, including sub-34 ms input bursts. Script seeds are
`200 + seatIndex + chunkIndex * 101`, scheduled in five-second chunks. A first-to-100
set lets ordinary rounds continue until history matures without replacing Match
state or injecting boards. Diagnostics are enabled and inspection histories are
disabled in both runs.

Warmup ends after at least 320 generated events, in the playing phase: 118,220 ms
of fake time for two players and 33,220 ms for eight. The following 30 seconds are
measured. At the end, the two-player run has generated 419 events and the
eight-player run 660; both retain exactly 256 internally. Every run seals and
verifies its recorder prefix against the authoritative state.

Sizes are UTF-8 bytes of actual serialized checkpoint envelopes. Downstream uses
the harness's delivered application-byte counters, including periodic checkpoints,
input acknowledgement checkpoints, room updates and pongs. It excludes upstream,
WebSocket/TCP framing, TLS and native heartbeat packets. KB means 1,000 bytes.

For CPU, the script times server `tick`, `receive` and `snapshots` calls, with
nested timings for Match advancement, `saveState()` and checkpoint JSON
serialization. Receive includes admission and single-seat acknowledgement work.
Nested timings must not be added to their enclosing totals. Timings are elapsed
in-process work, including instrumentation, allocation and possible GC, rather
than isolated hardware CPU counters. These timed server roots include work done
synchronously by `Peer.send`, including serialization, UTF-8 byte accounting and
NetHarness transport queueing and scheduling. They are not isolated from this
in-process transport work and do not include actual socket, TCP or TLS work.
`harnessWallMs` covers driving the full deterministic harness, including client
work and fake-time progression.

A separate microbenchmark repeatedly broadcasts one unchanged mature state to
room seats whose `send` is replaced with a JSON-only function. It measures
snapshot construction, acknowledgement assembly and per-recipient serialization.
Unlike the moving-workload server roots, it excludes normal `Peer.send` byte
accounting and NetHarness transport queueing and scheduling, as well as simulation,
input admission, client work, socket I/O and TLS. One 500-broadcast warmup is
discarded, followed by seven 500-broadcast samples. Reported work per simulated
second is median time per broadcast multiplied by the unchanged 20 Hz cadence.
This is a measured fixed-state microbenchmark; it does not predict hosting
throughput.

## Results

Bun 1.4.2 on an AMD Ryzen 3 PRO 3300U, sequential runs on the same machine:

| Measurement | Before | After | Target |
|---|---:|---:|---:|
| 2p mature checkpoint, bytes | 89,663 | 6,481 | <8,000 |
| 2p checkpoint p50 / p95 / max, bytes | 89,975 / 90,498 / 91,271 | 6,527 / 7,229 / 7,617 | <8,000 |
| 8p mature checkpoint, bytes | 104,991 | 19,840 | <30,000 |
| 8p checkpoint p50 / p95 / max, bytes | 104,308 / 107,665 / 108,778 | 20,236 / 22,268 / 23,303 | <30,000 |
| 2p downstream per client, KB/s | 2,224.76–2,225.27 | 164.34–164.85 | ≤150; missed |
| 8p downstream per client, KB/s | 2,458.24–2,611.24 | 483.55–511.73 | ≤600 |
| 8p fixed-state broadcast work, ms/s | 206.19 | 37.94 | ≥4× reduction; 5.43× achieved |
| 8p snapshots per broadcast | 8 | 1 | 1 |

The seven 8p broadcast samples ranged from 200.76–219.78 ms/s before and
35.89–47.31 ms/s after. The 2p broadcast median was 28.81 → 6.63 ms/s.
These figures include snapshot construction and per-seat serialization. They
exclude single-seat input acknowledgements, which still save their own snapshots.

The eight-player moving-workload timings distinguish that remaining cost:

| In-process measured work, ms per simulated second | Before | After |
|---|---:|---:|
| All server roots combined | 306.44 | 89.07 |
| Periodic snapshots, including sends | 244.25 | 44.30 |
| Receive: admission and acknowledgements, including sends | 57.98 | 41.89 |
| Tick: simulation, recorder, event collection and lifecycle | 4.20 | 2.88 |
| Within those roots: Match advancement | 1.37 | 1.11 |
| Within those roots: `saveState()` | 182.69 | 49.45 |
| Within those roots: checkpoint `JSON.stringify` | 98.86 | 26.08 |

Overall server work improved 3.44×, while the periodic snapshot root improved
5.51×. The fixed-state broadcast benchmark improved 5.43×. This does not establish
a 4× reduction for all server work or an absolute ≤15 ms/s result on this machine.
The research's 52–55 ms/s reference was on different hardware and an earlier
workload, so its absolute number is not used as a direct comparator.

Both versions sent 1,484 checkpoints across the two-player room and 5,876 across
the eight-player room in the measured interval. Transmitted input-item counts were
`[140,140]` and `[128,148,144,140,128,132,104,136]`, respectively, with zero
diagnostic rejections in either run. Equal transmitted counts support workload
comparability but do not directly establish equal server admission counts.
Snapshot calls over the moving eight-player workload fell from 5,876 to 1,662;
single-seat acknowledgements account for the remaining calls beyond shared
broadcasts. All four recorder prefixes verified.

The two-player downstream target remains unmet. An additional transport-only
experiment removed every ordinary event while preserving relevant results and
all Match fields. It still delivered 156.75–157.26 KB/s per client under the same
script and cadence. That experiment was not applied to production. It demonstrates
that reducing the event window alone cannot satisfy 150 KB/s for this workload.
The initial 16-event policy delivered 289.43–289.94 KB/s for two players and up to
630.34 KB/s for eight; the smaller window materially improves both.

To reproduce the results-only diagnostic, prefix the benchmark import with a
test-only wrapper (do not use `--legacy`):

```sh
bun -e 'import { Rooms } from "./packages/server/src/rooms";
const build = Reflect.get(Rooms.prototype, "sharedCheckpoint");
Reflect.set(Rooms.prototype, "sharedCheckpoint", function(room) {
  const cp = build.call(this, room);
  cp.events = cp.events.filter(e => e.event.type === "roundEnd" || e.event.type === "setEnd");
  return cp;
});
await import("./packages/server/test/checkpoints.bench.ts");'
```

## Validation

| Command | Result |
|---|---|
| Pre-change `bun test packages` | 756 pass, 0 fail, 58 files |
| Final `bun test packages` | 775 pass, 0 fail, 59 files, 30,850 assertions |
| Focused command below | 356 pass, 0 fail, 14 files, 2,714 assertions |
| `bun run check` | Pass |
| `bun run build` | Pass |
| `git diff --check` | Pass |

```sh
bun test packages/server packages/web/netplay-latency.test.ts packages/web/netplay-harness.test.ts packages/web/session-diagnostics.test.ts packages/web/online-view.test.ts packages/replay
```

The full suite covers N1-A, N1-B, N2-0, N2-A, actual Elysia WebSockets and existing
replay decoding/verification fixtures. No simulation or replay version changed.
Correctness checks pass. Performance acceptance is **NEEDS FURTHER WORK** because
two-player downstream remains above 150 KB/s.

## Review notes

The browser's only checkpoint-event consumer is the result lookup in
`online-view.ts`; reconciliation and board rendering use Match state and owner
acknowledgements. Mounted client regressions check round, first-to, forfeit and
aborted text after more than 16 subsequent real events, then check next-round and
rematch clearing. Result-age tests use valid recorder releases because user
releases after set completion deliberately do not generate events.

Eight-seat tests use distinct pending counts, rejection sequences, generations
and board epochs. They assert one `saveState()` call, common shared objects,
separate owner objects, consecutive server sequences and unchanged snapshots after
later releases and ticks. Waiting rooms, disconnected rooms, single-seat resync,
release, reconnect, rematches, internal history and replay verification are covered.

Review caught the reconnect harness's exact historical 69,673-byte backlog fixture:
pruning correctly changes its size to 68,139 bytes. The test now runs both the
original legacy fixture and the optimized fixture, preserving exact byte assertions,
queue clearing, reconnect timing, identity and replay checks for both.

N2-B3 input-checkpoint coalescing remains deferred. No frequency change was used to
improve the numbers. Fake time and FIFO payload queues cannot reproduce TCP
congestion, TLS, proxies, kernel buffering or hosting-provider throttling.
