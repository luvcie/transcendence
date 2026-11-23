# Move generator

`packages/core/src/movegen.ts`. Notes on how it works and how I'd build a CPU/AI and a perfect clear (PC) solver on top. Only `movegen.ts` and its first user, the piece by piece GIF in the editor (`packages/web/src/gif-pieces.ts`), exist so far.

## API

```ts
placements(board, piece, options?) // every lock reachable from spawn, each with its cheapest key presses
targetPlacements(board, piece, targets) // cheapest lock for each requested set of sorted cells, regardless of spin
pathTo(board, piece, { x, y, rot, spin? }, options?) // cheapest presses to one chosen lock, or null
toInputs(moves, handling) // timed Game inputs for a move list, to replay it in a real Game
Move // Left Right DasLeft DasRight Cw Ccw Flip SoftDrop HardDrop
```

- `board` is the core board: `Uint8Array(ROWS * width)`, `ROWS = 40`, row 0 on top, cell ids from `pieces.ts` (Z1 L2 O3 S4 I5 J6 T7, garbage 8).
- A `Placement` has `x, y, rot` (where it locks), `spin` (`none | mini | full`), `cells` (four sorted board indices), `cost`, and `moves` (cheapest presses from spawn, ending in `HardDrop`).
- Two paths that lock the same cells with the same spin are one placement. A T-spin and a normal lock on the same cells are two.
- Hold is up to the caller: call it for the current piece and again for the held (or next) piece.
- `options.costs` is a non-negative integer cost per `Move`, 1 per press by default. That's the hook for other cost models.

## How it works

