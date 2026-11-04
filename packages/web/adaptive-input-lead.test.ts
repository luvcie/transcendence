import { describe, expect, test } from "bun:test";
import { AdaptiveInputLead, median, nearestRankP95, proposeLead, type AdaptivePongSample } from "./src/adaptive-input-lead";

function sample(sent: number, up: number, down = up, epoch = 1): AdaptivePongSample {
  return { connectionEpoch: epoch, sentAtClientMs: sent, receivedAtClientMs: sent + up + down,
    serverPongMs: sent + up, rttMs: up + down, impliedOffsetMs: (up - down) / 2 };
}
function window(up: number, down = up) { return [0, 500, 1000].map(at => sample(at, up, down)); }
function observe(policy: AdaptiveInputLead, sent: number, up: number, down = up, active = 0) {
  policy.activity(sent);
  const nonce = policy.probe(sent)!;
  for (let at = sent + 100; at < sent + up + down; at += 100) policy.activity(at);
  return policy.pong(nonce, sent + up, sent + up + down, 100, active);
}

describe("N3-C adaptive policy", () => {
  test.each([[40, 0], [180, 44], [200, 54], [300, 104]])("RTT %i selects %i", (rtt, lead) => {
    const p = proposeLead(window(rtt / 2), 1000 + rtt, 100)!;
    expect(p.candidateMs).toBe(lead);
    expect(p.offsetMs).toBe(0);
    if (rtt === 300) expect(p.ceilingMs).toBe(113);
  });
  test("upstream increase is measured relative to the selected calibration; downstream delay is distinct", () => {
    const base = window(30);
    // The lowest RTT calibration comes from one of the newest three samples.
    const upstream = proposeLead([...base, sample(1500, 180, 30)], 1710, 100)!;
    const downstream = proposeLead([...base, sample(1500, 30, 180)], 1710, 100)!;
    expect(upstream.effectiveTransitP95).toBe(180);
    expect(upstream.wantedMs).toBe(134);
    expect(downstream.effectiveTransitP95).toBe(30);
    expect(downstream.candidateMs).toBe(0);
  });
  test.each(Array.from({ length: 16 }, (_, i) => i + 1))("exact statistics for %i samples", count => {
    const sorted = Array.from({ length: count }, (_, i) => i * 3 + 1);
    expect(median(sorted)).toBe((sorted[0] + sorted[count - 1]) / 2);
    expect(nearestRankP95(sorted)).toBe(sorted[Math.ceil(count * 0.95) - 1]);
  });
  test("lowest RTT of newest three wins; equal RTT chooses newest", () => {
    const samples = [sample(0, 1), sample(500, 40), sample(1000, 20), sample(1600, 20)];
    const proposal = proposeLead(samples, 1640, 100)!;
    expect(proposal.selected.sentAtClientMs).toBe(1600);
    samples[2] = sample(1000, 10);
    expect(proposeLead(samples, 1640, 100)!.selected.sentAtClientMs).toBe(1000);
  });
  test("warmup requires one-second span and all freshness bounds", () => {
    expect(proposeLead([sample(0, 20), sample(400, 20), sample(999, 20)], 1039, 100)).toBeNull();
    const samples = [sample(0, 20), sample(3000, 20), sample(6001, 20)];
    expect(proposeLead(samples, 6041, 100)).toBeNull();
    expect(proposeLead(window(20), 4041, 100)).toBeNull();
    expect(proposeLead(window(20), 40_000, 100)).toBeNull();
  });
  test("unmatched, duplicate and old-connection pongs cannot authorize calibration", () => {
    const p = new AdaptiveInputLead(); p.connection(1);
    expect(p.pong("unknown", 20, 40, 100, 0)).toBe(false);
    const nonce = p.probe(0)!;
    p.connection(2);
    expect(p.pong(nonce, 20, 40, 100, 0)).toBe(false);
    expect(observe(p, 500, 20)).toBe(true);
    expect(p.pong(nonce, 520, 540, 100, 0)).toBe(false);
    expect(p.decide(540, 100, 0).reason).toBe("fallback-unwarmed");
  });
  test("a detected scheduling gap contaminates every outstanding probe", () => {
    const p = new AdaptiveInputLead(); p.connection(1); p.activity(0);
    const a = p.probe(0)!, b = p.probe(10)!;
    p.activity(300);
    expect(p.pong(a, 20, 301, 100, 0)).toBe(false);
    expect(p.pong(b, 30, 302, 100, 0)).toBe(false);
    expect(p.observations(302)).toHaveLength(0);
    expect(observe(p, 1000, 150)).toBe(true); // RTT >250 is valid with a running browser.
  });
  test.each([NaN, Infinity, -Infinity])("nonfinite timestamp %s never corrupts policy", value => {
    const p = new AdaptiveInputLead(); p.connection(1);
    expect(p.probe(value)).toBeNull();
    expect(p.pong(p.probe(0)!, value, 40, 100, 0)).toBe(false);
    expect(p.pong(p.probe(100)!, 120, value, 100, 0)).toBe(false);
    expect(p.observations(200)).toEqual([]);
    expect(proposeLead(window(20), value, 100)).toBeNull();
    expect(proposeLead(window(20), 1040, value)).toBeNull();
  });
  test.each([-1, 2001])("RTT %i is rejected", rtt => {
    const p = new AdaptiveInputLead(); p.connection(1);
    const nonce = p.probe(100)!;
    for (let at = 200; at < 100 + rtt; at += 100) p.activity(at);
    expect(p.pong(nonce, 110, 100 + rtt, 100, 0)).toBe(false);
  });
  test("sample capacity and expiry are bounded independently of diagnostics", () => {
    const p = new AdaptiveInputLead(); p.connection(1);
    for (let i = 0; i < 40; i++) observe(p, i * 2000, 20);
    expect(p.observations(78_040)).toHaveLength(16);
    expect(p.observations(120_000)).toHaveLength(0);
    expect(p.decide(120_000, 100, 104).appliedMs).toBe(0);
  });
  test("at most four outstanding probes; expired probes cannot authorize a decision", () => {
    const p = new AdaptiveInputLead(); p.connection(1);
    const nonces = [0, 500, 1000, 1500].map(at => p.probe(at)!);
    expect(p.probe(2000)).toBeNull();
    expect(p.outstandingCount).toBe(4);
    expect(p.probe(2001)).not.toBeNull();
    expect(p.outstandingCount).toBe(4);
    expect(p.pong(nonces[0], 20, 2001, 100, 0)).toBe(false);
    p.connection(2);
    expect(p.outstandingCount).toBe(0);
  });
  test.each([40, 180, 200, 300, 350, 400, 600, 1000, 2000])("RTT %i always respects both automatic bounds", rtt => {
    const p = proposeLead(window(rtt / 2), 1000 + rtt, 100)!;
    expect(p.candidateMs).toBeLessThanOrEqual(160);
    expect(p.candidateMs).toBeLessThanOrEqual(p.ceilingMs);
    expect(p.candidateMs).toBeGreaterThanOrEqual(0);
    expect(p.capped).toBe(p.wantedMs > p.ceilingMs);
  });
  test("three successive lower proposals over four seconds permit the full decrease", () => {
    const p = new AdaptiveInputLead(); p.connection(1);
    for (const at of [0, 500, 1000]) observe(p, at, 20);
    expect(p.decide(1040, 100, 104).appliedMs).toBe(104);
    for (const at of [2000, 4000, 6000]) observe(p, at, 20, 20, 104);
    expect(p.decreaseConfirmed).toBe(true);
    expect(p.decide(6040, 100, 104).appliedMs).toBe(0);
  });
  test("one optimistic proposal and three proposals too close together cannot decrease", () => {
    const p = new AdaptiveInputLead(); p.connection(1);
    for (const at of [0, 500, 1000]) observe(p, at, 20, 20, 104);
    expect(p.decreaseConfirmed).toBe(false);
    expect(p.decide(1040, 100, 104)).toMatchObject({ appliedMs: 104, reason: "decrease-held" });
  });
  test("zero qualifies below hysteresis and a higher proposal interrupts confirmation", () => {
    const p = new AdaptiveInputLead(); p.connection(1);
    for (const at of [0, 500, 1000, 3000, 5000]) observe(p, at, 20, 20, 10);
    expect(p.decreaseConfirmed).toBe(true);
    observe(p, 7000, 150, 20, 10);
    expect(p.decreaseConfirmed).toBe(false);
  });
  test("uncertainty ceiling overrides an unconfirmed decrease", () => {
    const p = new AdaptiveInputLead(); p.connection(1);
    for (const at of [0, 500, 1000]) observe(p, at, 150);
    expect(p.decide(1300, 100, 160)).toMatchObject({ appliedMs: 113, reason: "ceiling-decrease" });
  });
  test("decisions are bounded and deterministic", () => {
    const run = () => {
      const p = new AdaptiveInputLead(); p.connection(1);
      for (const at of [0, 500, 1000]) observe(p, at, 150);
      for (let i = 0; i < 50; i++) p.decide(1300 + i, 100, 0);
      return p.decisions();
    };
    expect(run()).toHaveLength(32);
    expect(run()).toEqual(run());
  });
});

