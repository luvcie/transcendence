import { describe, expect, spyOn, test } from "bun:test";
import { Input } from "@42tris/core";
import { Match } from "@42tris/match";
import type { Checkpoint, ClientCommand, ServerMessage } from "@42tris/protocol";
import { decodeServerMessage } from "@42tris/protocol/client";
import { connectSession } from "./src/session-transport";
import { Session } from "./src/session";
import { SessionDiagnostics } from "./src/session-diagnostics";
import { NetHarness } from "./netplay-harness";

function checkpoint(): Checkpoint {
  return {
    type: "checkpoint", serverSequence: 1, serverNow: 12000, matchId: "match", state: new Match({ players: ["a", "b"], seed: 42 }).saveState(),
    room: { code: "ABCDEF", revision: 1, ownerId: "a", options: { firstTo: 3, width: 10, maxPlayers: 8, mode: "competitive", attacksEnabled: true },
      phase: "playing", matchId: "match", preparationId: 1, startsAt: null, prepareDeadline: null,
      players: ["a", "b"].map(playerId => ({ playerId, name: playerId, skin: "classic", connected: true, ready: true, prepared: true, deadline: null, withdrawn: false })) },
    owner: { generation: 0, epoch: 0, nextSeq: 2, resolvedThroughSeq: 0,
      pendingAccepted: [{ seq: 1, frame: 12, subframe: 0.25, input: Input.LeftDown, order: 1 }], rejections: [{ seq: 2, code: "STALE_INPUT" }] },
    clock: { currentTargetFrame: 12, simulationNow: 200, origin: 11800, pausedTotal: 0, commitDelayMs: 100, frozen: false },
    roundDurations: [{ round: 1, durationMs: 1234 }], events: [],
  };
}

class Socket extends EventTarget {
  readyState = WebSocket.CONNECTING;
  sent: string[] = [];
  listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  override addEventListener(type: string, listener: EventListenerOrEventListenerObject | null) {
    if (listener) {
      const listeners = this.listeners.get(type) ?? new Set();
      listeners.add(listener); this.listeners.set(type, listeners);
    }
    super.addEventListener(type, listener);
  }
  override removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null) {
    if (listener) this.listeners.get(type)?.delete(listener);
    super.removeEventListener(type, listener);
  }
  send(data: string) {
    if (this.readyState === WebSocket.CONNECTING) throw new DOMException("Still connecting", "InvalidStateError");
    if (this.readyState === WebSocket.OPEN) this.sent.push(data);
  }
  close() { this.readyState = WebSocket.CLOSING; }
  open() { this.readyState = WebSocket.OPEN; this.dispatchEvent(new Event("open")); }
  finish() { this.readyState = WebSocket.CLOSED; this.dispatchEvent(new Event("close")); }
  message(data: unknown) { this.dispatchEvent(new MessageEvent("message", { data })); }
  get listenerCount() { return [...this.listeners.values()].reduce((n, set) => n + set.size, 0); }
}

function harness(diagnostics?: SessionDiagnostics, origin = "https://example.test") {
  const socket = new Socket(), messages: ServerMessage[] = [];
  let opens = 0, closes = 0, url = "";
  const transport = connectSession(origin, { open() { opens++; }, message(value) { messages.push(value); }, close() { closes++; } },
    diagnostics, value => { url = value; return socket as unknown as WebSocket; });
  return { socket, transport, messages, url, opens: () => opens, closes: () => closes };
}

const cp = checkpoint();
const messages: ServerMessage[] = [
  { type: "welcome", guestSessionId: "guest", playerId: "a", resumeToken: "token", name: "A", room: cp.room, generation: 2, serverNow: 1000 },
  { type: "roomState", room: cp.room, serverNow: 1100, requestId: "request" }, cp,
  { type: "left" }, { type: "error", code: "ROOM_FULL", message: "Full", requestId: "request" },
  { type: "pong", nonce: "123.45", serverNow: 123456.789 },
];

