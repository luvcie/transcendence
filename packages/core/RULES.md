# 42tris rules

`42tris-tl-s2-v1` adopts Tetra League Season 2 clears and attacks while keeping
42tris handling, gravity and its one-second lock delay. It does not implement
incoming garbage, cancellation or the rest of Tetra League's match settings.

References checked on 2026-10-28:

- [TETR.IO patch notes](https://tetr.io/about/patchnotes/notes.json)
- [TETR.IO client](https://tetr.io/js/tetrio.js), SHA-256
  `9e57c958c43520deb5dd91f5e1773bf779bfb91e7d273dc8494a93a3a0866d2f`

The profile fixes these choices explicitly, independent of future client updates:

- All-Mini+ spins with SRS+ rotation. T corners distinguish full spins from minis,
  with the fifth rotation test upgrading a corner mini. Immobile spins otherwise
  count as minis. A successful translation invalidates rotation eligibility.
- Ordinary and mini clears have base attacks 0, 1, 2, 4 for one through four lines.
  Full T-spins have base attacks 2, 4, 6 for one through three lines.
- Quads, spin line clears and all clears qualify for B2B. Each contributes once,
  even when a spin or Quad is also an all clear. No-line placements preserve B2B.
- Displayed B2B is chain length minus one. Subsequent qualifying clears add one
  to base attack. At displayed B2B 4, stored Surge is 4, then grows with B2B.
- An ordinary clear breaks B2B and releases stored Surge in three packets:
  `round(n / 3)`, `round(n / 3)`, and the remainder.
- Displayed combo starts at zero on the first clear and resets on an empty
  placement. Multiply base attack plus B2B by `1 + 0.25 * combo`. At combo 2
  or higher, apply a minimum of `ln(1 + 1.25 * combo)`, then round down.
- A Quad or spin clearing a garbage-containing row adds one after rounding.
  An all clear adds a separate five-line packet. Surge and all-clear packets
  do not receive combo multipliers. Attack multiplier stays at one.

## Core consumers

Give `Game.apply` and `Game.tick` monotonically increasing times in milliseconds
(equal timestamps are allowed). Advance with the same seed, configuration and
ordered inputs to reproduce a game. Render ticks do not advance accumulators
between simulation deadlines, so render frequency does not change lock events.
Input and pause boundaries account for the remaining elapsed time.

Drain events after both `apply` and `tick`, and before discarding a game on restart.
A lock result records its simulation time, cleared row indices before compaction,
spin, all-clear status, updated counters and ordered attack packets. Packets are
Surge first, ordinary attack second, all-clear bonus last. Zero packets are omitted.
The attack counter measures generated lines, before any future cancellation.

`stats.combo` is -1 outside a combo, 0 on its first clear. `chainLength` distinguishes
an established B2B chain from no chain, even though both display B2B 0. Event values
are immutable and sequence numbers increase throughout a game instance's lifetime.
A future match controller supplies player identity and handles attack routing.
