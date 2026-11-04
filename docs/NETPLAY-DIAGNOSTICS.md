# Multiplayer latency diagnostics (N2-A)

Instrumentation measures networking behavior without changing gameplay. A separate
experimental fixed input lead is available only with explicit URL authorization,
as described below. Lead remains zero by default.

## Capture a browser snapshot

Open the game with `?diagnostics` (or `&diagnostics` on an invitation URL), then
play multiplayer. In DevTools Console run:

```js
__42trisNetDiagnostics.snapshot()
// Chrome DevTools also supports copying JSON directly:
copy(JSON.stringify(__42trisNetDiagnostics.snapshot()))
```

Diagnostics are off by default. For persistent local opt-in, set
`localStorage["42tris.diagnostics"] = "1"` and reload. To disable, remove that key,
remove the query parameter, and reload. No snapshot is uploaded automatically.
The global exists only when diagnostics are enabled.

## Experimental fixed input lead (N3-B)

For controlled experiments against a server with **N3-A deployed**, use
`?diagnostics&lead=104` (or append `&diagnostics&lead=104` to an invitation URL).
Pushing N3-A to GitHub does not establish deployment compatibility. The protocol
does not negotiate this capability. Do not enable lead for ordinary competitive play.

Only the presence of `diagnostics` in the URL authorizes nonzero lead. Enabling
diagnostics through localStorage alone does not. Omitted lead and explicit `lead=0`
retain production timing. Values must be decimal digits with an optional fractional
part, finite, and between 0 and the shared `MAX_INPUT_LEAD_MS` (250 ms), inclusive.
Empty, negative, nonfinite, malformed and out-of-range values become zero; exponent,
hexadecimal and whitespace forms are rejected. For duplicate `lead` parameters,
the first value wins. `diagnostics=false` still enables diagnostics, matching the
existing presence-based URL option.

The URL is read once at page load. Reload to request a different value. Session
captures that normalized value at construction and latches it before the first
prediction for each `(room.code, matchId, state.round)`. Generation, practice epoch,
releases, stale recovery, checkpoint expiry and same-round reconnects do not change
it. A new room, match or round initializes its own latch with the same page option.
Leaving a room or expiring its session clears the applied value until a new round
checkpoint arrives.

Lead advances prospective input stamps and owner prediction only while the room
is playing and its simulation clock is unfrozen. It adds nothing in preparation,
countdown, pause or results. Monotonic prediction can retain time already rendered
ahead when a pause arrives; repeated paused checkpoints add no further lead.
Existing transmitted inputs and surviving one-shots keep their timestamps.

Inspect `lead.requestedMs`, `lead.appliedMs` and `clock.calibrated` alongside the
existing RTT and clock samples. Welcome-only clock estimates can still produce late
inputs before the first pong, even with lead. Lead is fixed, not an adaptive policy.
Incoming attacks can cause more prediction corrections, and one-shot actions have
no piece guard. See [the measurements and review](NETPLAY-FIXED-LEAD.md).

For a host comparison, capture each player's snapshot after three rounds or about
three minutes, with the same handling settings, player count, and play pattern.
Record the host, approximate player region, and symptoms separately. Compare the
Paris control host with the remote host. Capture again soon after a problem:
recent events occupy a 128-entry ring, and routine checkpoints can evict an event
in a few seconds. Lifetime counters and maximum frame/checkpoint gaps still keep
aggregate evidence. Keep raw captures private when correlating them with a room
or people.

## Fields and scope

Existing fields remain available. Most counters (`inputs`, `rejections`,
`releases`, `staleRecovery`, `corrections`, `frames`, checkpoint counts and maximum
gaps) accumulate for the page's diagnostic instance, including reconnects.
They are not automatically reset at round boundaries. A page reload starts a
fresh capture. `rtt` summarizes the latest 16 valid pong RTT observations.

