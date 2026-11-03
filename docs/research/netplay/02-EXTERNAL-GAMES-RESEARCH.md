# 02 — External games: Techmino/Techrater, TETR.IO, ZBB

> Investigation date 2026-11-03. Evidence labels, used strictly:
> **[source]** read in public source code at the pinned commit · **[official]** statement by the
> developer (patch notes, blog) · **[community]** third-party wiki, issues or tools ·
> **[anecdotal]** a private conversation relayed by the 42tris owner · **[inference]** my own
> reasoning. I did not run Techmino or connect to any game server.

Pinned sources:

* Techmino client: <https://github.com/26F-Studio/Techmino> at
  `48eb47e7e8fbc662bf4e5a5817fda4f2a322fd30` (2026-10-28). Permalinks below use it as `TM`.
* Techrater backend: <https://github.com/26F-Studio/Techrater> at
  `aebb2882114097fefdb0bb35dfdc32318c6fae00` (2024-08-07). Permalinks use it as `TR`.

`TM` = `https://github.com/26F-Studio/Techmino/blob/48eb47e7e8fbc662bf4e5a5817fda4f2a322fd30`
`TR` = `https://github.com/26F-Studio/Techrater/blob/aebb2882114097fefdb0bb35dfdc32318c6fae00`

Related: [04 architecture options](04-ARCHITECTURE-OPTIONS.md) (Architecture D is the Techmino baseline).

---

## 1. Techmino + Techrater

### 1.1 Verified architecture [source]