test("invalid pong fields cannot poison an otherwise warmed policy", () => {
  const p = new AdaptiveInputLead(); p.connection(1);
  for (const at of [0, 500, 1000]) observe(p, at, 150);
  const before = p.proposal(1300, 100);
  expect(p.pong(p.probe(1400)!, NaN, 1500, 100, 104)).toBe(false);
  expect(p.proposal(1500, 100)).toEqual(before);
});

test("compressed valid observations keep bootstrap probing until calibration is eligible", () => {
  const p = new AdaptiveInputLead(); p.connection(1);
  const probes = [0, 5, 10].map(at => { p.activity(at); return { at, nonce: p.probe(at)! }; });
  for (const { at, nonce } of probes) expect(p.pong(nonce, at + 90, at + 180, 100, 0)).toBe(true);
  expect(p.observations(190)).toHaveLength(3);
  expect(p.proposal(190, 100)).toBeNull();
  expect(p.cadence(190)).toBe(500);
  observe(p, 510, 90);
  expect(p.proposal(690, 100)).toBeNull();
  expect(p.cadence(690)).toBe(500);
  observe(p, 1010, 90);
  expect(p.proposal(1190, 100)).toMatchObject({ candidateMs: 44, offsetMs: 0 });
  expect(p.cadence(1190)).toBe(2000);
  expect(p.decide(1190, 100, 0)).toMatchObject({ appliedMs: 44, reason: "selected" });
});

