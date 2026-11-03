import { DEFAULT_REPLAY_LIMITS, decodeReplayJson, isMatchReplay, MatchPlayback } from "@42tris/replay";
import { shareableSkinId } from "./multiplayer-skins";

export class ReplayRequestError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const messages: Record<number, string> = {
  202: "Replay is still being verified. Try again shortly.",
  409: "This match could not be recorded.",
  404: "Replay unavailable. The room may have expired or started another set.",
  403: "Replay access lost. Reconnect with your original guest in this room.",
};

async function boundedText(response: Response, maxBytes: number): Promise<string> {
  if (Number(response.headers.get("content-length")) > maxBytes) {
    await response.body?.cancel();
    throw new Error("Replay exceeds the size limit.");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Empty replay response.");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new Error("Replay exceeds the size limit.");
      chunks.push(value);
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
  const data = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder("utf-8", { fatal: true }).decode(data);
}

export async function requestCompetitiveReplay(code: string, token: string, signal: AbortSignal, request: typeof fetch = fetch) {
  signal = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
  const headers = { Authorization: `Bearer ${token}` };
  const base = `/api/rooms/${encodeURIComponent(code)}/replay`;
  const response = await request(base, { headers, signal, cache: "no-store" });
  if (response.status !== 200) throw new ReplayRequestError(response.status, messages[response.status] ?? "Cannot retrieve replay. Try again.");
  const replay = await decodeReplayJson(await boundedText(response, DEFAULT_REPLAY_LIMITS.maxBytes));
  if (!isMatchReplay(replay)) throw new Error("Only completed competitive replays can be watched.");
  const playback = await MatchPlayback.create(replay);
  signal.throwIfAborted();
  const metadata = await request(`${base}/appearance`, { headers, signal, cache: "no-store" });
  if (metadata.status !== 200) throw new ReplayRequestError(metadata.status, messages[metadata.status] ?? "Cannot retrieve replay appearance. Try again.");
  const value = JSON.parse(await boundedText(metadata, 8192));
  if (!value || value.matchId !== replay.id) throw new Error("The room started another set. Replay unavailable.");
  const names: Record<string, string> = Object.create(null);
  const skinIds: Record<string, string> = Object.create(null);
  for (const id of playback.state.roster) {
    const name = value.names?.[id], skin = value.skinIds?.[id];
    names[id] = typeof name === "string" && name.length <= 24 ? name : id;
    skinIds[id] = typeof skin === "string" ? shareableSkinId(skin) : "classic";
  }
  signal.throwIfAborted();
  return { playback, summary: replay.summary, appearance: { names, skinIds } };
}
