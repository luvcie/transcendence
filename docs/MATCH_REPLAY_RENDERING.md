# Competitive replay rendering and viewer (M3-B3)

`packages/web/src/match-replay-view.ts` exports `mountMatchReplay(root, options)`.
Mount it inside a host with available width and normal document flow. It uses the
styles in `packages/web/index.html`; a future separate entry point must include those
styles too. The host must allow vertical scrolling when all rows cannot fit on screen.

The returned view exposes:

- `render(state, presentation?)`: replace every participant's display using one
  externally supplied `MatchState`. All roster members are shown in roster order.
- `resetEffects()`: clear attack/garbage notices immediately.
- `resize()`: recalculate the grid. A host `ResizeObserver` and window resize listener
  do this automatically where available.
- `setAppearance(appearance)`: replace names and skin IDs and redraw the current state.
- `dispose()`: disconnect observation/listeners, remove the mounted section, and
  ignore later renders and pending skin-load completions. Safe to call twice.

The renderer imports Match types only. It does not construct a Game, Match, playback
controller, animation loop, or clock. `drawMultiplayerBoard` is shared with live remote
boards and delegates to `drawSnapshot`/`drawBoard` and `drawPiecePreview`. Live remote
boards keep their existing no-ghost default; replay boards enable the existing ghost
drawing option. Each player keeps three canvases across renders and resizes. Native
board dimensions stay at 30 pixels per cell with 20 visible rows, including widths
4–12. CSS scales them proportionally. Hold and next previews stay visible for every
player, including group layouts.

`matchReplayLayout` chooses up to two columns for a duel and up to four for a group,
using a 260px minimum card width and a 24px grid gap. Narrow hosts use fewer columns.
Names, scores, queues and notices wrap instead of truncating. Layout styling is scoped
to `.match-replay` and preserves the existing monospace, canvas outlines and colors.

## Appearance metadata for M3-B3

The exact optional caller-supplied shape is:

```ts
interface MatchReplayAppearance {
  names?: Readonly<Record<string, string>>;
  skinIds?: Readonly<Record<string, string>>;
}

const appearance = {
  names: { "player-a": "Ada", "player-b": "Bea" },
  skinIds: { "player-a": "four", "player-b": "tetrio" },
};
```

Keys are stable `MatchState.roster` IDs, not names, indices, or room seats. Missing
names display the player ID. Skin IDs go through the existing
`MultiplayerSkinResolver` and built-in catalog. Missing, invalid, custom and URL IDs
resolve to Classic; pending or failed image loads also draw Classic colors. Async
completion redraws the latest supplied snapshot without moving playback. The existing
resolver deduplicates loads and applies its retry cooldown.

`loadSkin` optionally supplies the existing loader dependency. `skinOverride(playerId)`
can return a locally loaded `LoadedSkin` for a future viewer override, including a
custom local asset; returning `undefined` uses the participant's metadata. Change a
local override and call `render` again to redraw. Custom URLs must stay in local skin
preferences, outside replay metadata, Match state and digests.

The server snapshots roster-keyed names and shared skin IDs when it creates each
competitive Match. The snapshot stays on the room alongside that Match and is replaced
for a rematch. `GET /api/rooms/:code/replay/appearance` returns
`{ matchId, names, skinIds }` only when the same `replayAccess` checks used by the
replay endpoint succeed. Both endpoints require the guest resume token in the
Authorization bearer header, use no-store responses, exclude practice, and require
current membership plus original roster participation. The client checks that the
appearance match ID matches the verified replay ID. Invalid, custom-only and removed
skins resolve to Classic through the existing built-in resolver. The snapshot never
enters the journal, MatchState, or gameplay digests.

## State, events and results

Boards, incoming garbage totals, pending packets, points, elimination/withdrawal
labels, round number, first-to target and completion flags come directly from the
supplied state. Pending packet text lists the remaining lines and sender in queue
order; it does not simulate cancellation, eligibility or insertion.

`presentation.events` accepts newly delivered `MatchEvent[]`. Current-round `send`,
`queue`, `insert` and `cancel` events produce brief text notices on the relevant
player cards. They do not change persistent information. Each player's latest batch
remains visible for 60 externally supplied round frames, until replaced by another
batch for that player or cleared with `resetEffects`. Empty event batches and paused
renders preserve notices. This cosmetic lifetime uses `MatchState.frame` only; the
renderer has no clock or timer. Names update with appearance metadata. Events from
other rounds are ignored. Cross-cancel and discard events have no extra animation; their resulting
queue state is already reflected in the authoritative snapshot.

Always use `presentation.discontinuity: true` after a seek in either direction or a
restart. This clears notices and suppresses any historical events returned by the
controller. Render the new snapshot immediately. Persistent labels are rebuilt each
render, so backward seeks and round transitions clear old scores, queues and status.
Round changes and decreasing frame numbers also clear notices automatically; forward
seeks and same-frame restarts still require the explicit discontinuity flag.
No countdown or disconnect-pause duration is synthesized.