test.each([
  { name: "newest older than three seconds", times: [0, 500, 1000], now: 4181 },
  { name: "oldest of newest three older than six seconds", times: [0, 500, 6001], now: 6181 },
])("bootstrap resumes for ineligible retained observations: $name", ({ times, now }) => {
  const p = new AdaptiveInputLead(); p.connection(1);
  for (const at of times) observe(p, at, 90);
  expect(p.observations(now)).toHaveLength(3);
  expect(p.proposal(now, 100)).toBeNull();
  expect(p.cadence(now)).toBe(500);
});

test("replaced connections and stale pongs cannot end bootstrap calibration", () => {
  const p = new AdaptiveInputLead(); p.connection(1);
  for (const at of [0, 500, 1000]) observe(p, at, 90);
  expect(p.cadence(1180)).toBe(2000);
  const oldProbe = p.probe(1500)!;
  p.connection(2);
  expect(p.outstandingCount).toBe(0);
  expect(p.cadence(1500)).toBe(500);
  expect(p.pong(oldProbe, 1590, 1680, 100, 0)).toBe(false);
  expect(p.observations(1680)).toHaveLength(0);
  for (const at of [2000, 2500]) observe(p, at, 90);
  expect(p.cadence(2680)).toBe(500);
  observe(p, 3000, 90);
  expect(p.proposal(3180, 100)!.candidateMs).toBe(44);
  expect(p.cadence(3180)).toBe(2000);
  expect(p.cadence(40_000)).toBe(500);
  expect(p.proposal(40_000, 100)).toBeNull();
});