Dijkstra over states `(x, y, rot, tag)`, with buckets instead of a heap (dial's algorithm). `tag` remembers whether the last move was a rotation and whether it used the 4th kick, because the spin check needs that. For every state it pops, it:

1. drops the piece to the floor to find the lock for that state (zero gravity, the piece waits wherever you want) and records it if it's new
2. relaxes the neighbours: one step left or right, a DAS slide to the wall or obstacle, cw, ccw, 180, and a soft drop to the surface

Costs are key presses, not time. A DAS slide is 1 press and so is a sonic soft drop. That's how finesse is counted and what you want to see in a GIF.

Rotation follows `Game.rotate`: the natural rotation first, then the kick table from `kicksFor`. Spin classification reuses `classifySpin` from `rules.ts`, so the generator can't disagree with the game about what counts as a T-spin.

State lives in flat typed arrays (`dist`, `parent`, `via`) indexed by a packed id. `PAD = 3` so pieces hanging off the left or top of the board still get an index.

`movegen.test.ts` replays results through the real `Game` instead of trusting the search: every placement replays with `toInputs` to the predicted lock, a brute force search over real `Game` states finds the same locks at the same cost, empty board costs match `finessePlacement`, and a few hand made cases cover an O tucking under a roof, an I into a one row slot, a T-spin triple slot only reachable with the 4th kick, and an enclosed pocket that is never offered. `kicks.test.ts` pins the kick tables to tetr.io.

## Rules it assumes

- SRS+ kicks, taken from the tetr.io client bundle (`https://tetr.io/js/tetrio.js`). All 24 transitions for every piece match, including I and 180. `kicks.ts` holds them and `kicks.test.ts` keeps them that way.
- The tetr.io O piece has `disallow_kick` and the same cells in every rotation, so there is nothing to add. The `oo_kicks` in that bundle belong to a different 4x4 piece, not the O.
- Zero gravity during the search. `toInputs` needs a `Game` with `das > 0, arr 0, sddas 0, sdarr 0` and gravity slow enough not to pull the piece during DAS waits (the tests use `1e9`). A real 20G game needs a different input layer.

## What I looked at

- **cobra-movegen** (C++, Apache-2.0), `src/row/pathfinder.hpp`. The closest model: best first search over piece states producing the reachable locks.
- **Cold Clear 1**, `moves.rs`. A Dijkstra that yields input lists. It uses classic SRS (no SRS+ I kicks, no 180), so don't copy its kicks.
- **Cold Clear 2**. Same family and same classic SRS catch. Useful for how a bot searches over placements, not for rotation.
- **MisaMinoNET**, `FindPathMoving`. Turns a target placement into a move list.
- **Techmino**. Its bots use TRS and the external Cold Clear. Shows how a game plugs a bot in, not how to generate moves.
- **triangle.js**. A second source for kick data.
- **perfect-tetris** (Zig) and **pcf**. Not used yet, they're the starting points for the PC solver.

ZZZTOJ is closed source and the MochBot repos are gone (only an unlicensed `sypeeoui/fusion` is left). Nothing here is copied from any of these, it's written for 42tris.

## CPU/AI on top

1. For the current piece (and the hold piece) call `placements(board, piece)`. Lock each placement on a copy of the board with `place`, then `clearRows` from `board.ts`, and score the result.
2. A one piece greedy bot is just an evaluation function. For lookahead, recurse over the queue (`game.previews`) and keep a beam of the best boards per depth. `placements` is the expansion step.
3. The evaluation should read `spin` and line clears directly, so T-spins and back to back are rewarded the way the game scores them, plus the usual holes, bumpiness, height and well position terms.
4. The winning placement already carries `moves`, and `toInputs(moves, handling)` turns them into timed `Game` inputs. For a human feeling bot, make soft drops and 180s expensive with `options.costs`. For a fast bot, weight by time instead of presses (a DAS slide is one press but real time).
5. Hold is a branch: placements for the held piece on the same board.

A deep beam search will call `placements` millions of times and it allocates a few typed arrays per call (`size = 4 * ys * xs * 3`), so add a reusable scratch buffer (pass it in `options`) before profiling anything else. A bot that only cares about the board after the lock can skip building `moves` and ask `pathTo` for the one it picked. If an AI ever has to play at real gravity or with lock delay, that's an input layer on top, not a change to the search. Garbage (8) is just another filled cell.

## PC solver on top

1. Use `placements` for reachability, not as the whole search. It gives exactly the legal reachable locks, including tucks and spins that "drop from the top" generators miss. That's what it adds over pcf and perfect-tetris, which assume their own placement rules.
2. Depth first over a 7-bag order. At each node pick a piece (current or hold), enumerate placements, apply them with `place` and `clearRows`, prune, recurse. A PC is reached when the board is empty. A PC with `h` rows needs `h * 10 / 4` pieces, so `h` must be even (2 rows is 5 pieces, 4 rows is 10). Garbage already on the board changes the count the same way: filled cells plus placed cells must reach a multiple of 4 and clear to zero.
3. Prune hard: parity and cell count, unreachable holes, column heights. perfect-tetris is the reference for which pruning matters.
4. Speed is the real risk. perfect-tetris is fast because of bit boards and precomputed tables, and `placements` is a general search per node. Either run the solver on cheap drop-position rules first and only call `placements` or `pathTo` to verify and to get the key presses for the final solution, or keep `placements` as the expander and cap the board height until it's too slow, then add the scratch buffer and a bit board fast path.
5. A solution is a list of `(piece, placement)`. `animateSteps` in `gif-pieces.ts` already replays that kind of list, so a PC solution can become a GIF with no new code.

## Where it's used

`gif-pieces.ts` looks for reachable placements that cover the added cells exactly. It memoizes the cells still to place and starts with low placements that leave lower cells open. Steps of up to ten pieces use the fewest total presses the search finds. Larger steps use the first complete order. A worker plans each step with a 20-second ceiling, then replays the moves through `Game` to produce GIF frames.

## Gaps

- The O piece never gets extra kicks (matches tetr.io). `kicksFor` is the place to add them.
- No gravity or lock delay.
- No scratch buffer, so every call allocates.
- No scoring: `spin` is reported but the generator doesn't know what a clear is worth.