Winner identity needs separate authoritative metadata because `MatchDriver` drains
result events and `MatchState` retains no round/set winner field. The renderer never
chooses winners from scores or elimination flags. Supply:

```ts
interface MatchReplayResults {
  round: number;
  roundWinner?: string | null;
  setWinner?: string | null;
  roundReason?: string;
  setReason?: string;
}
```

Pass this as `presentation.results` with every render that needs winner text. A player
ID means that recorded winner; `null` means an explicit no-winner outcome; omission
means unknown. Metadata for another round is ignored, and state completion flags gate
result labels. Without metadata the renderer still shows round/set completion and
all scores. Appearance updates preserve the latest result metadata.

The viewer looks up each round in the verified replay summary on every render,
including after backward seeks. Its round winners/reasons and set winner/reason were
verified against reconstructed result events by MatchPlayback creation. Winner labels
are gated by the current state's ended/complete flags; final scores never select a
winner. Final frames show both the round and set outcome, including explicit no-winner
and aborted outcomes.

## Viewer integration

The competitive results action is available only to a participant in a completed
competitive set. Opening it fetches the sealed replay before leaving or disconnecting
from the room. A 202 leaves results visible with an explicit retry message. Failed,
unavailable, unauthorized and network responses also leave results usable; there is
no polling. Requests can be cancelled on navigation, have a 15-second network timeout,
and stream at most the default replay byte limit (32 MiB), or 8 KiB for appearance.
The existing decoder applies its structural limits and MatchPlayback verifies execution
and completion. The client constructs one MatchPlayback for each successfully opened
replay; it never simulates boards independently.

`mountCompetitivePlayback` adapts that controller to `mountMatchReplay`. Every render
passes one authoritative MatchState containing all boards, scores and garbage queues.
New controller events reach the renderer in journal order. Seeking in either direction
and restarting render immediately with discontinuity set, suppressing historical effects.

The app's existing animation loop advances playback with elapsed presentation time,
capped at 100 ms per frame. All boards share that one clock. Blur/backgrounding pauses
playback; play, restart, seeking and speed changes reset the presentation timestamp.
No elapsed background time is applied on resume. The viewer owns no additional RAF.

Round transitions show the final state reached at each supplied cumulative frame.
Several zero-duration operations can share a boundary, so an immediate nextRound can
replace the prior round's terminal board at the same position. The viewer does not
hold an invented intermediate state or add countdown/disconnect-pause durations.
Round changes clear notices; current-round notices last 60 supplied simulation frames.

Sprint and competitive replay use the same DOM control bar, CSS and
`mountReplayControls` handlers. Both offer play/pause, replay after completion, restart,
the four speeds, elapsed/total time, Back to results, and an interactive range slider.
Competitive seeks in cumulative frames; Sprint seeks in recorded-timeline milliseconds,
including fractional timestamps. Both show Playing, Paused, or Finished status above the
timeline, with elapsed/total time on the right and the same action row below.
The controls remain below the board area at a shared width of up to 1000px and use
two action columns on narrow screens. Existing
Escape/pause-key navigation still exits replay; gameplay bindings, undo and restart
cannot reach live controllers while either replay is open.

Sprint forward seeks apply remaining journal operations through the selected timestamp.
Backward seeks that cross an applied operation rebuild the SprintDriver from its initial
state and apply the journal prefix in sequence order. A seek within the same prefix
requires no reconstruction. Equal-time operations stay together; the viewer does not
add ticks between recorded observations. Seeking preserves play/pause, except reaching
the end stops playback. Seeking back from a finished replay leaves it paused until Play.
Verification happens once when opening; seeking never changes the source recording or
uses a snapshot cache.

Slider input retains only the latest requested position. The existing app frame flushes
that request before calculating elapsed time; a final change event also flushes it.
Each flush resets the presentation timestamp, preventing a clock jump on resume. Pause
and speed actions settle a pending seek first; restart, exit and disposal discard it.
Requests belong to their original playback instance and cannot affect a reopened replay.

The single bar stays outside both board containers, so its placement is the same for
Sprint and competitive replay and does not change on disposal. Replay headings identify
the mode; Sprint keeps its board, timer and statistics in the scrolling content area,
while competitive keeps the participant grid and round summary. The session remains connected
and ticks for heartbeat/reconnect handling while the replay is open. Exit disposes the
renderer and returns to the current room screen, showing results if still available
or the current lobby/waiting/game screen otherwise. Navigation cancels pending requests,
clears pressed gameplay keys and removes the replay renderer, observers and listeners.
The shared controls live for the application lifetime and are removed on page disposal.
