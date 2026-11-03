# 05 — Protecting the replay investment

> Commits `fe92d94`/`a4a9e8e` (N1-B does not touch replay code), 2026-11-03. This document is self-contained for anyone planning M4
> (persistent and shareable replays) or any netplay change that touches `Match`.

Related: [01 §9](01-CURRENT-42TRIS-ARCHITECTURE.md#9-replay-coupling) · [04 §6.5](04-ARCHITECTURE-OPTIONS.md#65-replay-integrity-per-architecture) ·
[06 roadmap](06-IMPLEMENTATION-ROADMAP.md) · [07 tests](07-TESTING-AND-ACCEPTANCE-PLAN.md#replay-tests).

**Conclusions**

1. The recommended path (A+, [04](04-ARCHITECTURE-OPTIONS.md)) **does not change the replay
   format at all**. A2, A3, A5, A6, A7, A8 and A9 change *which* inputs are admitted and
   *how* state is sent, not how `Match` executes a journal.
2. The real long-term risk is not netplay. It is the **exact-version pinning in the decoder**:
   today *any* future bump of `RULES_VERSION`, `GAME_STATE_VERSION`, `MATCH_VERSION`, the
   garbage profile or the simulation id makes **every stored replay undecodable**
   (`decode.ts:130-150`). M4 must introduce an **engine registry** before the first persisted
   replay exists. Otherwise old shared links will break with the first rules fix.
3. M4 storage, share IDs, appearance metadata and the public viewer route can all be built now,
   independently of any netplay decision, as long as they go through a versioned
   decoder/engine interface (§5) and never re-encode stored journals.

---

## 1. Current replay architecture (facts)

### 1.1 Format (`packages/replay/src/format.ts`)

```ts
interface ReplayBase {
  versions: { format: 1; simulation: "42tris-replay-sim-v2"; coreState: number; coreRules: string;
              matchState?: 3; garbage?: "42tris-league-garbage-v1" };
  id: string;                    // competitive: the server matchId (UUID)
  kind: "solo" | "match";
  mode: { id: "42tris-sprint" | "42tris-local" | "42tris-competitive"; version: 1; config };
  initial;                       // seeds, roster, width, handling, lock profile …
  records;                       // journal
  end;                           // endpoint + finalStateDigest
  summary;                       // claimed results, verified on load
  integrity: { algorithm: "SHA-256"; digest };   // over canonical JSON minus `integrity`
}
```

* Competitive journal records are `{ seq, before:{round, frame}, op }` with
  `op ∈ submit | advance{toFrame, reachedFrame} | release | forfeit | nextRound{seed}`
  (`match-driver.ts:4-15`).
* `canonicalJson` sorts object keys, keeps array order, and rejects non-finite numbers
  (`canonical.ts`). `integrity` detects corruption only. It is not authentication.
* Limits: 32 MiB, 1 M operations, 8 players, 432 000 frames (`limits.ts`).

### 1.2 Recording (server)

* `Rooms.prepare(room, false)` creates a `Match` and, **only for competitive rooms**, a
  `MatchRecorder` (`rooms.ts:295-305`). The constructor rejects practice
  (`match-recorder.ts`). Every authoritative call is routed through the recorder, which calls
  the real `Match` method once and journals it.
* At set end, `recorder.finish()` seals the replay, encodes it, decodes it strictly and
  **verifies it by re-execution** before exposing it (`rooms.ts:474`).
* Appearance (`names`, `skinIds` keyed by roster ID) is snapshotted at match creation, outside
  the journal (`rooms.ts:298-301`).
* Measured size: 2 players × 2 min = 10 117 records (89% `advance`) = **1.11 MB JSON, 103 KB
  gzipped**. 8 players × 2 min = 1.70 MB / **176 KB gzipped** ([03](03-LATENCY-AND-FAILURE-ANALYSIS.md)).

### 1.3 Retrieval (today: private and ephemeral)

`GET /api/rooms/:code/replay` and `/replay/appearance` with `Authorization: Bearer <resume
token>`. Only original roster seats of a completed competitive set can read them, and only
while the room exists (≤60 s empty, ≤15 min idle) (`rooms.ts:88-105`, `app.ts:48-65`).
Responses are `Cache-Control: no-store`. There is no persistence.

### 1.4 Verification and playback

* `verifyMatchReplayExecution` re-runs the journal through `MatchDriver` → the real `Match`.
  It checks the endpoint cursor, epochs, the final digest, every round summary, scores and the
  set result (`verify.ts:169`).
* `MatchPlayback.create` decodes twice, enforces limits, verifies, and requires a completed set.
  Playback runs one cumulative frame timeline across rounds. Backward seeks re-execute from
  zero, with no snapshot cache (`match-playback.ts`).
* Web: `requestCompetitiveReplay` (`replay-request.ts`) → `MatchPlayback` →
  `mountCompetitivePlayback` (`competitive-playback.ts`) → `mountMatchReplay`
  (`match-replay-view.ts`). The renderer **only consumes `MatchState` plus optional
  events/results/appearance**. Controls use the generic `ReplayControlsPlayback` interface
  shared with Sprint (`replay-controls.ts:3-16`).

### 1.5 Coupling to the global authoritative timeline

| Component | Depends on shared timeline? | How |
|---|---|---|
| Journal ops (`submit`/`advance`) | **Yes** | `advance` steps every board through common frames. `submit` carries global `order` |
| `MatchDriver`, `verifyMatchReplayExecution` | **Yes** | Execute the real `Match` |
| `MatchPlayback` | **Yes** | Cumulative frames of one timeline |
| `mountMatchReplay` renderer | **No** | Any `MatchState` (all boards at one instant) |
| `ReplayControlsPlayback` + controls UI | **No** | position/duration/seek/speed |
| Appearance metadata | **No** | Keyed by roster ID |
| Sprint replay stack | **No** | Single board |
| HTTP retrieval and authorization | **No** | Opaque artifact |

---

## 2. Risks of changing the simulation model

| Change | Breaks old replays? | Why |
|---|---|---|
| A2 lead, A3 clock, A5 checkpoint diet, A6 replicas, A8/A9 policies | **No** | Admission and transport only. The journal records whatever the server accepted |
| A7 journal streaming | **No** | Reuses the op format on the wire. The stored replay is unchanged |
| A4b piece guard / re-timing in `Match` | **Yes, unless versioned** | `Match.submit`/apply semantics change → new `MATCH_VERSION` → v3 replays need the v3 engine |
| Any core rule fix (kicks, lock, attack table) | **Yes, unless versioned** | `RULES_VERSION` changes → decoder rejects old replays |
| Architecture B/C | **New kind** | Per-board streams and receipt events need a different journal and driver |
| Re-encoding stored JSON (compaction, key renames) | **Yes** | Changes the integrity digest and possibly share IDs |

**Today's decoder rejects any version mismatch as `unsupported`.** That is correct for safety,
but it means **historical playback requires keeping old engines**.

---

## 3. Component reuse classification

| Component | Under A+ | Under B/C |
|---|---|---|
| `canonicalJson`, `sha256`, `sealReplay`, integrity | Reusable unchanged | Reusable unchanged |
| `ReplayError`, limits | Reusable unchanged | Reusable with new limit fields |
| Solo/Sprint format, drivers, recorder, playback | Reusable unchanged | Reusable unchanged |
| `MatchRecorder` | Reusable unchanged | Replace with a stream recorder for the new kind; keep v1 for history |
| `MatchDriver`, `verifyMatchReplayExecution` | Reusable unchanged | Keep for v1 replays. New driver/verifier for the new kind |
| `decodeReplay` | **Change**: version dispatch through a registry (§5), in M4 regardless | Same registry plus a new kind entry |
| `MatchPlayback` | Reusable unchanged | Keep for v1. Implement the same controller interface for the new kind |
| `competitive-playback.ts` adapter | Reusable with a small adapter for registry-chosen controllers | Adapter |
| `mountMatchReplay` renderer | Reusable unchanged | Reusable with an adapter that builds `MatchState`-shaped snapshots |
| `ReplayControlsPlayback` + controls | Reusable unchanged | Reusable unchanged (cumulative ms instead of frames) |
| Appearance snapshot / endpoint | Reusable unchanged | Reusable unchanged |
| Server retrieval endpoints | Reusable. M4 adds public storage | Same |

---

## 4. Multi-timeline synchronisation (only if B/C is ever built)

A synchronised viewer needs every board at one instant on a **common axis**. With independent
timelines:

1. Record, per player, `(serverArrivalMs, τ)` pairs from the heartbeats the server received.
2. Define each board's mapping `server = f_P(τ)`: piecewise-linear and monotonic, clamped so
   that `τ` advances at ≤ real time.
3. The viewer's position is server ms. For each player compute `τ = f_P⁻¹(position)` and
   simulate that board's stream up to `τ`, applying its recorded receipt events.
4. Packets are drawn from `f_S(τ_send)` to `f_R(τ_recv)`. Causality holds only if the recorder
   guarantees `f_R(τ_recv) ≥ f_S(τ_send)`. Verification must check this.
5. Seeking reuses "rebuild from zero", or per-board snapshots.

This is substantial new work, which is part of why B/C score low on replay preservation in
[04 §7](04-ARCHITECTURE-OPTIONS.md#7-weighted-decision-matrix).

---

## 5. Versioned replay design

### 5.1 Engine registry (introduce in M4-A, before any persistence)

```ts
// packages/replay/src/registry.ts (proposed)
export interface ReplayEngineKey {
  format: number; kind: string; modeId: string; modeVersion: number;
  simulation: string; coreState: number; coreRules: string; matchState?: number; garbage?: string;
}
export interface ReplayEngine {
  key: ReplayEngineKey;
  decode(value: unknown, limits: ReplayLimits): DecodedReplay;        // strict, bounded
  verify(replay: DecodedReplay): Promise<VerifiedReplay>;              // deterministic, no wall clock
  createPlayback(replay: VerifiedReplay): ReplayPlaybackController;     // owns no timer/DOM
}
export interface ReplayPlaybackController extends ReplayControlsPlayback {
  readonly kind: "solo" | "match" | string;
  view(): ReplayView;                       // { kind: "match", state: MatchState } | { kind: "solo", state: GameState, … }
  advance(elapsedMs: number): ReplayViewEvents;
}
const engines = new Map<string, ReplayEngine>();   // key = canonicalJson(ReplayEngineKey)
export function engineFor(replayHeader: unknown): ReplayEngine;   // exact-match lookup → else "unsupported"
```

Rules:

* **Exact match only.** Never "upgrade" an old replay by running it on a newer engine. That
  would change outcomes silently.
* Registering a new engine is purely additive. Removing one breaks links, so do it only with
  an explicit retention decision.
* The current code becomes the first registered engines (Sprint v1, Match v1 / simulation v2
  / matchState 3 / garbage v1 / current core rules).

### 5.2 Keeping old engines runnable

When a rules or Match version bump is unavoidable:

1. Before the change, copy the exact current `packages/core/src` and `packages/match/src` into
   `packages/engines/<engine-id>/` (e.g. `match-v3-rules-<RULES_VERSION>`). Make it **read-only
   by convention, with a test that hashes the directory**.
2. Register that frozen copy for the old key. The live packages move on.
3. Keep a golden-replay corpus test (§7) that loads stored replays of every registered key.

Cost: a few thousand lines duplicated per historical engine, which is small next to the game
bundle. Alternative: load old engines lazily as separate Vite chunks.

### 5.3 Persisted document (M4)

```ts
interface StoredReplayV1 {
  storage: 1;
  digest: string;              // replay.integrity.digest (SHA-256 of canonical JSON) — content address
  engine: ReplayEngineKey;     // copied from the replay header at write time
  bytes: Uint8Array;           // gzip(canonical JSON exactly as sealed) — never re-encoded
  verifiedAt: string;          // ISO date; verification ran with `engine` at write time
  createdAt: string;
  summary: { players: number; rounds: number; durationFrames: number };  // for listings only
}
interface ShareRecordV1 {
  share: 1;
  shareId: string;             // ≥128-bit random, base62/base32; opaque; the public URL key
  digest: string;              // → StoredReplayV1
  appearance: { names: Record<string,string>; skinIds: Record<string,string> };  // sharer's choice
  createdAt: string;
  expiresAt?: string;          // retention policy, if any
}
```

* Public URL: `/r/<shareId>`. Do not embed the format version, host, room code or player IDs
  in it. **The URL scheme is the one decision that is truly irreversible.**
* Content-addressing by digest deduplicates identical replays and makes integrity checks
  trivial. Several share records may point at one replay with different appearances, which
  matches the owner's requirement that "the sharer's chosen skins" travel with the link.
* Appearance stays outside the journal and the digests, as it is today. Validate it on write:
  built-in skin IDs only; names ≤24 characters with the existing character rules.
* Store the sealed bytes as produced. Never rebuild JSON from parsed objects for storage.
* Gzip at rest (≈10×). Optionally serve with `Content-Encoding: gzip` and
  `Cache-Control: public, max-age=31536000, immutable` for `/api/replays/<digest>`.

### 5.4 Write path (share)

```text
POST /api/rooms/:code/replay/share  (Authorization: Bearer <resume token>)
  1. replayAccess(code, token) must be "ready"         // reuse M3-B1 authorization exactly
  2. json = recorder.json; replay = decode(json); engine = engineFor(replay)
  3. verified = await engine.verify(replay)            // again, server-side, before persisting
  4. store StoredReplayV1 (idempotent by digest)
  5. appearance = body.appearance ?? room.replayAppearance  (validated; built-in skins only)
  6. create ShareRecordV1 with fresh shareId; return { shareId, url }
  rate-limit per seat; size-limit by DEFAULT_REPLAY_LIMITS.maxBytes
```

### 5.5 Read path (public)

```text
GET /r/:shareId → HTML viewer route (no token)
GET /api/share/:shareId → { digest, appearance }        (public, cacheable)
GET /api/replays/:digest → gzip bytes                   (public, immutable)
client: decodeReplayJson → engineFor → verify → createPlayback → mountMatchReplay(appearance)
```

Verification runs again in the browser. A shared link is never trusted because it came from
the server.

### 5.6 Storage backends on a zero budget

The interface `ReplayStore { put(doc), get(digest), putShare(rec), getShare(id) }` should have:

* an **in-memory** implementation (tests, development);
* a **filesystem/SQLite** implementation for hosts with a persistent disk;
* a **blob-store** implementation for hosts with ephemeral disks (many free tiers wipe the
  disk on restart). Use any S3-compatible bucket with a free allowance. **Check the free-tier
  terms first. Do not build anything that needs a paid plan.**

At ~100–180 KB per 2-minute set (gzipped), 1 GB holds roughly 6 000–10 000 sets.

---

## 6. What M4 work is safe before any netplay change

| Work | Safe now? | Notes |
|---|---|---|
| Engine registry wrapping the existing decoders and verifiers | **Yes; do it first** | Pure refactor. Keeps today's exact-version behaviour |
| `ReplayStore` interface + in-memory/disk/blob implementations | **Yes** | Independent of netplay |
| Share endpoint (authorised like today), share IDs, appearance records | **Yes** | Reuses `replayAccess` |
| Public viewer route `/r/:shareId` | **Yes** | Reuses `MatchPlayback` through the registry |
| Golden-replay corpus test | **Yes** | Protects against accidental engine changes |
| Retention, rate limits, size limits | **Yes** | |
| Compact journal encodings (e.g. merging `advance` records) | **No** | Changes the format and digests. If ever needed, add a new format version alongside v1 |
| Pseudonymising player IDs inside stored journals | **No** | Changes the digest and possibly sort order (roster sorting drives routing RNG indices). Seat IDs are opaque UUIDs that expire with the guest session; keep them |
| Anything assuming independent timelines | **No** | Only if C is ever chosen; then add a new kind |
| Recording practice rooms | **Never** | Product invariant |

---

## 7. Replay safety invariants and tests

1. **Practice never creates a recorder or a stored replay.** Test: practice rooms through
   reconnect, restart and share attempts ([07](07-TESTING-AND-ACCEPTANCE-PLAN.md#replay-tests)).
2. **Every netplay milestone leaves existing replays verifiable.** Golden corpus: keep ≥5 sealed
   competitive replays (2p, 3p with disconnect/forfeit, 8p, a draw, an aborted set) under
   `packages/replay/fixtures/`. Each must decode, verify and play to the end with identical
   final digest **on every commit**.
3. **Replay results never depend on wall-clock scheduling.** The journal contains `advance`
   targets and `reachedFrame`, never times. Test: replay the same journal with different
   `advance(maxFrames)` chunking (already covered in drivers tests) and different playback
   speeds.
4. **Stored bytes are never re-encoded.** Test: `sha256(canonical(stored)) == digest` and
   `gunzip(bytes)` is identical to the sealed JSON.
5. **Appearance never influences verification.** Test: verify with empty, valid and garbage
   appearance; digest and results are unchanged.
6. **Share URLs resolve after deploys.** Test: a stored share created by version N is
   playable by version N+1 (CI job loading the fixture corpus through the public read path).

---

## 8. Migration risk summary

| Path | Replay migration risk | Irreversible decisions |
|---|---|---|
| A+ (recommended) | **Low**: no format change | None beyond M4's URL scheme |
| A+ with A4b | Medium: new `matchState` version, engine registry required | Keep v3 engine forever if v3 links exist |
| C/B | High: new kind, recorder, driver, verifier, synchronisation | Common-axis definition, receipt semantics |
| D | Very high: no server-verifiable replay | Loss of verification guarantees |