| Field | Meaning and limitations |
| --- | --- |
| `checkpoints.ageMs.{last,p50,p95,max}` | Recent estimated ages in milliseconds: `(receivedAt + gameplayEstimatedOffset) - checkpoint.serverNow`. Uses at most 256 accepted checkpoints; cleared on connection changes, leave/session expiry, and checkpoint identity changes (room, match, round, generation or epoch). All four are `null` before a usable sample. Stale sequence numbers are excluded. `max` is the maximum of this recent sample window. |
| `transport.bytesPerSec` | Received WebSocket **application payload** bytes/sec over the last approximately 10 seconds, or the connection's age if younger. Native Eden `socket.ws` events supply the original text/binary payload. Text is counted in UTF-8; character count is not byte count. No checkpoint reserialization. |
| `transport.messagesPerSec` | Messages/sec over that same interval. The fixed 101-bucket window uses 100 ms buckets; its lower edge can include up to 100 ms extra traffic. Treat short windows and bursts accordingly. |
| `transport.maxMessageBytes` | Largest received application payload since the current connection's welcome. Zero before messages. |
| `transport.measurement/windowMs/sampleMs` | Labels the measurement and nominal/actual rate denominator. These are decoded payload sizes, excluding wire overhead: exclude WebSocket framing, compression effects, TCP/IP, TLS, retransmits and control frames. Rates are zero with a zero-length observation interval. |
| `clock.offsetSamples` | Latest 16 implied offsets from **every matched pong**, in milliseconds: `pong.serverNow - (pingSentAt + RTT/2)`. Cleared on connection changes. These are observations; the gameplay clock still uses its existing best-RTT estimate. |
| `clock.driftMsPerMin` | Least-squares slope of these offset observations, in ms/min of client monotonic time. `null` with fewer than three observations or less than one second of time span. Centered arithmetic avoids subtracting large squared timestamps. A positive slope means the observed server offset is increasing. |
| `lead.requestedMs/appliedMs` | Normalized immutable Session request and the value latched for the current room/match/round. Applied is initially zero and clears when leaving or expiring the session. It can remain nonzero during pauses, when the target actively adds zero lead. |
| `clock.estimatedOffsetMs/bestRttMs/calibrated` | Current gameplay offset, best matched pong RTT (null before a pong), and whether the connected Session has calibrated from a pong. Before calibration the offset comes from welcome. Diagnostics without an attached Session report null/null/false. These fields do not change clock synchronization. |
| `control.blockedMs/blockedPct` | Cumulative connected, playing, eligible time during which `Session.canPlay` is false, and its percentage of `control.eligibleMs`. Uses the most recent authoritative owner state; excludes eliminated, withdrawn and competitive top-out players, pre-round/result/pause/disconnected time, and deliberate user releases. Network recovery releases count. Snapshots include an ongoing blocked interval and analytically account for the exact 2-second checkpoint expiry. Server events become observable only when delivered; this is client-observed time, not an omniscient server timeline. |
| `inputs.marginAtSendMs.{p5,p50}` | Latest 256 transmitted input margins, including retransmissions; `null` before sends. Input stamp minus estimated committed boundary. Computed in **round-relative simulation time**, using `cp.clock.simulationNow + max(0, estimatedServerNow - cp.serverNow) - cp.clock.commitDelayMs`. Cleared on connection/identity changes. A throttled, queued input is sampled only when transmitted. |

Percentiles use the nearest rank in the sorted sample (`round((n-1)*p)`). Samples
and event copies in a snapshot are detached from the collector; JSON serialization
contains no credentials or player identities.

### Clock bias and input margins

With stable up/down delays `U` and `D`, the midpoint pong offset has bias
`(U-D)/2`. Even without queueing, checkpoint age then reads approximately
`D + (U-D)/2`, which equals half the RTT, rather than necessarily the physical
downstream delay. Before the first pong, welcome seeds offset as
`welcome.serverNow - receivedAt`; with an unchanged downstream path, ages may
therefore initially read near zero. Clock drift and changes in the path used for
the best RTT also bias the estimate. Negative ages are preserved as evidence;
they are not silently clamped to zero. A paused simulation does not pause the
server's process clock used for age.

