import { cpus } from "node:os";
import { verifyMatchReplayExecution } from "@42tris/replay";
import type { Checkpoint } from "@42tris/protocol";
import { NetHarness } from "../../web/netplay-harness";
import { useLegacyCheckpoints } from "./checkpoint-baseline";

const legacy = process.argv.includes("--legacy");
const encoder = new TextEncoder();
const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];

async function measure(count: number) {
  const h = new NetHarness({ seed: 42, players: Array.from({ length: count }, () => ({ up: 20, down: 20 })),
    diagnostics: true, messageHistory: 0, commandHistory: 0, batchHistory: 0 });
  if (legacy) useLegacyCheckpoints(h.rooms);
  h.startMatch({ firstTo: 100 });
  let chunk = 0;
  const play = (ms: number) => {
    h.clients.forEach((c, i) => h.playScript(c.key, ms, 200 + i + chunk * 101));
    chunk++;
    h.advance(ms);
  };
  while (h.room!.eventSequence < 320 || h.room!.phase !== "playing") {
    if (h.time > 180_000) throw new Error("History did not mature");
    play(5000);
  }
  const warmupMs = h.time;
  const beforeBytes = h.clients.map(c => c.traffic.downBytes);
  const beforeInputs = h.clients.map(c => c.traffic.inputItems);
  const beforeRejections = h.clients.map(c => c.diagnostics!.snapshot().rejections.total);
  const sizes: number[] = [];
  const cpu = { server: 0, tick: 0, receive: 0, periodic: 0, saveState: 0, stringify: 0, advance: 0 };
  let saveCalls = 0, active = false;
  for (const method of ["tick", "receive", "snapshots"] as const) {
    const original = h.rooms[method].bind(h.rooms);
    // The wrappers preserve each public method's argument list.
    Object.defineProperty(h.rooms, method, { configurable: true, value: (...args: never[]) => {
      const start = performance.now();
      active = true;
      try { return (original as (...args: never[]) => unknown)(...args); }
      finally {
        active = false;
        const elapsed = performance.now() - start;
        cpu.server += elapsed;
        cpu[method === "snapshots" ? "periodic" : method] += elapsed;
      }
    } });
  }
  const match = h.room!.match!;
  const save = match.saveState.bind(match), advance = match.advanceToFrame.bind(match);
  match.saveState = () => {
    const start = performance.now();
    try { return save(); } finally { if (active) { cpu.saveState += performance.now() - start; saveCalls++; } }
  };
  match.advanceToFrame = frame => {
    const start = performance.now();
    try { return advance(frame); } finally { if (active) cpu.advance += performance.now() - start; }
  };
  const stringify = JSON.stringify;
  JSON.stringify = ((value: unknown, ...args: unknown[]) => {
    const checkpoint = active && (value as Checkpoint | null)?.type === "checkpoint";
    const start = checkpoint ? performance.now() : 0;
    const payload = (stringify as (...args: unknown[]) => string)(value, ...args);
    if (checkpoint) {
      cpu.stringify += performance.now() - start;
      sizes.push(Buffer.byteLength(payload, "utf8"));
    }
    return payload;
  }) as typeof JSON.stringify;
  const wall = performance.now();
  try { for (let i = 0; i < 6; i++) play(5000); }
  finally { JSON.stringify = stringify; }
  const harnessWallMs = performance.now() - wall;
  const replay = await h.room!.recorder!.buildIncompleteReplay();
  if (!replay) throw new Error("No replay");
  const verification = await verifyMatchReplayExecution(replay);
  if (stringify(verification.state) !== stringify(match.saveState())) throw new Error("Replay diverged");

  // Repeat the actual broadcast on one unchanged mature state. Each send serializes
  // its own complete payload, just as app.ts does, without transport/client work.
  let broadcastSaves = 0;
  let lastPayload = "";
  let snapshot: Checkpoint | undefined;
  const peers = h.room!.seats.map(s => s.peer!);
  const sends = peers.map(p => p.send);
  peers.forEach(p => { p.send = message => {
    lastPayload = stringify(message);
    snapshot = message as Checkpoint;
  }; });
  match.saveState = () => { broadcastSaves++; return save(); };
  const samples: number[] = [];
  try {
    for (let run = 0; run < 8; run++) {
      broadcastSaves = 0;
      const start = performance.now();
      for (let i = 0; i < 500; i++) h.rooms.broadcastCheckpoint(h.room!);
      const msPerSimSecond = (performance.now() - start) / 500 * 20;
      if (run > 0) samples.push(msPerSimSecond);
    }
  } finally { peers.forEach((p, i) => { p.send = sends[i]; }); match.saveState = save; match.advanceToFrame = advance; }
  const downstream = h.clients.map((c, i) => (c.traffic.downBytes - beforeBytes[i]) / 30);
  return { players: count, warmupMs, measuredMs: 30_000, generatedEvents: h.room!.eventSequence,
    internalEvents: h.room!.events.length, checkpointBytes: { p50: percentile(sizes, 0.5), p95: percentile(sizes, 0.95), max: Math.max(...sizes),
      mature: encoder.encode(lastPayload).byteLength, matureEvents: snapshot!.events.length, matureEventBytes: encoder.encode(stringify(snapshot!.events)).byteLength },
    downstreamBytesPerSec: downstream,
    acceptance: { checkpointSize: Math.max(...sizes) < (count === 2 ? 8000 : 30_000),
      downstream: downstream.every(bytes => bytes <= (count === 2 ? 150_000 : 600_000)) },
    inputItems: h.clients.map((c, i) => c.traffic.inputItems - beforeInputs[i]),
    rejections: h.clients.map((c, i) => c.diagnostics!.snapshot().rejections.total - beforeRejections[i]),
    checkpointCount: sizes.length, saveCalls, serverMsPerSimSecond: Object.fromEntries(Object.entries(cpu).map(([k, v]) => [k, v / 30])),
    broadcastBenchmark: { broadcasts: 500, samples: 7, savesPerBroadcast: broadcastSaves / 500,
      msPerSimSecond: percentile(samples, 0.5), min: Math.min(...samples), max: Math.max(...samples) },
    harnessWallMs, replayVerified: true, finalRound: match.round };
}

console.log(JSON.stringify({ runtime: Bun.version, cpu: cpus()[0]?.model, legacy, seed: 42, results: [await measure(2), await measure(8)] }, null, 2));
