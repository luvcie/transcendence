# Competitive replay rendering (M3-B2)

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

M3-B3 must obtain original participant appearance metadata separately from deterministic
replay content and pass it here. The current server does not snapshot original skins;
this milestone adds no server capture or retrieval behavior. Without those snapshots,
the renderer can show only the supplied metadata or Classic, and cannot recover a
participant's historical choice from the journal.

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
}
```

Pass this as `presentation.results` with every render that needs winner text. A player
ID means that recorded winner; `null` means an explicit no-winner outcome; omission
means unknown. Metadata for another round is ignored, and state completion flags gate
result labels. Without metadata the renderer still shows round/set completion and
all scores. Appearance updates preserve the latest result metadata.

M3-B3 must retain/reconstruct result metadata from verified `roundEnd`/`setEnd` journal
outcomes at the requested playback position, including backward seeks and direct final
jumps. Normal transient event batches alone cannot restore persistent winner labels
following a backward seek, since `MatchPlayback.seek` deliberately emits no historical
events in that direction. This integration requirement needs no simulation or protocol
change in the renderer.

M3-B3 also owns secure retrieval, navigation, the single MatchPlayback instance,
controls, and its shared presentation clock. None are mounted by this module.