Offset slope is an **estimated trend**, not proof of oscillator drift. RTT spikes,
a change in routing or asymmetric queues can move implied offsets even when both
clocks are perfect. Compare the offset series with RTT, age and frame gaps. N2-A
does not adjust clock synchronization based on these measurements.

A low or negative input margin signals proximity to the commitment boundary. It
uses an estimated clock and the last checkpoint, and does not include the input's
remaining upstream transit. The real server admits by **integer frame**, with a
simulation loop cadence; a negative fractional margin does not itself prove a
rejection. Diagnostics never modify input stamps, sequence numbers or decisions.

## Interpret a lag report

| Evidence | Likely class and next investigation |
| --- | --- |
| High, fairly stable RTT; repeated `INPUT_REJECTED` and network recovery releases; small send margins; age near half RTT | Commitment-deadline pressure. Server late counts/histogram distinguish this from future or pending-limit rejections. Current architecture can fail sharply around 160–250 ms RTT depending on throttle wait and jitter. N2-A reports the failure; it does not fix it. |
| RTT maximum/jitter much larger than minimum, intermittent releases and late histogram spikes | Transient path delay or queueing. Correlate with frame gaps to separate local scheduling stalls. |
| Growing age, large messages, sustained payload throughput; pongs slow too, while frame gaps stay small | Probable downstream FIFO queueing. Pongs share the checkpoint stream, so high RTT alone is not proof of distance. Age p95 above about 300 ms warrants investigation, with clock-bias caveats. Compare several snapshots, WS payload cadence and server checkpoint skip counts. |
| Large `frames.maxGapMs`, a corresponding checkpoint gap, followed by `staleRecovery` or a recovery release | Probable browser main-thread stall, background throttling or suspension. Use DevTools Performance to check long tasks/GC. A frame gap is evidence of scheduling interruption, not a measured GC duration. |
| Checkpoint gaps without large frame gaps or connection events; control begins blocking at about 2 s | Path outage, delayed delivery or queueing while the browser continues running. Short outages can reject already-transmitted inputs on recovery. |
| `connection` false/true events and a room pause followed by preparation/countdown | Connection interruption/heartbeat lease loss. One missing connection can pause everyone; compare per-player evidence before attributing every pause to every player's link. Check host WebSocket/proxy idle limits and network changes. |
| Offset trend with stable RTT, age, and frame cadence over repeated samples | Possible clock drift. A 16-pong window cannot establish long-term drift or distinguish all path changes. |
| Corrections without releases or rejections | Prediction reconciliation, possibly incoming garbage. A correction alone is not authoritative divergence. |

The browser's `rejections.total` includes distinct sources of evidence (error
messages and checkpoint rejection acknowledgements), so it is not an exact server
input-rejection count. Use server per-seat counts for admission rates. Event rings
can lose old connection events; absence in the recent ring does not establish that
no earlier interruption occurred.

## Optional server logs

Set `NETPLAY_METRICS=1` for the server process, for example:

```sh
NETPLAY_METRICS=1 bun run start
```

Unset it or use another value and restart to disable. There is no metrics endpoint.
Only the exact value `1` constructs a collector/timer in the application. Each
active room (preparing, countdown, playing, paused or round result) emits one
structured JSON record about every ten seconds. No active-room record is emitted
for waiting or completed sets. Delayed callbacks lengthen `windowMs`; no catch-up
burst is emitted. A 50 ms early-callback allowance avoids skipping a whole reporting
interval due to timer rounding. Stop clears the metrics timer along with the existing timers.