describe("JSON session transport", () => {
  test.each([["https://example.test", "wss://example.test/ws"], ["http://localhost:4178", "ws://localhost:4178/ws"]])("maps %s to %s and delivers native open", (origin, url) => {
    const h = harness(undefined, origin);
    expect(h.url).toBe(url); expect(h.opens()).toBe(0);
    h.socket.open(); expect(h.opens()).toBe(1);
    h.transport.close(); h.socket.finish();
  });

  test.each(messages)("preserves the $type envelope and nested JSON values", value => {
    const h = harness(); h.socket.open();
    const data = JSON.stringify(value);
    const parse = spyOn(JSON, "parse");
    try {
      h.socket.message(data);
      expect(parse).toHaveBeenCalledTimes(1);
      expect(parse.mock.calls[0]).toEqual([data]);
      expect(h.messages).toEqual([value]);
    } finally { parse.mockRestore(); h.transport.close(); h.socket.finish(); }
  });

  test("preserves date-looking strings as strings and numeric timestamps as numbers", () => {
    const value = { ...messages[0], name: "2026-11-08" };
    expect(decodeServerMessage(JSON.stringify(value))).toEqual(value);
  });

  test.each(["not JSON", "{", "null", "42", "true", "[]", "{}", '{"type":"future"}', '{"type":"pong"}',
    '{"type":"welcome","room":{}}', JSON.stringify({ ...cp, owner: {} }), JSON.stringify({ ...cp, clock: null }),
    JSON.stringify({ type: "roomState", room: { ...cp.room, players: [null] }, serverNow: 0 }),
    JSON.stringify({ type: "pong", nonce: "x", serverNow: "123" }), new Blob(["{}"]), new ArrayBuffer(8)])("ignores malformed/non-protocol payload %# without changing connection state", data => {
    const h = harness(); h.socket.open(); h.socket.message(data);
    expect(h.messages).toEqual([]); expect(h.closes()).toBe(0);
    h.socket.message('{"type":"left"}'); expect(h.messages).toEqual([{ type: "left" }]);
    h.transport.close(); h.socket.finish();
  });

  test("serializes commands exactly as Eden's object send, including optional fields and input timestamps", () => {
    const h = harness(); h.socket.open();
    const commands: ClientCommand[] = [{ type: "hello", name: "Étoile", resumeToken: undefined },
      { type: "ping", nonce: "123.45" }, { type: "inputBatch", matchId: "match", generation: 3, epoch: 2,
        items: [{ seq: 7, frame: 123, subframe: 0.375, input: Input.RotateCw }] }];
    commands.forEach(h.transport.send);
    expect(h.socket.sent).toEqual(commands.map(command => JSON.stringify(command)));
    h.transport.close(); h.socket.finish();
  });

  test("delegates send unchanged in every native readyState without buffering or retrying", () => {
    const h = harness(); const command = { type: "leave" } as const;
    expect(() => h.transport.send(command)).toThrow("Still connecting");
    h.socket.open(); expect(h.socket.sent).toEqual([]);
    h.transport.send(command); h.transport.close(); h.transport.send(command);
    h.socket.finish(); h.transport.send(command);
    expect(h.socket.sent).toEqual([JSON.stringify(command)]);
  });

  test.each([false, true])("cleans up on close, explicit=%s, with only one close callback", explicit => {
    const h = harness(new SessionDiagnostics()); h.socket.open();
    if (explicit) {
      h.transport.close(); h.transport.close();
      expect(h.socket.listenerCount).toBe(1);
      expect(h.closes()).toBe(0);
      h.socket.message('{"type":"left"}'); h.socket.dispatchEvent(new Event("open"));
    }
    h.socket.finish(); h.socket.finish();
    expect(h.socket.listenerCount).toBe(0); expect(h.closes()).toBe(1); expect(h.opens()).toBe(1); expect(h.messages).toEqual([]);
  });

  test("closing during connection suppresses queued open/message events and still reports native close", () => {
    const h = harness(); h.transport.close(); h.socket.open(); h.socket.message('{"type":"left"}'); h.socket.finish();
    expect(h.opens()).toBe(0); expect(h.messages).toEqual([]); expect(h.closes()).toBe(1); expect(h.socket.listenerCount).toBe(0);
  });

  test("counts raw diagnostics once, after delivery, with no second parse", () => {
    const diagnostics = new SessionDiagnostics();
    const record = spyOn(diagnostics, "receivedMessage");
    const h = harness(diagnostics); h.socket.open();
    const value = { ...messages[0], name: "Étoile" }, data = JSON.stringify(value);
    const parse = spyOn(JSON, "parse");
    try {
      h.socket.message(data);
      expect(parse).toHaveBeenCalledTimes(1); expect(record).toHaveBeenCalledTimes(1);
      expect(record.mock.calls[0][0]).toBeGreaterThan(0); expect(record.mock.calls[0][1]).toBe(data);
      expect(h.messages).toEqual([value]);
      h.socket.message("malformed"); expect(record).toHaveBeenCalledTimes(2);
      const stats = diagnostics.snapshot().transport;
      expect(stats.bytesPerSec / stats.messagesPerSec).toBeCloseTo((new TextEncoder().encode(data).byteLength + 9) / 2);
      expect(stats.maxMessageBytes).toBe(new TextEncoder().encode(data).byteLength);
      h.transport.close(); h.socket.message(data); expect(record).toHaveBeenCalledTimes(2);
      h.socket.finish(); expect(h.socket.listenerCount).toBe(0);
    } finally { parse.mockRestore(); record.mockRestore(); }
  });

  test("raw diagnostics run after the application callback", () => {
    const order: string[] = [], socket = new Socket(), diagnostics = new SessionDiagnostics();
    const record = spyOn(diagnostics, "receivedMessage").mockImplementation(() => { order.push("raw"); });
    try {
      const transport = connectSession("http://localhost", { open() {}, message() { order.push("message"); }, close() {} },
        diagnostics, () => socket as unknown as WebSocket);
      socket.open(); socket.message('{"type":"left"}');
      expect(order).toEqual(["message", "raw"]);
      transport.close(); socket.finish();
    } finally { record.mockRestore(); }
  });

  test("diagnostics-off installs only one message listener", () => {
    const h = harness(); expect(h.socket.listeners.get("message")!.size).toBe(1);
    h.transport.close(); h.socket.finish();
  });

  test("disposed sockets cannot mutate a reconnected Session, even with captured stale callbacks", () => {
    const sockets: Socket[] = [];
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem(key: string, value: string) { values.set(key, value); }, removeItem(key: string) { values.delete(key); } };
    const session = new Session({ now: () => 0, storage, profile: storage, clearKeys() {},
      connect(callbacks) { return connectSession("http://localhost", callbacks, undefined, () => {
        const socket = new Socket(); sockets.push(socket); return socket as unknown as WebSocket;
      }); } });
    session.start(); sockets[0].open(); sockets[0].message(JSON.stringify(messages[0]));
    const stale = [...sockets[0].listeners.get("message")!][0] as EventListener;
    session.retry(); sockets[1].open(); sockets[1].message(JSON.stringify({ ...messages[0], playerId: "new" }));
    stale(new MessageEvent("message", { data: JSON.stringify(messages[0]) })); sockets[0].finish();
    expect(session.connected).toBe(true); expect(session.playerId).toBe("new");
    session.stop(); sockets[1].finish(); expect(sockets.every(socket => socket.listenerCount === 0)).toBe(true);
  });
});

