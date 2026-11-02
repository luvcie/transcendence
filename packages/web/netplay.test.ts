import { expect, test } from "bun:test";
import { DEFAULT_HANDLING, Input } from "@42tris/core";
import { createClient } from "@42tris/protocol/client";
import { createApp } from "../server/src/app";
import { Session } from "./src/session";

test("real Eden sessions play, resume, undo, reset, finish a set and explicitly rematch", async () => {
  const app = createApp().listen({ hostname: "127.0.0.1", port: 0 });
  const origin = `http://127.0.0.1:${app.server!.port}`;
  const errors: string[] = [];
  const sessions: Session[] = [];
  const make = () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
    const session = new Session({ now: () => performance.now(), storage, profile: storage, clearKeys() {},
      connect(callbacks) {
        const socket = createClient(origin).ws.subscribe();
        socket.on("open", callbacks.open); socket.on("close", callbacks.close);
        socket.subscribe(({ data }) => {
          if (data.type === "error") errors.push(`${data.code}: ${data.message}`);
          callbacks.message(data);
        });
        return { send: command => socket.send(command), close: () => socket.close() };
      },
    });
    sessions.push(session); session.start(); return session;
  };
  const wait = async (condition: () => boolean, label: string, timeout = 6000) => {
    const end = performance.now() + timeout;
    while (!condition()) {
      if (performance.now() > end) throw new Error(`Timed out: ${label}; ${sessions.map(s => `${s.status} ${s.room?.phase}`).join(" / ")}; ${errors}`);
      await Bun.sleep(10);
    }
  };
  const timer = setInterval(() => sessions.forEach(s => s.tick()), 8);
  try {
    const a = make(), b = make();
    await wait(() => a.connected && b.connected, "welcome");
    expect(a.playerId).not.toBe(b.playerId);
    a.send({ type: "create", requestId: "web-integration", options: { firstTo: 3, maxPlayers: 4, mode: "practice", attacksEnabled: true } });
    await wait(() => !!a.room, "create");
    b.send({ type: "join", code: a.room!.code });
    await wait(() => b.room?.players.length === 2, "join");
    for (const session of [a, b]) session.send({ type: "ready", ready: true, handling: DEFAULT_HANDLING });
    await wait(() => a.canPlay && b.canPlay, "prepared/countdown/play");
    const x = a.prediction!.gameState().state.x;
    a.input(Input.LeftDown); a.input(Input.LeftUp);
    expect(a.prediction!.gameState().state.x).toBe(x - 1);
    await wait(() => a.checkpoint!.owner.resolvedThroughSeq >= 2, "input acknowledgement");
    expect(a.prediction!.gameState().state.x).toBe(x - 1);
    a.input(Input.HardDrop);
    await wait(() => a.checkpoint!.state!.players[a.checkpoint!.state!.roster.indexOf(a.playerId)].game.lastResult !== null, "lock");
    const epoch = a.checkpoint!.owner.epoch;
    a.practice("practiceUndo");
    await wait(() => a.checkpoint!.owner.epoch > epoch && a.canPlay, "authoritative undo");
    const playerId = b.playerId;
    b.stop();
    await wait(() => a.room?.phase === "paused", "pause");
    const frozen = a.prediction!.atMs;
    await Bun.sleep(120);
    expect(a.prediction!.atMs).toBe(frozen);
    expect(a.room!.players.find(p => p.playerId === playerId)!.deadline).not.toBeNull();
    b.start();
    await wait(() => a.canPlay && b.canPlay, "resume preparation/countdown");
    expect(b.playerId).toBe(playerId);
    const generation = a.checkpoint!.owner.generation;
    a.input(Input.LeftDown); a.release();
    await wait(() => a.checkpoint!.owner.generation > generation && a.canPlay, "release");
    expect(a.prediction!.gameState().state.leftHeld).toBe(false);
    const resetEpoch = a.checkpoint!.owner.epoch;
    a.practice("practiceReset");
    await wait(() => a.checkpoint!.owner.epoch > resetEpoch && a.canPlay, "reset");
    a.send({ type: "leave" });
    await wait(() => !a.room && b.room?.phase === "waiting", "leave");
    b.send({ type: "configure", options: { firstTo: 1, maxPlayers: 4, mode: "competitive", attacksEnabled: true } });
    await wait(() => b.room?.options.mode === "competitive", "configure competitive");
    a.send({ type: "join", code: b.room!.code });
    await wait(() => a.room?.players.length === 2, "rejoin");
    for (const session of [a, b]) session.send({ type: "ready", ready: true, handling: DEFAULT_HANDLING });
    await wait(() => a.canPlay && b.canPlay, "competitive start");
    for (let i = 0; i < 24 && a.room?.phase === "playing"; i++) {
      a.input(Input.HardDrop);
      await Bun.sleep(120);
    }
    await wait(() => a.room?.phase === "setResult" && b.room?.phase === "setResult" && !!a.checkpoint?.state?.complete, "competitive result");
    expect(a.checkpoint!.state!.complete).toBe(true);
    expect(a.checkpoint!.state!.scores[a.checkpoint!.state!.roster.indexOf(b.playerId)]).toBe(1);
    const matchId = a.checkpoint!.matchId;
    await Bun.sleep(100);
    expect(a.room!.phase).toBe("setResult");
    for (const session of [a, b]) session.send({ type: "ready", ready: true, handling: DEFAULT_HANDLING });
    await wait(() => a.canPlay && b.canPlay, "explicit rematch");
    expect(a.checkpoint!.matchId).not.toBe(matchId);
    expect(a.checkpoint!.state!.scores).toEqual([0, 0]);
    b.send({ type: "leave" });
    await wait(() => a.checkpoint?.room.phase === "setResult", "forfeit result");
    expect(a.checkpoint!.events.some(({ event }) => event.type === "setEnd" && event.reason === "forfeit" && event.winner === a.playerId)).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    clearInterval(timer); sessions.forEach(s => s.stop()); await app.stop();
  }
}, 25000);
