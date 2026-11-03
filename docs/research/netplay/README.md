# 42tris netplay investigation

> **Historical baseline (2026-11-03):** This investigation predates N2-0 and N2-A, which have
> since been implemented. Some findings describe behavior that has since changed; treat the
> reports as a snapshot of that earlier state.

Research package on 42tris multiplayer networking: why play was smooth in Europe but laggy on
a far-away host, what comparable games do, and how to improve netplay without losing server
authority or the replay system.

* **Investigation date:** 2026-11-03
* **Code audited:** `a4a9e8e95fff86ab43e081220c8bac36de1a55f7` (`main` = GitHub `main`, N1-B;
  648 tests passing). The pipeline was first audited at its parent `fe92d946` (N1-A, 641
  tests). N1-B changes only `session.ts`, `session-diagnostics.ts` and the latency tests.
* **N1-B review:** sound when it runs, but it recovers only if a checkpoint is processed before
  the next flush after a stall. See [01 §3.7](01-CURRENT-42TRIS-ARCHITECTURE.md#37-client-reconciliation-sessionts399-442-276-358)
  and [06 N2-0](06-IMPLEMENTATION-ROADMAP.md#n2-0--close-the-n1-b-post-stall-ordering-gap).
* **Nature:** research and documentation only. No production code, protocol, replay or
  deployment changes.

## Documents and reading order

| # | Document | For | Purpose |
|---|---|---|---|
| 1 | [00-EXECUTIVE-SUMMARY.md](00-EXECUTIVE-SUMMARY.md) | Owner | Findings, causes, recommendation and what not to touch, in plain language |
| 2 | [03-LATENCY-AND-FAILURE-ANALYSIS.md](03-LATENCY-AND-FAILURE-ANALYSIS.md) | Everyone | Measured results, failure modes, Antideploy diagnosis plan |
| 3 | [01-CURRENT-42TRIS-ARCHITECTURE.md](01-CURRENT-42TRIS-ARCHITECTURE.md) | Engineers, agents | Source audit with `file:line` references: input lifecycle, clocks, reconciliation, opponents, garbage, replays |
| 4 | [04-ARCHITECTURE-OPTIONS.md](04-ARCHITECTURE-OPTIONS.md) | Decision makers | A/A+, B, C and D compared; anti-cheat; late garbage; weighted matrix with falsification criteria |
| 5 | [05-REPLAY-COMPATIBILITY.md](05-REPLAY-COMPATIBILITY.md) | M4 implementers | Protecting replays: engine registry, storage, share links, appearance, what is safe now |
| 6 | [06-IMPLEMENTATION-ROADMAP.md](06-IMPLEMENTATION-ROADMAP.md) | Implementation agents | Ordered milestones N2-0…N6 and M4-A…E with invariants, tests, acceptance and rollback |
| 7 | [07-TESTING-AND-ACCEPTANCE-PLAN.md](07-TESTING-AND-ACCEPTANCE-PLAN.md) | Implementation agents | Test catalogue, quantitative targets, real-network protocol, rejection criteria |
| 8 | [02-EXTERNAL-GAMES-RESEARCH.md](02-EXTERNAL-GAMES-RESEARCH.md) | Background | Techmino/Techrater (source-verified), TETR.IO (official statements), ZBB (anecdotal) |
| A | [appendix-A-experiment-harness.md](appendix-A-experiment-harness.md) | Reproducers | Exact scripts behind every measured number |

Implementation agents: read **06 → 07 → 01** before touching code. The [global
invariants](06-IMPLEMENTATION-ROADMAP.md#global-invariants) are mandatory.

## Evidence conventions

* **[measured]** fake-time harness output using the real `Rooms`/`Match`/`Session` code
  (Appendix A).
* **[modelled]** harness output that depends on an explicit modelling assumption (e.g.
  link capacity).
* **[derived]** follows from the source code by reasoning.
* **[source] / [official] / [community] / [anecdotal]** external evidence quality ([02](02-EXTERNAL-GAMES-RESEARCH.md)).
* **[hypothesis] / [inference]** plausible, not demonstrated.

All `path:line` references are to `a4a9e8e` (identical to `fe92d94` outside the three N1-B files) and may drift after later commits. Where these
documents and the code disagree, the code wins.

## One-line answer to the research question

Keep the server-authoritative shared timeline. Fix its measured weaknesses: a per-player
input lead instead of a fixed 100 ms window, small checkpoints, locally simulated opponent
boards, and an explicit outage policy. Version replay engines before persisting replays. Only
revisit independent timelines if real-network diagnostics after those fixes still show
frequent input loss ([04 §7](04-ARCHITECTURE-OPTIONS.md#uncertainty-and-falsification)).
