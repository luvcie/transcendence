import { expect, test } from "bun:test";
import { FRAME_MS, Input } from "@42tris/core";
import { Match } from "@42tris/match";
import type { Checkpoint } from "@42tris/protocol";
import { Session } from "./src/session";

test("session input and render ticks sample the current injected clock", () => {
  let now = 0;
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
  const session = new Session({
    now: () => now, storage, profile: storage, clearKeys() {},
    connect: () => ({ send() {}, close() {} }),
  });
  session.start();
  session.receive({ type: "welcome", guestSessionId: "a", playerId: "a", resumeToken: "token",
    name: "A", room: null, generation: 0, serverNow: 0 });
  const checkpoint: Checkpoint = {
    type: "checkpoint", serverSequence: 1, serverNow: 0, matchId: "clock-test",
    state: new Match({ players: ["a", "b"], seed: 108 }).saveState(),
    room: {
      code: "ABCDEF", revision: 1, ownerId: "a",
      options: { firstTo: 3, maxPlayers: 4, mode: "competitive", attacksEnabled: true },
      phase: "playing", matchId: "clock-test", preparationId: 1, startsAt: null, prepareDeadline: null,
      players: ["a", "b"].map(playerId => ({ playerId, name: playerId, connected: true,
        ready: true, prepared: true, deadline: null, withdrawn: false })),
    },
    owner: { generation: 0, epoch: 0, nextSeq: 1, resolvedThroughSeq: 0, pendingAccepted: [], rejections: [] },
    clock: { currentTargetFrame: 0, simulationNow: 0, origin: 0, pausedTotal: 0, commitDelayMs: 100, frozen: false },
    events: [],
  };
  session.receive(checkpoint);
  now = 100;
  session.tick();
  expect(session.prediction!.gameState().state.observedNow).toBe(100);

  now = 116.9;
  session.input(Input.RotateCw);
  const input = session.pending[0];
  expect((input.frame + input.subframe) * FRAME_MS).toBeCloseTo(116.9, 12);
  expect(session.prediction!.gameState().state.rot).toBe(1);

  // A RAF callback can receive 116.6 after the input at 116.9. Session.tick
  // samples its own clock; it does not consume a callback timestamp.
  const renderTick: FrameRequestCallback = session.tick.bind(session);
  now = 117;
  expect(() => renderTick(116.6)).not.toThrow();
  expect(session.prediction!.atMs).toBe(117);
  expect(session.prediction!.gameState().state.observedNow).toBe(117);
  now = 133;
  renderTick(116.6);
  expect(session.prediction!.gameState().state.observedNow).toBe(133);
  session.stop();
});