Each record has a process-local anonymous numeric `room`, numeric anonymous seat
labels, `sample`, `windowMs`, per-seat admission counts, a late histogram, and
transmission counts. These numbers are diagnostic labels, not room invitation
codes or stable identities. They cannot directly identify a browser snapshot's
seat; correlate in a controlled private experiment. Removed seats are omitted
from the next report. Counters reset after each report for that room, and inactive rooms discard
interval counters at the same cadence so rematches cannot inherit old traffic. Data for a
set that completes before a report may not be emitted.

`accepted`, `rejectedLate`, `rejectedFuture`, `rejectedPendingFull` and
`rejectedOther` count newly consumed input sequence numbers. Duplicate retries
are excluded. Stale generation/epoch, wrong phase, rate limits and sequence errors
happen before per-item admission and are not included in those counts. With
multiple failing checks, the existing check order classifies late before future
before pending-full. `rejectedOther` identifies the existing submit `RangeError`
path, without changing its handling.

Lateness is `match.frame * FRAME_MS - (input.frame + input.subframe) * FRAME_MS`.
These are both simulation coordinates. The five exact buckets are `[0,10]`,
`(10,25]`, `(25,50]`, `(50,100]`, and `>100` ms; a frame-late input has positive
lateness. For example, 25 ms belongs to the second bucket and 30 ms to the third.

`transmission.checkpointsSent` counts checkpoint payloads offered to the existing
WebSocket `raw.send` call. `checkpointsSkipped` counts the existing ephemeral
backpressure skip (buffered amount greater than 64 KiB). `bytesSent` is UTF-8
serialized payload bytes offered to `raw.send` for room-associated messages,
including room state/pongs/errors; skipped messages add no bytes. The existing
serialization is reused. These counters do not establish successful delivery or
wire traffic, and omit native heartbeat/control frames and framework-generated
validation errors outside the room peer path.

`processCpu` contains `process.cpuUsage()` deltas in microseconds, tagged
`scope: "process"`. **Only the first room line in each sample carries that delta**;
other room lines use `null` and the same `sample`. Never add it once per room or
attribute it to the room carrying it. It includes other rooms and other process
work. Compare `(userUs + systemUs) / (windowMs * 1000)` with allocated CPU and host
monitoring; it cannot measure VM CPU steal, event-loop lag, or per-room CPU cost.

Collector state uses weak room/seat references, five histogram buckets per live
seat, fixed scalar counters and saturation at `Number.MAX_SAFE_INTEGER`. With
metrics off there is no collector, metrics timer, CPU sampling, histogram work,
metrics logging, or additional game-state serialization. Admission still follows
the same checks and authority path.

## Deterministic experiments

`packages/web/netplay-harness.ts` supports 2–8 real Sessions connected to real
Rooms/Match/MatchRecorder instances. Existing `a`/`b` options and aliases remain;
`clients` exposes all players and keys run from `a` to `h`.

```ts
const h = new NetHarness({ seed: 42, diagnostics: true, messageHistory: 16,
  players: [10, 30, 90, 150].map(ms => ({ up: ms, down: ms })) });
h.startMatch();
for (const [i, client] of h.clients.entries()) h.playScript(client.key, 30_000, i + 1);
h.outage("d", 1200);
h.advance(30_000);
const perPlayer = h.clients.map(c => ({ key: c.key, traffic: c.traffic,
  independentlyIntegratedControl: c.control, diagnostics: c.diagnostics?.snapshot() }));
const replay = await h.room!.recorder!.buildIncompleteReplay();
await verifyMatchReplayExecution(replay!);
```

Imports for experiments are `NetHarness` from the harness file and
`verifyMatchReplayExecution` from `@42tris/replay`. The supported recorder prefix
API seals a competitive journal for verification without replacing the live Match.
Practice rooms do not construct recorders. Tests also exercise real round endings.

