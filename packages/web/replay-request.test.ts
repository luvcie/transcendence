import { expect, test } from "bun:test";
import { DEFAULT_REPLAY_LIMITS } from "@42tris/replay";
import { requestCompetitiveReplay, ReplayRequestError } from "./src/replay-request";
import { recordedSet } from "./replay-fixture";

for (const status of [202, 409, 404, 403, 500]) {
  test(`retrieval handles HTTP ${status} without constructing playback`, async () => {
    let requests = 0;
    const request = (async () => { requests++; return new Response("{}", { status }); }) as typeof fetch;
    const error = await requestCompetitiveReplay("ABCDEF", "secret", new AbortController().signal, request).catch(error => error);
    expect(error).toBeInstanceOf(ReplayRequestError);
    expect(error.status).toBe(status);
    expect(error.message.length).toBeGreaterThan(15);
    expect(requests).toBe(1);
  });
}

test("retrieval uses header-only credentials, verifies the artifact and binds original appearance to its match ID", async () => {
  const { replay } = await recordedSet(3);
  const original = structuredClone(replay);
  const calls: { url: string; options?: RequestInit }[] = [];
  const request = (async (url: string, options?: RequestInit) => {
    calls.push({ url, options });
    return Response.json(calls.length === 1 ? replay : {
      matchId: replay.id, names: { p0: "Ada", p1: "Bea" }, skinIds: { p0: "four", p1: "tetrio", p2: "custom:0" },
    });
  }) as typeof fetch;
  const result = await requestCompetitiveReplay("ABCDEF", "secret", new AbortController().signal, request);
  expect(calls.map(call => call.url)).toEqual(["/api/rooms/ABCDEF/replay", "/api/rooms/ABCDEF/replay/appearance"]);
  expect(calls.every(call => (call.options?.headers as Record<string, string>).Authorization === "Bearer secret")).toBe(true);
  expect(calls.every(call => call.options?.cache === "no-store")).toBe(true);
  expect(result.playback.state.roster).toEqual(["p0", "p1", "p2"]);
  expect(result.appearance.names).toEqual({ p0: "Ada", p1: "Bea", p2: "p2" });
  expect(result.appearance.skinIds?.p0).toBe("four");
  expect(result.appearance.skinIds?.p2).toBe("classic");
  expect(replay).toEqual(original);
});

test("retrieval rejects an oversized stream before JSON decoding", async () => {
  const request = (async () => new Response("{}", { headers: { "Content-Length": String(DEFAULT_REPLAY_LIMITS.maxBytes + 1) } })) as typeof fetch;
  await expect(requestCompetitiveReplay("ABCDEF", "secret", new AbortController().signal, request)).rejects.toThrow("size limit");
});

test("retrieval rejects corrupted replay and stale appearance after a rematch", async () => {
  const { replay } = await recordedSet();
  const request = (async (url: string) => Response.json(url.endsWith("appearance") ? { matchId: "next-set" } : replay)) as typeof fetch;
  await expect(requestCompetitiveReplay("ABCDEF", "secret", new AbortController().signal, request)).rejects.toThrow("another set");
  replay.summary.winner = "p1";
  await expect(requestCompetitiveReplay("ABCDEF", "secret", new AbortController().signal, request)).rejects.toThrow();
});

test("network errors and cancellation do not open a playback", async () => {
  const request = (async () => { throw new TypeError("Network offline"); }) as typeof fetch;
  await expect(requestCompetitiveReplay("ABCDEF", "secret", new AbortController().signal, request)).rejects.toThrow("Network offline");
  const abort = new AbortController(); abort.abort();
  const cancelled = (async (_url: string, init?: RequestInit) => { init?.signal?.throwIfAborted(); return new Response(); }) as typeof fetch;
  await expect(requestCompetitiveReplay("ABCDEF", "secret", abort.signal, cancelled)).rejects.toThrow();
});

test("streaming byte limits cancel a body even without a Content-Length header", async () => {
  let cancelled = false;
  const request = (async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(DEFAULT_REPLAY_LIMITS.maxBytes + 1)); },
    cancel() { cancelled = true; },
  }))) as typeof fetch;
  await expect(requestCompetitiveReplay("ABCDEF", "secret", new AbortController().signal, request)).rejects.toThrow("size limit");
  expect(cancelled).toBe(true);
});

for (const status of [202, 409, 404, 403]) {
  test(`appearance HTTP ${status} cannot open a replay after membership or room changes`, async () => {
    const { replay } = await recordedSet();
    const request = (async (url: string) => url.endsWith("appearance") ? new Response("{}", { status }) : Response.json(replay)) as typeof fetch;
    const error = await requestCompetitiveReplay("ABCDEF", "secret", new AbortController().signal, request).catch(error => error);
    expect(error).toBeInstanceOf(ReplayRequestError);
    expect(error.status).toBe(status);
  });
}
