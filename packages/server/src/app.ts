import { Elysia, ValidationError } from "elysia";
import { staticPlugin } from "@elysiajs/static";
import { resolve } from "node:path";
import { ClientCommandSchema, ServerMessageSchema, type ServerMessage } from "@42tris/protocol";
import { NetplayMetrics } from "./netplay-metrics";
import { Rooms, type Peer } from "./rooms";
import { createSkinSource } from "./skin-source";

export interface ServerOptions {
  rooms?: Rooms;
  origins?: string[];
  production?: boolean;
  assets?: string;
  scheduled?: boolean;
}
interface SocketLease {
  peer: Peer;
  ping(): void;
  lastPong: number;
  lastPing: number;
  messageTokens: number;
  messageAt: number;
}

export function createApp(options: ServerOptions = {}) {
  const rooms = options.rooms ?? new Rooms();
  if (process.env.NETPLAY_METRICS === "1") rooms.metrics ??= new NetplayMetrics(rooms.now());
  const metrics = rooms.metrics;
  const skinSource = createSkinSource();
  const sockets = new Map<string, SocketLease>();
  const rawLeases = new WeakMap<object, SocketLease>();
  const attempts = new Map<string, { count: number; since: number }>();
  const allowed = new Set(options.origins ?? (options.production ? [] : ["http://localhost:5173", "http://127.0.0.1:5173"]));
  let scheduler: ReturnType<typeof setInterval> | undefined;
  let snapshots: ReturnType<typeof setInterval> | undefined;
  let metricsTimer: ReturnType<typeof setInterval> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const app = new Elysia({ websocket: { maxPayloadLength: 4096, backpressureLimit: 256 * 1024, closeOnBackpressureLimit: true, idleTimeout: 10 }, normalize: false })
    .onBeforeHandle(({ request, server }) => {
      const origin = request.headers.get("origin");
      const url = new URL(request.url);
      if (url.pathname !== "/ws") return;
      if (origin && origin !== url.origin && !allowed.has(origin)) return new Response("ORIGIN_REJECTED", { status: 403 });
      // Forwarded headers are deliberately ignored; the direct peer is the rate key.
      const ip = server?.requestIP(request)?.address ?? "unknown";
      const now = rooms.now();
      for (const [key, value] of attempts) if (now - value.since >= 10_000) attempts.delete(key);
      const attempt = attempts.get(ip) ?? { count: 0, since: now };
      if (sockets.size >= 128 || (!attempts.has(ip) && attempts.size >= 1024)) return new Response("CAPACITY", { status: 503 });
      if (++attempt.count > 20) return new Response("RATE_LIMIT", { status: 429 });
      attempts.set(ip, attempt);
    })
    .get("/api/health", () => ({ ok: true as const, protocol: 1 as const, serverNow: rooms.now() }))
    .get("/api/skin-source", ({ query }) => skinSource(query.path))
    .get("/api/rooms/:code/replay", ({ params, request }) => {
      const authorization = request.headers.get("authorization");
      const access = rooms.replayAccess(params.code, authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined);
      const status = { ready: 200, pending: 202, failed: 409, unavailable: 404, unauthorized: 403 }[access.status];
      return new Response(access.status === "ready" ? access.json : JSON.stringify(access), {
        status,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Vary": "Authorization" },
      });
    })
    .get("/api/rooms/:code/replay/appearance", ({ params, request }) => {
      const authorization = request.headers.get("authorization");
      const access = rooms.replayAccess(params.code, authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined);
      const status = { ready: 200, pending: 202, failed: 409, unavailable: 404, unauthorized: 403 }[access.status];
      return new Response(access.status === "ready" ? JSON.stringify(rooms.rooms.get(params.code)?.replayAppearance) : JSON.stringify(access), {
        status,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Vary": "Authorization" },
      });
    })
    .ws("/ws", {
      body: ClientCommandSchema,
      response: ServerMessageSchema,
      open(ws) {
        const raw = ws.raw;
        const peer: Peer = {
          id: ws.id,
          send(message: ServerMessage, ephemeral = false) {
            // Leave the queued packet alone; a later 20Hz snapshot supplies the latest state.
            if (ephemeral && (raw as unknown as Bun.ServerWebSocket<unknown>).getBufferedAmount() > 64 * 1024) {
              if (metrics) rooms.recordTransmission(ws.id, 0, message.type === "checkpoint", true);
              return;
            }
            const payload = JSON.stringify(message);
            raw.send(payload);
            if (metrics) rooms.recordTransmission(ws.id, Buffer.byteLength(payload, "utf8"), message.type === "checkpoint");
          },
          close(code, reason) { raw.close(code, reason); },
        };
        if (!rooms.connect(peer)) return;
        const lease = { peer, ping: () => { raw.ping(); }, lastPong: performance.now(), lastPing: performance.now(), messageTokens: 80, messageAt: performance.now() };
        sockets.set(ws.id, lease);
        rawLeases.set(raw, lease);
      },
      parse(ws) {
        const lease = rawLeases.get(ws);
        if (!lease) return;
        const now = performance.now();
        lease.messageTokens = Math.min(80, lease.messageTokens + (now - lease.messageAt) * 40 / 1000);
        lease.messageAt = now;
        if (lease.messageTokens < 1) {
          lease.peer.close(1008, "RATE_LIMIT");
          rooms.disconnect(lease.peer.id);
          sockets.delete(lease.peer.id);
        } else lease.messageTokens--;
      },
      message(ws, command) { rooms.receive(ws.id, command); },
      // Elysia 1.4.30 passes the raw Bun socket to pong, despite its ElysiaWS type.
      pong(ws) { const lease = rawLeases.get(ws); if (lease) lease.lastPong = performance.now(); },
      close(ws) { sockets.delete(ws.id); rooms.disconnect(ws.id); },
      error({ error }) {
        if (error instanceof ValidationError) return { type: "error", code: "INVALID_MESSAGE", message: "Message does not match the protocol" } satisfies ServerMessage;
        console.error("WebSocket handler failed", error);
        return { type: "error", code: "INTERNAL_ERROR", message: "Server handler failed" } satisfies ServerMessage;
      },
    })
    .onStart(() => {
      if (options.scheduled !== false) {
        scheduler = setInterval(() => rooms.tick(), 10);
        snapshots = setInterval(() => rooms.snapshots(), 50);
      }
      if (metrics) metricsTimer = setInterval(() => metrics.report(rooms.rooms.values(), rooms.now()), 10_000);
      heartbeat = setInterval(() => {
        const now = performance.now();
        for (const [id, lease] of sockets) {
          if (now - lease.lastPong >= 6000) {
            lease.peer.close(1001, "HEARTBEAT_TIMEOUT");
            sockets.delete(id);
            rooms.disconnect(id);
          } else if (now - lease.lastPing >= 2000) { lease.ping(); lease.lastPing = now; }
        }
      }, 250);
    })
    .onStop(() => {
      clearInterval(scheduler);
      clearInterval(snapshots);
      clearInterval(heartbeat);
      clearInterval(metricsTimer);
      for (const lease of sockets.values()) { rooms.disconnect(lease.peer.id); lease.peer.close(1001, "SERVER_STOP"); }
      sockets.clear();
    });
  if (options.production) app.use(staticPlugin({ assets: options.assets ?? resolve(import.meta.dir, "../../web/dist"), prefix: "/", alwaysStatic: true, indexHTML: true, decodeURI: false }));
  return app;
}

export type App = ReturnType<typeof createApp>;
