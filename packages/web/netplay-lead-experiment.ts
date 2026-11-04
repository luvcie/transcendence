import { verifyMatchReplayExecution } from "@42tris/replay";
import { NetplayMetrics, type Admission } from "../server/src/netplay-metrics";
import { NetHarness, type NetHarnessOptions } from "./netplay-harness";

export interface LeadExperiment {
  name: string;
  options: NetHarnessOptions;
  /** Withhold application pongs for the first two seconds of physical play. */
  coldClock?: boolean;
  beforeScript?(h: NetHarness): unknown;
}

export const leadExperiments: LeadExperiment[] = [
  { name: "40 omitted", options: { players: [{ up: 20, down: 20 }, { up: 20, down: 20 }] } },
  ...[
    [40, 0], [180, 0], [180, 44], [200, 0], [200, 60], [300, 0],
    [300, 100], [300, 104], [300, 120], [350, 0], [350, 160],
  ].map(([rtt, lead]) => ({ name: `${rtt} lead ${lead}`, options: {
    players: [{ up: rtt / 2, down: rtt / 2 }, { up: 20, down: 20 }], inputLeadMs: { a: lead },
  } })),
  ...[0, 84].flatMap(lead => [[20, 180], [180, 20]].map(([up, down]) => ({
    name: `${up}/${down} lead ${lead}`, options: { players: [{ up, down }, { up: 20, down: 20 }], inputLeadMs: { a: lead } },
  }))),
  ...[0, 120].map(lead => ({ name: `60 spikes lead ${lead}`, options: {
    players: [{ up: 30, down: 30, spikeChance: 0.05, spikeMs: 150 }, { up: 20, down: 20 }], inputLeadMs: { a: lead },
  } })),
  ...[false, true].map(enabled => ({ name: `mixed ${enabled ? "lead" : "zero"}`, options: {
    players: [20, 60, 180, 300].map(rtt => ({ up: rtt / 2, down: rtt / 2 })),
    inputLeadMs: { a: 0, b: 0, c: enabled ? 44 : 0, d: enabled ? 104 : 0 },
  } })),
  ...[100, 104, 120].map(lead => ({ name: `300 cold lead ${lead}`, coldClock: true, options: {
    players: [{ up: 150, down: 150 }, { up: 20, down: 20 }], inputLeadMs: { a: lead },
  } })),
];

function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) => sorted.length ? sorted[Math.round((sorted.length - 1) * p)] : null;
  return { count: sorted.length, p5: at(0.05), p50: at(0.5), p95: at(0.95), max: sorted.at(-1) ?? null };
}

/** All samples are retained for these bounded 30-second experiments, including startup. */
export async function runLeadExperiment(scenario: LeadExperiment) {
  const h = new NetHarness({ seed: 42, diagnostics: true, messageHistory: 16,
    commandHistory: Infinity, batchHistory: Infinity, ...scenario.options });
  const admissions: { player: string; result: Admission; calibrated: boolean }[] = [];
  const margins = h.clients.map(() => [] as number[]);
  const ages = h.clients.map(() => [] as number[]);
  let clockChecks = 0, clockViolations = 0;
  const tick = h.rooms.tick.bind(h.rooms);
  h.rooms.tick = () => {
    tick();
    const room = h.room;
    if (room?.phase !== "playing" || !room.match || room.match.ended || room.origin === null) return;
    const paced = Math.floor(Math.max(0, h.time - room.origin - room.pausedTotal - 100) / (1000 / 60));
    clockChecks++;
    if (room.match.frame !== paced) clockViolations++;
  };
  const metrics = new NetplayMetrics(0, { log() {}, cpuUsage: () => ({ user: 0, system: 0 }) });
  metrics.admission = (_room, seat, result) => {
    const player = (seat as { id: string }).id;
    const client = h.clients.find(c => c.session.playerId === player)!;
    admissions.push({ player, result, calibrated: client.diagnostics!.snapshot().clock.calibrated });
  };
  h.rooms.metrics = metrics;
  const serverErrors = h.clients.map(() => ({} as Record<string, number>));
  let allowPongs = !scenario.coldClock;
  for (const [index, client] of h.clients.entries()) {
    const send = client.peer!.send;
    client.peer!.send = (message, ephemeral) => {
      if (message.type === "error") serverErrors[index][message.code] = (serverErrors[index][message.code] ?? 0) + 1;
      if (message.type !== "pong" || allowPongs) send(message, ephemeral);
    };
    const diagnostics = client.diagnostics!;
    const margin = diagnostics.inputMargin.bind(diagnostics);
    diagnostics.inputMargin = (stamp, committed) => { margins[index].push(stamp - committed); margin(stamp, committed); };
    const checkpoint = diagnostics.checkpoint.bind(diagnostics);
    diagnostics.checkpoint = (at, info) => {
      if (info.estimatedOffset !== undefined) ages[index].push(at + info.estimatedOffset - info.serverNow);
      checkpoint(at, info);
    };
  }
  h.startMatch();
  const start = h.time;
  const setup = scenario.beforeScript?.(h);
  ages.forEach(samples => { samples.length = 0; });
  // The ordinary matrix already calibrates during preparation/countdown. Cold
  // scenarios explicitly retain welcome-only timing into active play.
  const calibratedAtStart = h.clients.map(c => c.diagnostics!.snapshot().clock.calibrated);
  for (const client of h.clients) h.playScript(client.key, 30_000, 8);
  h.advance(2000);
  allowPongs = true;
  h.advance(28_500); // Include every in-flight input; no warm-up samples are removed.
  const journal = await h.room!.recorder!.buildIncompleteReplay();
  if (!journal) throw new Error("Missing competitive replay prefix");
  const verified = await verifyMatchReplayExecution(journal);
  const replayVerified = JSON.stringify(verified.state) === JSON.stringify(h.room!.match!.saveState());
  const results = h.clients.map((client, index) => {
    const own = admissions.filter(a => a.player === client.session.playerId);
    const admission = (samples: typeof own) => {
      const accepted = samples.filter(a => a.result === "accepted").length;
      return { total: samples.length, accepted, acceptedPct: samples.length ? accepted / samples.length * 100 : null,
        late: samples.filter(a => a.result === "late").length,
        future: samples.filter(a => a.result === "future").length,
        other: samples.filter(a => a.result !== "accepted" && a.result !== "late" && a.result !== "future").length };
    };
    const snapshot = client.diagnostics!.snapshot();
    return { client: client.key, serverErrors: serverErrors[index], inputItemsSent: client.traffic.inputItems,
      adaptive: snapshot.adaptive, link: scenario.options.players![index], lead: snapshot.lead,
      calibratedAtStart: calibratedAtStart[index], whole: admission(own),
      beforePong: admission(own.filter(a => !a.calibrated)), afterPong: admission(own.filter(a => a.calibrated)),
      resets: Object.entries(snapshot.releases.byReason).reduce((sum, [reason, count]) =>
        sum + (reason === "user" || reason === "wrong-phase" ? 0 : count), 0),
      releases: snapshot.releases, recoveries: snapshot.staleRecovery,
      blockedPct: client.control.eligibleMs ? client.control.blockedMs / client.control.eligibleMs * 100 : 0,
      marginMs: distribution(margins[index]), checkpointAgeMs: distribution(ages[index]),
      clock: snapshot.clock, corrections: snapshot.corrections };
  });
  return { h, journal, result: { name: scenario.name, seed: 42, scriptSeed: 8,
    durationMs: h.time - start, setup, replayVerified, clockChecks, clockViolations, clients: results } };
}