Profiles independently configure `up`, `down`, symmetric `jitter`, `spikeChance`,
`spikeMs`, `upBytesPerSec`, `downBytesPerSec`, `hiddenBufferBytes`, `backpressure`,
`clockOffsetMs` and `clockDriftPpm`. Set equal up/down values for symmetric delay.
Zero/omitted bandwidth is unlimited. Spikes delay one message and all later
messages behind it, preserving ordered WebSocket delivery. Random streams are
seeded per player so adding delay to one link does not alter another's jitter
stream. A narrow optional Rooms entropy source supplies deterministic IDs, room
codes and Match seeds; production still uses crypto randomness.

`holdUpstream` and `holdDownstream` make one path direction unavailable for a
bounded interval; `outage` applies both holds. Browser frames/timers keep running.
On a bandwidth-limited direction, holds pause unfinished byte service, including
transfers scheduled before the hold. At recovery, service resumes from the exact
remaining payload bytes in FIFO order. Extending a hold never consumes service.
Messages whose byte service already completed wait for delivery; they do not
become unsent bytes again. With unlimited bandwidth, service costs zero time and
the original delivery-hold behavior is retained, including delivery at hold end
without charging propagation delay again.

`stall` suspends only that client's browser frames, timers, input handlers and
incoming delivery callbacks. Network byte service and native heartbeat handling
continue during a browser stall. `script(key, [[relativeMs, input], ...])` sends
explicit deterministic sequences through Session; `playScript` uses 625 ms piece
cycles with held controls, rotations, and 15/25 ms bursts across the real 34 ms
throttle. Scheduled handlers obey browser stalls. `traffic` records independent
application byte/message counts per player. `upMessages`, `inputBatches` and
`inputItems` count all local sends, including retransmissions and sends later
discarded on socket close; `downMessages` counts actual browser deliveries.
`upBytes` counts offered application bytes and `downBytes` counts delivered bytes.
These counters never depend on retained inspection history. `control` integrates
client-observed eligibility/playability between scheduler events independently of
diagnostics. The reference counts all `canPlay` loss, including
direct manual `Session.release()` calls; exclude those deliberately scripted user
release intervals when comparing it with browser network-only blocked time.

Bandwidth is a per-socket, per-direction FIFO byte-service model. Pending payload
bytes, propagation time, and browser-delivery time are separate. `queuedBytes(key,
direction)` reports actual remaining application bytes (possibly fractional during
continuous modeled service). `bufferedBytes(key)` subtracts the configured hidden
buffer allowance from downstream pending bytes when backpressure is enabled.
Elapsed outage time contributes no bytes. Ephemeral checkpoint skipping uses the
existing greater-than-64-KiB threshold on this visible backlog.

Closing a socket discards its unfinished and in-flight application messages,
cancels its service/delivery/heartbeat events, and releases its queued bytes.
Already delivered messages, accounting, authoritative inputs and replay records
are kept. A replacement socket starts with empty queues; path profiles, seeded
jitter streams, directional holds/outages and browser stalls stay on the player
link. Close notifications are separate from application payload queues and obey
path availability. Old callbacks cannot deliver data or reserve service for a
replacement connection.

`backpressure` defaults off for compatibility with the original harness. The
model does not implement TCP congestion control. `heartbeat: true` optionally
models the application's 2 s native ping,
6 s lease and 250 ms sweep separately from browser tasks; its default is off to
retain existing tests. Native ping/pong shares modeled FIFO scheduling but is not
counted as application bytes. Explicit peer closes exercise actual Rooms pause
and reconnect handling. Sessions stop old deliveries from entering a new socket;
serialized messages are copied at send time instead of sharing mutable objects.

The harness deliberately has **no commitment-delay, future-window or prediction-
lead tuning hooks**. It tests today's rules. It uses no real sleeps and no
uncontrolled gameplay randomness. Assertions use simulated time, not machine
runtime. Authoritative recorder journals retain the established recording rules;
inspection limits never truncate journals or queued network payloads.