test("JSON transport preserves deterministic adaptive calibration, inputs, reconciliation and round decisions", () => {
  function run(decode: boolean) {
    const h = new NetHarness({ seed: 42, diagnostics: true, inputLeadMs: { a: "auto", b: "auto" },
      a: { up: 150, down: 150, jitter: 10 }, b: { up: 20, down: 20 } });
    const transports: { socket: Socket; transport: ReturnType<typeof connectSession> }[] = [];
    if (decode) for (const client of h.clients) {
      const receive = client.session.receive.bind(client.session);
      const socket = new Socket();
      const transport = connectSession("http://localhost", { open() {}, message: receive, close() {} }, undefined,
        () => socket as unknown as WebSocket);
      client.session.receive = value => socket.message(JSON.stringify(value));
      socket.open();
      transports.push({ socket, transport });
    }
    h.startMatch();
    const firstLead = h.a.diagnostics!.snapshot().lead.appliedMs;
    expect(firstLead).toBeGreaterThan(0);
    h.playScript("a", 3000, 8); h.playScript("b", 3000, 9); h.advance(3500);
    expect(h.a.diagnostics!.snapshot().lead.appliedMs).toBe(firstLead);
    expect(h.a.batches.length).toBeGreaterThan(5);
    expect(h.a.session.checkpoint!.owner.resolvedThroughSeq).toBeGreaterThan(0);
    expect(h.a.diagnostics!.snapshot().corrections.compared).toBeGreaterThan(0);
    h.dropOut("b");
    h.runUntil(() => h.a.session.checkpoint!.state!.round === 2, 10000);
    h.runUntil(() => h.a.session.canPlay, 10000);
    expect(h.a.diagnostics!.snapshot().adaptive.decisions).toHaveLength(2);
    const result = { state: h.room!.match!.saveState(), checkpoints: h.clients.map(c => c.session.checkpoint),
      pending: h.clients.map(c => c.session.pending), batches: h.clients.map(c => c.batches),
      timing: h.clients.map(c => { const d = c.diagnostics!.snapshot(); return { lead: d.lead, adaptive: d.adaptive, rtt: d.rtt, clock: d.clock, corrections: d.corrections }; }) };
    for (const { transport, socket } of transports) { transport.close(); socket.finish(); }
    return result;
  }
  expect(run(true)).toEqual(run(false));
});
