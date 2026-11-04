import { Input } from "@42tris/core";
import type { LeadExperiment } from "./netplay-lead-experiment";
import type { LinkProfile } from "./netplay-harness";

export const adaptiveExperiments: LeadExperiment[] = [
  ...[40, 180, 200, 300].map(rtt => ({ name: `adaptive RTT ${rtt}`, options: {
    players: [{ up: rtt / 2, down: rtt / 2 }, { up: 20, down: 20 }], inputLeadMs: { a: "auto" as const, b: "auto" as const },
  } })),
  { name: "adaptive RTT 60 spikes", options: {
    players: [{ up: 30, down: 30, spikeChance: 0.05, spikeMs: 150 }, { up: 20, down: 20 }], inputLeadMs: { a: "auto", b: "auto" },
  } },
  { name: "adaptive mixed", options: {
    players: [20, 60, 180, 300].map(rtt => ({ up: rtt / 2, down: rtt / 2 })),
    inputLeadMs: { a: "auto", b: "auto", c: "auto", d: "auto" },
  } },
  ...[[20, 180], [180, 20]].map(([up, down]) => ({ name: `adaptive asymmetric ${up}/${down}`, options: {
    players: [{ up, down }, { up: 20, down: 20 }], inputLeadMs: { a: "auto" as const, b: "auto" as const },
  } })),
];

export const routeExperiments: LeadExperiment[] = [
  ["300 to 40", { up: 150, down: 150 }, { up: 20, down: 20 }],
  ["40 to 300", { up: 20, down: 20 }, { up: 150, down: 150 }],
  ["180/20 to 20/300", { up: 180, down: 20 }, { up: 20, down: 300 }],
].map(([name, from, to]) => ({
  name: `adaptive route ${name}`,
  options: { players: [from as LinkProfile, { up: 20, down: 20 }], inputLeadMs: { a: "auto", b: "auto" } },
  beforeScript(h) {
    const before = h.a.diagnostics!.snapshot();
    const round = h.room!.match!.round;
    h.setLink("a", to as LinkProfile);
    for (let at = 0; at < 5000; at += 625) h.script("a", [
      [at, Input.RotateCw], [at + 15, Input.LeftDown], [at + 55, Input.LeftUp],
    ]);
    // Permit old samples to age out, then permit decrease confirmation. The server
    // and Session continue running; no clock or input stamps are patched.
    for (let elapsed = 0; elapsed < 46_000; elapsed += 250) {
      h.advance(250);
      const current = h.a.diagnostics!.snapshot();
      if (h.room!.match!.round !== round || current.lead.appliedMs !== before.lead.appliedMs
        || current.clock.effectiveOffsetMs !== before.clock.effectiveOffsetMs
        || current.adaptive.decisions.length !== before.adaptive.decisions.length) throw new Error("Adaptive decision changed inside a round");
    }
    const during = h.a.diagnostics!.snapshot();
    h.dropOut("b");
    h.runUntil(() => h.a.session.checkpoint!.state!.round > round && h.a.session.canPlay && h.b.session.canPlay, 8000);
    const after = h.a.diagnostics!.snapshot();
    return { from, to, before: { lead: before.lead, clock: before.clock },
      during: { lead: during.lead, clock: during.clock, decreaseConfirmed: during.adaptive.decreaseConfirmed },
      after: { lead: after.lead, clock: after.clock } };
  },
}));