The `players` API (2–8 profiles) defaults to finite inspection histories:
`messageHistory: 16`, `commandHistory: 256`, and `batchHistory: 128`, per client.
Each accepts zero to retain none or `Infinity` to request complete capture. Limits
trim only decoded received messages and sent-command/input-batch inspection arrays;
they never drop network delivery, Session processing, accounting or replay records.
A queued checkpoint retains one serialized payload until delivery, then inspection
history keeps the decoded message without a second serialized copy.

Omitting `players` retains the legacy `a`/`b` API's complete histories by default,
so existing whole-history assertions cannot silently become tail comparisons.
Tests that need complete histories through the `players` API must opt in:

```ts
new NetHarness({ players: [{}, {}, {}],
  messageHistory: Infinity, commandHistory: Infinity, batchHistory: Infinity });
```

Finite histories bound inspection storage during sustained experiments. Real
pending byte queues can still grow under deliberately undersized/unavailable
links without backpressure; bound experiment duration and inspect `queuedBytes`
when studying that genuine modeled congestion.

## Limits and sharing

The harness cannot reproduce real browser rendering, task-source arbitration,
GC, timer clamping, OS socket buffers, TCP congestion/loss, routing/peering,
TLS, proxies, host shaping, CPU steal or actual Antideploy performance. Its
bandwidth and native heartbeat are models, not evidence about a provider.
Use browser Performance/WS captures and host monitoring to corroborate hypotheses.
Do not compare a harness runtime with production capacity without accounting for
serialization, parsing, socket and browser costs.

Snapshots and metrics records contain counts/timings, anonymous numeric server
labels, and bounded recent diagnostic events. They exclude auth/resume tokens,
names, player IDs, IP addresses, board contents and full input histories. Do not
share raw WS messages, storage dumps, request headers, replay appearance maps or
unredacted screenshots publicly: those can contain credentials, room codes and
player-identifying data. The snapshot is the intended export. Review surrounding
notes and captures before sharing them.


## N3-C adaptive input lead

`?diagnostics&lead=auto` explicitly enables experimental round-boundary adaptation.
LocalStorage diagnostics alone never enables it. Numeric fixed lead keeps its
existing 250 ms limit; automatic lead is limited to 160 ms and a stricter
uncertainty ceiling. Ordinary invitations remove every lead parameter.

The snapshot adds `lead.mode` (`zero`, `fixed`, `adaptive`), nullable
`requestedMs` (null for auto), `proposedNextMs`, `wantedMs`, `ceilingMs`, `reason`
and `capped`. `appliedMs` is the round's latched decision. `adaptive` reports
sample count/age, RTT min/median/nearest-rank p95, effective-transit median/p95,
decrease confirmation and at most 32 anonymous decision events.

`clock.effectiveOffsetMs` is the gameplay offset. Adaptive mode latches it with
lead, while `estimatedOffsetMs` retains the legacy best-pong observation.
`selectedSampleAgeMs` and `selectedSampleRttMs` identify the latched sample;
`quality` describes proposal availability (`unwarmed`, `fresh`, `stale`, `capped`).
The selected sample may age while new pongs continue informing future proposals.
`wantedMs`/`ceilingMs` describe the current proposal; decision history preserves
the boundary's values and cap reason. These observations include server processing
and clock bias; they are not physical one-way latency measurements. With at most
16 samples, nearest-rank p95 is the window maximum, not a population estimate.

Unwarmed or stale starts use zero for the entire round. A route change cannot
change an active adaptive lead or offset, even after input rejection or recovery.
A capped proposal does not mean full compensation. Browser `INPUT_REJECTED`
counts remain general rejections; only server admission metrics distinguish late
from future-bound causes. See [the policy and measured results](NETPLAY-ADAPTIVE-LEAD.md)
for calibration thresholds, route behavior, recovery evidence and fairness limits.