**Room and seed.** The server picks a random seed per match and broadcasts it in
`MatchStart` (`TR/structures/Room.cc`, `matchTryEnd` re-seeds at
[`Room.cc#L275-L301`](https://github.com/26F-Studio/Techrater/blob/aebb2882114097fefdb0bb35dfdc32318c6fae00/structures/Room.cc#L275-L301)).
Each client creates its own local player and one *remote* player object per other gamer. The
order is shuffled from the seed
([`parts/modes/netBattle.lua#L14-L46`](https://github.com/26F-Studio/Techmino/blob/48eb47e7e8fbc662bf4e5a5817fda4f2a322fd30/parts/modes/netBattle.lua#L14-L46),
`PLY.newRemotePlayer` [`parts/player/init.lua#L456-L471`](https://github.com/26F-Studio/Techmino/blob/48eb47e7e8fbc662bf4e5a5817fda4f2a322fd30/parts/player/init.lua#L456-L471)).

**Local simulation.** Every client simulates its own board at its own frame rate:
`Player:update` adds `dt·60` to `trigFrame` and runs whole frames
([`player.lua#L2966-L3022`](https://github.com/26F-Studio/Techmino/blob/48eb47e7e8fbc662bf4e5a5817fda4f2a322fd30/parts/player/player.lua#L2966-L3022)).
Nothing waits for the server. I found no cap on `dt` in the net-game path (whether
Zframework or LÖVE caps it elsewhere is **not verified**). If uncapped, a local stall would be
caught up as a burst of frames.

**Recording.** `pressKey`/`releaseKey` append `(frameRun, key)` / `(frameRun, 32+key)` to
`GAME.rep`
([`player.lua#L564-L597`](https://github.com/26F-Studio/Techmino/blob/48eb47e7e8fbc662bf4e5a5817fda4f2a322fd30/parts/player/player.lua#L564-L597)).
Extra events append `(frameRun of the local human, 64+eventID, sourceSid, params…)`
([`Player:extraEvent` #L745-L778](https://github.com/26F-Studio/Techmino/blob/48eb47e7e8fbc662bf4e5a5817fda4f2a322fd30/parts/player/player.lua#L745-L778)).
The only default extra event is `attack` with 5 parameters
([`gameEnv0.lua#L67-L74`](https://github.com/26F-Studio/Techmino/blob/48eb47e7e8fbc662bf4e5a5817fda4f2a322fd30/parts/player/gameEnv0.lua#L67-L74)).

**Upload.** When more than 8 frames have passed since the last upload (≈150 ms at 60 fps),
the client encodes the new part of `GAME.rep` with `DATA.dumpRecording`. If there were no new
events it first adds a `(frameRun, 0)` "just wait" heartbeat. It then sends the chunk as
base64 (`NET.player_stream`)
([`net_game.lua#L264-L279`](https://github.com/26F-Studio/Techmino/blob/48eb47e7e8fbc662bf4e5a5817fda4f2a322fd30/parts/scenes/net_game.lua#L264-L279),
[`data.lua#L265-L288`](https://github.com/26F-Studio/Techmino/blob/48eb47e7e8fbc662bf4e5a5817fda4f2a322fd30/parts/data.lua#L265-L288)).

**Server stream handler.** `PlayerStream::filter` requires that the sender is in a room, is a
`Gamer` and is `Playing`, and that the payload is a string. `process` appends the string to the
player's history and publishes it to the room, excluding the sender
([`PlayerStream.cc#L22-L46`](https://github.com/26F-Studio/Techrater/blob/aebb2882114097fefdb0bb35dfdc32318c6fae00/strategies/PlayerStream.cc#L22-L46)).
**There is no decoding, simulation or validation of the stream content.** `Player::appendHistory`
concatenates strings
([`Player.cc#L61-L69`](https://github.com/26F-Studio/Techrater/blob/aebb2882114097fefdb0bb35dfdc32318c6fae00/structures/Player.cc#L61-L69)).
History is cleared at match end (`Room.cc` `matchTryEnd`).

**Remote reconstruction.** `NET.pumpStream` decodes the chunk and appends it to the remote
player's `stream`
([`net.lua#L290-L303`](https://github.com/26F-Studio/Techmino/blob/48eb47e7e8fbc662bf4e5a5817fda4f2a322fd30/parts/net.lua#L290-L303)).
`update_streaming` applies every event whose timestamp equals the remote's current
`frameRun` ([`player.lua#L2890-L2923`](https://github.com/26F-Studio/Techmino/blob/48eb47e7e8fbc662bf4e5a5817fda4f2a322fd30/parts/player/player.lua#L2890-L2923)).

**How remote boards progress without new data.** In `Player:update`, a remote advances a frame
only `if dataDelta > 0`, where `dataDelta = #stream − streamProgress` (unconsumed array
entries). With no unconsumed data, **the remote board does not advance at all**
([`player.lua#L2975-L3014`](https://github.com/26F-Studio/Techmino/blob/48eb47e7e8fbc662bf4e5a5817fda4f2a322fd30/parts/player/player.lua#L2975-L3014)).

**Adaptive catch-up.** Per local frame a remote runs 1, 2, 3, 5, 7, 10 or 20 simulation steps.
The thresholds are backlogs of 26, 42, 62, 70.23, 94.2 and 126 *array entries* (not frames). A
player who reported finishing gets a separate, much faster schedule (up to 2600 steps) driven
by `loseTimer = 26` (`NET.wsCallBack.player_finish`,
[`net.lua#L545-L553`](https://github.com/26F-Studio/Techmino/blob/48eb47e7e8fbc662bf4e5a5817fda4f2a322fd30/parts/net.lua#L545-L553)).
**[inference]** Because uploads arrive in ~150 ms chunks and a remote stops at the end of its
data, a remote board probably alternates between running at 1× and briefly waiting, unless a
backlog builds up. In that case it fast-forwards. This is the price of never extrapolating.

**Attacks: recorded, transported, applied.** This is the subtle part.

1. A board that clears lines calls `self:attack(target, send, sendTime, line)`
   ([`player.lua#L2136`, `#L2149`](https://github.com/26F-Studio/Techmino/blob/48eb47e7e8fbc662bf4e5a5817fda4f2a322fd30/parts/player/player.lua#L2130-L2150)).
   This happens **on every client that simulates that board**, including clients that are
   re-simulating a *remote* attacker from its input stream.
2. `attack` → `extraEvent('attack', targetSid, send, time, line, seenCount)`. That runs the
   handler for every **non-remote** player on *this* client, which is the local human
   ([`#L911-L928`](https://github.com/26F-Studio/Techmino/blob/48eb47e7e8fbc662bf4e5a5817fda4f2a322fd30/parts/player/player.lua#L911-L928)).
3. `beAttacked` returns unless this local player is the target. If it is, it cancels in-transit
   crossing attacks and calls `receive`, which queues the garbage with its own countdown
   ([`#L929-L979`](https://github.com/26F-Studio/Techmino/blob/48eb47e7e8fbc662bf4e5a5817fda4f2a322fd30/parts/player/player.lua#L929-L979)).
4. Because `extraEvent` appends to the **local** `GAME.rep` using the local human's
   `frameRun`, the **recipient records the receipt in its own stream** at its own local
   frame. Other clients re-simulating the recipient apply the garbage at exactly that frame.
   Here `update_streaming` calls the handler with the stream's owner as `P` and the source as
   `SRC`.
5. The attacker's own stream also contains an `attack` record (source = attacker). Replaying
   it on other clients is a no-op (`beAttacked` returns when `self == source`).

**[inference]** So in Techmino **no client trusts another client's attack claim**. Each
recipient *derives* the attack by re-simulating the attacker's inputs. Then it alone decides,
by recording it, *when* the garbage entered its own board. The order of events is
authoritative **per board, as written by that board's owner**. There is no global order.

**In-transit (crossing) cancellation.** Added in commit `fb95cb9` (2024-11-20, "实现屏蔽
passthrough", co-authored by Electra). Each attacker keeps a per-target list of its sent
attacks plus a counter of the target's attacks it has *seen*. It sends that counter with each
attack. A recipient cancels the incoming amount against its own attacks to that sender with
index > `seenCount`. Those are the attacks the sender had not yet seen, so they crossed in
flight ([`#L911-L951`](https://github.com/26F-Studio/Techmino/blob/48eb47e7e8fbc662bf4e5a5817fda4f2a322fd30/parts/player/player.lua#L911-L951)).
The rule is deterministic from the streams, so every client computes the same cancellation.

**Late garbage fairness [inference].** A recipient learns of an attack only when its client
simulates the attacker's lock. That is the attacker's real lock time plus up to ~150 ms of
upload batching, plus attacker→server→recipient latency, plus any playback backlog. The
garbage countdown then starts at the recipient's receipt frame. **Latency favours the
defender.** Two players see different interleavings of the same events. Nobody's board
history is contradicted, but "who attacked first" is perspective-dependent.

**Visual desynchronisation [inference].** Each board's *content* is consistent across clients,
because it is deterministic replay of one owner-authored stream. Each viewer sees remote boards
at a different lag. Remote boards freeze when data stops and fast-forward when data arrives.
If the simulation is ever non-deterministic across platforms, the boards will silently diverge.
I found no hash or state check in the inspected code.

**Spectators and reconnects.** On joining a room that is `Playing`, the room info includes each
player's accumulated `history` (`Player::info`,
[`Player.cc#L85-L92`](https://github.com/26F-Studio/Techrater/blob/aebb2882114097fefdb0bb35dfdc32318c6fae00/structures/Player.cc#L85-L92)).
The client stores it and pumps it once the game scene starts
([`net.lua#L483-L490`](https://github.com/26F-Studio/Techmino/blob/48eb47e7e8fbc662bf4e5a5817fda4f2a322fd30/parts/net.lua#L483-L490),
[`net_game.lua` storedStream](https://github.com/26F-Studio/Techmino/blob/48eb47e7e8fbc662bf4e5a5817fda4f2a322fd30/parts/scenes/net_game.lua#L303-L308)).
Spectators reconstruct every board from the start and catch up with the acceleration above.
Bandwidth for this is small, because it is only inputs.

**Results.** `PlayerFinish` marks the sender finished, broadcasts its arbitrary JSON `data`,
and ends the match when ≤1 player (or group) remains
([`PlayerFinish.cc#L22-L47`](https://github.com/26F-Studio/Techrater/blob/aebb2882114097fefdb0bb35dfdc32318c6fae00/strategies/PlayerFinish.cc#L22-L47)).
**Placement is client-reported.**

### 1.2 Anti-cheat guarantees

| Threat | Techmino (public source) |
|---|---|
| Fabricated attacks | **Prevented by construction [source]**: recipients derive attacks from the attacker's inputs. |
| Invalid moves / impossible pieces | Each client's re-simulation would just apply the inputs under the rules. An impossible input does nothing. Not a threat. |
| Bots, macros, superhuman input | **Not prevented [source]**: no server or client check. |
| Faster-than-real-time timeline | **Not prevented [inference]**: `frameRun` is the client's own counter. Receivers will catch up at up to 20×. I found no wall-clock check on client or server. |
| Delaying or omitting garbage receipt | **Not prevented [inference]**: the recipient's client alone records receipt. A modified client can apply garbage late or never, and every viewer's replica of that board will agree with the cheat. Nobody cross-checks receipts against simulated sends. |
| Rewriting history | Server appends only. Clients append only. A client could send different content than it simulates locally, but every other client sees the same relayed bytes. |
| Different streams to different opponents | **Prevented [source]**: one upload is published to the whole room. |
| Fake finish / placement | **Not prevented [source]**: `PlayerFinish` is accepted as reported. |
| Stream legality check | **Not implemented [source]**: `P.netAtk` is commented as "will be compared with P.stat.send for checking stream legal or not" ([`init.lua#L466`](https://github.com/26F-Studio/Techmino/blob/48eb47e7e8fbc662bf4e5a5817fda4f2a322fd30/parts/player/init.lua#L466)), but nothing in the client source reads it. |

**Deployed vs public.** Techrater's public repo was last updated 2024-08-07. The live server may
differ, and I cannot tell. Other backend handlers (`PlayerState`, `PlayerConfig`, `RoomDataUpdate`,
…) were listed. Only `PlayerStream` and `PlayerFinish` touch gameplay data, and neither
validates it.

### 1.3 Lessons for 42tris

1. **Input-stream replication + deterministic engine ⇒ tiny bandwidth and smooth, exact
   remote boards** (buffered playback with catch-up). 42tris already has the deterministic
   engine and the input journal (`MatchRecorder`). It currently sends **full states** instead
   (see [03 §4](03-LATENCY-AND-FAILURE-ANALYSIS.md#4-bandwidth-and-queueing-the-oversized-checkpoint-finding)).
2. **Per-board authoritative event order** (the recipient records receipt) makes
   independent-timeline replays deterministic without a global clock. That is the template for
   any 42tris Architecture B/C replay kind.
3. **Seen-count crossing cancellation** is a clean deterministic rule when there is no shared
   frame. 42tris would only need it if it abandoned the shared timeline.
4. **A relay is not an authority.** Techmino's server provides room coordination and
   history, not anti-cheat. Copying its model would give up 42tris's strongest property.
5. Remote boards freeze on missing data. Catch-up turns jitter into visible fast-forward.
   "Smooth" requires a deliberate playout buffer.

**Applicability.** The transport and replication ideas transfer. The trust model does not.

---

## 2. TETR.IO

### 2.1 What is publicly established

All quotes are from the in-game patch notes at <https://tetr.io/about/patchnotes/> (rendered
2026-11-03) unless noted. Short phrases only.

| Date / version | Statement | Label |
|---|---|---|
| ALPHA 4.2.0, 2020-07-30 | Networking rewritten; "a custom networking system I call Ribbon"; load balancing "handled by Casket"; Ribbon "will attempt to repair broken connections"; disconnects after 5 reconnects without a minute to cool down | [official] |
| ALPHA 6.3.0, 2022-07-20 | "a global network of servers for multiplayer connections"; the game connects to "a server close to you"; "the game servers themselves are still in France" | [official] |
| osk blog, 2025-07-30 ([post](https://blog.osk.sh/post.php?p=688966e719b753.49360626)) | Describes a "spool server" as a regional WebSocket proxy, with per-spool player counts | [official] |
| ALPHA 6.1.0, 2021-09-28 | Passthrough toggle; "network delay/lag/high ping may still cause minor amounts of passthrough"; "Reduce latency in 1v1 games and increase it in large lobbies" for server performance | [official] |
| ALPHA 6.3.1, 2022-10-23 | "Improved attack latency (will help against lag-based passthrough!)" | [official] |
| ALPHA 6.3.3, 2023-04-12 | ZERO passthrough: attacks sent at the same time "before the clients notice the others' attacks" cancel | [official] |
| ALPHA 6.3.4, 2023-05-14 | Zero-Passthrough default in all modes | [official] |
| ALPHA 2.4.2, 2020-04-29 | Fixed the "'X discrepancies' error" appearing when a player's internet lags behind in League | [official] |
| ALPHA 1.0.0-rc0, 2020-03-15 | A replay upload can be rejected "because it cannot be verified" | [official] |
| Multiple 2020–2021 versions | "Anti-cheat improvements"; replay time limit 30 min | [official] |
| osk blog, 2022-05-17 ([post](https://blog.osk.sh/post.php?p=62841a37b50519.59122575)) | Anti-cheat flagged "inconsistent replay timings"; staff avoid decisions "based on anti-cheat data alone" | [official] |
| tetrio/issues #888, 2022 ([issue](https://github.com/tetrio/issues/issues/888)) | Users report clients submitting replays ("clientside sent replays") and League softlocks when submission failed | [community] |
| `ribbon-api` npm package | Third-party wrapper describing Ribbon as msgpacked, resumable WebSockets | [community] |

42tris's garbage profile constants (20-frame delay, cap 8, opener rule) were derived earlier
from TETR.IO's client source. See `packages/match/RULES.md` "Evidence and compatibility gaps".
That derivation is not re-verified here.

### 2.2 What is **not** publicly established

Whether the server re-simulates multiplayer games authoritatively. Whether clients run
independent timelines or lockstep. Whether any rollback exists. How validation decides
"discrepancies". How attacks are timed against opponents' boards. Ribbon message formats
beyond community wrappers. **None of this should be presented as fact.**

### 2.3 Inferences (clearly labelled)

* **[inference]** "Attacks sent at the same time (during lag, before the clients notice…)"
  implies that attack interactions are subject to per-client network timing. That fits clients
  advancing their own boards and exchanging attacks over the network, more than one committed
  server timeline like 42tris's. It does not tell us whether the server *also* verifies.
* **[inference]** "X discrepancies … when your internet is lagging behind" suggests a
  client/server consistency check in League that early versions applied too strictly under
  lag. This echoes the ZBB anecdote below.
* **[inference]** Spools reduce last-mile instability and connection setup cost, but the game
  servers stayed in France (as of 2022). Regional proxies therefore do not remove the
  long-haul RTT to the authority. TETR.IO's own wording says as much.

### 2.4 Lessons for 42tris

1. Even a large, well-funded game kept **one central game region** and accepted that far-away
   players get higher ping. The cheap 42tris equivalent is **one well-placed European server**
   plus a protocol that tolerates long one-way delays (lead), not regional infrastructure.
2. Crossing/zero-passthrough rules exist because interactions cross network delay. In 42tris's
   shared timeline, crossing is resolved per frame on the server, so this is not needed today.
3. Anti-cheat in practice combines deterministic replay checks, timing heuristics and human
   review. 42tris should not expect architecture alone to stop bots.

**Applicability.** Mostly strategic: centralise the authority, tolerate latency, and keep the
anti-cheat expectations realistic. Nothing here justifies copying unknown internals.

---

## 3. ZBB — Zhun's Block Battle

### 3.1 Public evidence

* Site: <https://blockbattle.zhunsoft.com/>. The page is a browser game titled "Zhun's Block
  Battle". The only text extracted was a prompt to enlarge the window **[source: page fetch
  2026-11-03]**.
* Web searches (2026-11-03) found **no public source repository, technical write-up or
  developer post** about ZBB networking.

### 3.2 Contributor account [anecdotal]

An owner-relayed contributor account described client streams containing inputs and garbage
amounts, with board state possibly sent for desynchronisation recovery. It also described an
earlier server validator treating very delayed data as invalid and rolling boards back; these
behaviours reportedly caused problems, and the rollback was later removed. The source identity
and exact wording are omitted.

**What this does and does not establish.** It suggests that (a) ZBB sends inputs plus
garbage amounts, possibly with full board state for desync repair; (b) an earlier server
validator treated *very late* data as *invalid*; (c) rolling back to the last valid state was
harmful and was removed. It does **not** establish that ZBB has no server validation now, that
it trusts clients, how resync works, whether it is cheat-resistant, or whether desyncs are gone.

### 3.3 Delayed vs. invalid: the engineering distinction

* **Legality** ("could this input sequence produce this board from this seed?") does not
  depend on time. A validator can check it whenever the data arrives, seconds late included.
* **Timing claims** ("this happened at time t") can only be *bounded*, never proven. The
  server sees arrival times, not press times. A delayed honest event and a deliberately
  withheld one look the same up to the allowed bound.
* **[inference about ZBB]** The old validator seems to have used a timing bound as a legality
  test. Once delays exceeded the bound, honest play was "impossible", and the remedy (roll
  back) was worse than the risk.
* **Design rule for 42tris:** keep legality checking (deterministic re-simulation) separate
  from timing policy. Give timing violations explicit, bounded, *non-retroactive* outcomes:
  reject with notice, suspend, forfeit after N seconds. Never let them silently rewrite
  accepted history.

### 3.4 Why rolling a falling-block board back is so disruptive [inference, grounded in 42tris mechanics]

1. **Discrete and cumulative.** Each lock permanently changes the board, the bag position,
   hold and B2B/combo state. Rolling back 1 s at 2 PPS erases two placements the player has
   already seen and planned around. Shooter rollback corrects continuous positions by
   milliseconds. This erases decisions.
2. **Input reinterpretation.** Inputs after the rollback point were aimed at pieces and
   positions that no longer exist. Replaying them against the restored state can apply
   rotations or drops to the wrong piece (cf. the wrong-piece hazard in
   [01 §3.9](01-CURRENT-42TRIS-ARCHITECTURE.md#39-per-input-type-behaviour)).
3. **Cross-player cascade.** Attacks generated by the erased placements must be withdrawn from
   opponents. That changes *their* boards too, and it is visible to everyone.
4. **Perception.** Players read the stack constantly. A snap-back is far more noticeable than
   a ~100 ms timing difference.

42tris today never rolls back **committed** server state. It only replaces the owner's
*speculative* prediction, at most ~commitDelay + D (+ in-flight) ms of it. A reset still
discards in-flight inputs and so behaves like a small rollback. Any future design must keep
recovery **local, small and non-retroactive**.

### 3.5 Applicability

High as a cautionary tale about timing-based validation and rollback. Low as a protocol
template, because almost nothing is known.

---

## 4. Cross-cutting comparison

| Property | 42tris (today) | Techmino (source) | TETR.IO (public) | ZBB (anecdotal) |
|---|---|---|---|---|
| Who simulates boards | Server (authoritative) + owner prediction | Every client simulates every board | Unknown (clients certainly simulate own board) | Clients; server once validated |
| Shared timeline | Yes (server frames) | No (per-board frame counters) | Unknown | Formerly clock-synced; now unclear |
| What crosses the network | Inputs ↑, full states ↓ | Input/event streams both ways (relayed) | Unknown (Ribbon, msgpack per community) | Inputs + garbage amounts (+ board on desync) |
| Attack authority | Server Match | Derived by each recipient from attacker inputs | Unknown | Unknown |
| Anti-cheat | Strong legality + ~100 ms backdating bound | Weak (none in relay) | Heuristics + review + replay verification | Unknown |
| Behaviour at high RTT | Cliff (input rejection) | Graceful (local), opponents lag | Playable with higher ping (official) | Struggled with 6 s delays |
| Server cost | Simulation cheap; **checkpoints expensive** | Very low | High (global infra) | Unknown |
