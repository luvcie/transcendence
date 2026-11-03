import { describe, expect, spyOn, test } from "bun:test";
import { FRAME_MS, GARBAGE, Input, Piece, type GameState } from "@42tris/core";
import { Match, OwnerPrediction } from "@42tris/match";
import type { Checkpoint } from "@42tris/protocol";
import { verifyMatchReplayExecution } from "@42tris/replay";
import { NetHarness } from "./netplay-harness";
import { classifyCorrection, SessionDiagnostics } from "./src/session-diagnostics";

function seqs(harness: NetHarness): number[] {
  return harness.a.batches.flatMap(batch => batch.items.map(item => item.seq));
}

function ownerState(harness: NetHarness) {
  const checkpoint = harness.a.session.checkpoint!;
  const index = checkpoint.state!.roster.indexOf(harness.a.session.playerId);
  return checkpoint.state!.players[index].game;
}

function quad(game: GameState) {
  game.board.fill(0);
  Object.assign(game.state, { piece: Piece.I, rot: 1, x: 2, y: 18 });
  for (let y = 36; y < 40; y++) {
    game.board.fill(Piece.L, y * 10, (y + 1) * 10);
    game.board[y * 10 + 4] = 0;
  }
}

function converged(harness: NetHarness): boolean {
  const { prediction, checkpoint, playerId } = harness.a.session;
  const authoritative = new OwnerPrediction(checkpoint!.state!, playerId);
  authoritative.advanceToTime(prediction!.atMs);
  return JSON.stringify(prediction!.gameState()) === JSON.stringify(authoritative.gameState());
}

function transmitted(harness: NetHarness): number[] {
  return harness.a.batches.flatMap(batch => batch.items.map(item => item.input));
}

function expectSequenceOwnership(harness: NetHarness) {
  const owned = new Map<string, unknown>();
  for (const batch of harness.a.batches) for (const item of batch.items) {
    const key = `${batch.matchId}:${batch.generation}:${item.seq}`;
    if (owned.has(key)) expect(item).toEqual(owned.get(key));
    else owned.set(key, item);
  }
}

describe("netplay latency and stalls", () => {
  test("stable low latency applies each accepted input exactly once without corrections", () => {
    const h = new NetHarness({ diagnostics: true });
    h.startMatch();
    h.press("a", Input.LeftDown);
    h.advance(50);
    h.press("a", Input.LeftUp);
    h.advance(300);
    h.runUntil(() => h.a.session.pending.length === 0, 2000);

    expect(seqs(h)).toEqual([1, 2]);
    // Local bookkeeping such as the sent/transmitted flags must not reach the wire.
    expect(Object.keys(h.a.batches[0].items[0]).sort()).toEqual(["frame", "input", "seq", "subframe"]);
    const checkpoint = h.a.session.checkpoint!;
    expect(checkpoint.owner.rejections).toEqual([]);
    expect(checkpoint.owner.resolvedThroughSeq).toBe(2);
    expect(ownerState(h).state.leftHeld).toBe(false);
    expect(h.a.session.canPlay).toBe(true);

    const diagnostics = h.a.diagnostics!.snapshot();
    expect(diagnostics.rejections.total).toBe(0);
    expect(diagnostics.releases.total).toBe(0);
    expect(diagnostics.inputs.queued).toBe(2);
    expect(diagnostics.inputs.sent).toBe(2);
    expect(diagnostics.inputs.maxQueueMs).not.toBeNull();
    expect(diagnostics.corrections.total).toBe(0);
    expect(JSON.parse(JSON.stringify(diagnostics))).toEqual(diagnostics);
  });

  test("one hard drop locks exactly one piece on the authoritative board", () => {
    const h = new NetHarness({ diagnostics: true });
    h.startMatch();
    const playerId = h.a.session.playerId;
    const lockCount = () => h.room!.events.filter(entry =>
      entry.event.type === "lock" && entry.event.player === playerId).length;
    const locks = lockCount();
    const sequence = ownerState(h).state.sequence;

    h.press("a", Input.HardDrop);
    h.runUntil(() => h.a.session.pending.length === 0, 2000);
    h.runUntil(() => lockCount() === locks + 1, 2000);
    h.advance(300);

    expect(lockCount()).toBe(locks + 1);
    expect(ownerState(h).state.sequence).toBe(sequence + 1);
    expect(seqs(h)).toEqual([1]);
    expect(h.a.diagnostics!.snapshot().rejections.total).toBe(0);
  });

  test("180 ms round trip keeps every input accepted and prediction authoritative", () => {
    const h = new NetHarness({ diagnostics: true, a: { up: 90, down: 90 }, b: { up: 90, down: 90 } });
    h.startMatch();
    for (let i = 0; i < 20; i++) {
      h.press("a", i % 2 ? Input.LeftUp : Input.LeftDown);
      h.advance(60);
    }
    h.runUntil(() => h.a.session.pending.length === 0, 4000);

    expect(seqs(h)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(new Set(seqs(h)).size).toBe(20);
    const diagnostics = h.a.diagnostics!.snapshot();
    expect(diagnostics.rejections.total).toBe(0);
    expect(diagnostics.releases.total).toBe(0);
    expect(diagnostics.rtt.last).toBeGreaterThanOrEqual(160);
    expect(diagnostics.rtt.last).toBeLessThanOrEqual(200);
    expect(diagnostics.corrections.total).toBe(0);
    expect(h.a.session.canPlay).toBe(true);
  });

  test("seeded jitter preserves stream order and applies each input once", () => {
    const h = new NetHarness({ diagnostics: true, seed: 7, a: { up: 60, down: 60, jitter: 25 } });
    h.startMatch();
    for (let i = 0; i < 16; i++) {
      h.press("a", i % 2 ? Input.LeftUp : Input.LeftDown);
      h.advance(70);
    }
    h.runUntil(() => h.a.session.pending.length === 0, 4000);

    expect(seqs(h)).toEqual(Array.from({ length: 16 }, (_, i) => i + 1));
    expect(new Set(seqs(h)).size).toBe(16);
    const sequences = h.a.messages.filter(message => message.type === "checkpoint")
      .map(message => message.serverSequence);
    expect([...sequences].sort((left, right) => left - right)).toEqual(sequences);
    const diagnostics = h.a.diagnostics!.snapshot();
    expect(diagnostics.rejections.total).toBe(0);
    expect(diagnostics.releases.total).toBe(0);
    expect(diagnostics.corrections.total).toBe(0);
  });

  test("a 400 ms browser stall pauses frames, timers and checkpoints without duplicate sends", () => {
    const h = new NetHarness({ diagnostics: true });
    h.startMatch();
    h.press("a", Input.LeftDown);
    h.advance(40);
    h.press("a", Input.LeftUp);
    h.advance(40);
    expect(seqs(h)).toEqual([1, 2]);

    h.stall("a", 400);
    h.advance(100);
    h.press("a", Input.RightDown);
    h.advance(100);
    h.press("a", Input.RightUp);
    h.advance(200);
    h.runUntil(() => h.a.session.pending.length === 0, 2000);

    const diagnostics = h.a.diagnostics!.snapshot();
    expect(diagnostics.frames.maxGapMs).toBeGreaterThanOrEqual(390);
    expect(diagnostics.checkpoints.maxGapMs).toBeGreaterThanOrEqual(390);
    expect(diagnostics.releases.total).toBe(0);
    expect(diagnostics.rejections.total).toBe(0);
    expect(seqs(h)).toEqual([1, 2, 3, 4]);
    expect(new Set(seqs(h)).size).toBe(4);
    expect(h.a.session.canPlay).toBe(true);
    expect(ownerState(h).state.rightHeld).toBe(false);
  });

  test("a 2.5 s stall suspends play, requests resync, and recovers without stuck controls", () => {
    const h = new NetHarness({ diagnostics: true });
    h.startMatch();
    h.press("a", Input.LeftDown);
    h.advance(40);
    h.press("a", Input.LeftUp);
    h.advance(40);

    h.stall("a", 2500);
    h.holdDownstream("a", 2600);
    h.advance(2500);
    expect(h.a.session.canPlay).toBe(false);
    expect(h.a.commands.some(command => command.type === "resync")).toBe(true);
    expect(h.a.diagnostics!.snapshot().releases.total).toBe(0);

    h.advance(200);
    h.runUntil(() => h.a.session.canPlay, 2000);
    const diagnostics = h.a.diagnostics!.snapshot();
    expect(diagnostics.frames.maxGapMs).toBeGreaterThanOrEqual(2400);
    expect(diagnostics.checkpoints.maxGapMs).toBeGreaterThanOrEqual(2400);

    h.press("a", Input.RightDown);
    h.advance(40);
    h.press("a", Input.RightUp);
    h.runUntil(() => h.a.session.pending.length === 0, 2000);
    expect(seqs(h).slice(-2)).toEqual([3, 4]);
    expect(new Set(seqs(h)).size).toBe(4);
    expect(ownerState(h).state.rightHeld).toBe(false);
    const checkpoint = h.a.session.checkpoint!;
    expect(checkpoint.owner.rejections).toEqual([]);
    expect(checkpoint.owner.resolvedThroughSeq).toBe(4);
  });

  test("a stall between a key event and its trailing flush re-issues the release instead of resetting", () => {
    const h = new NetHarness({ diagnostics: true });
    h.startMatch();
    const generation = h.a.session.checkpoint!.owner.generation;
    h.press("a", Input.LeftDown);
    h.advance(5);
    h.press("a", Input.LeftUp); // inside the 34 ms throttle: only a trailing timer holds it
    h.stall("a", 300);
    h.advance(300);

    const diagnostics = h.a.diagnostics!.snapshot();
    expect(diagnostics.releases.total).toBe(0);
    expect(diagnostics.staleRecovery).toEqual({ count: 1, retracted: 1, reissued: 1 });
    expect(diagnostics.rejections.total).toBe(0);
    expect(h.a.commands.filter(command => command.type === "releaseControls")).toHaveLength(0);
    expect(h.a.session.checkpoint!.owner.generation).toBe(generation);

    h.runUntil(() => h.a.session.pending.length === 0, 2000);
    expect(seqs(h)).toEqual([1, 2]);
    expect(h.a.session.checkpoint!.owner.rejections).toEqual([]);
    expect(ownerState(h).state.leftHeld).toBe(false);
    expect(converged(h)).toBe(true);
  });

  test("asymmetric upstream latency produces late inputs, server rejections, and one control reset", () => {
    const h = new NetHarness({ diagnostics: true, a: { up: 250, down: 10 }, b: { up: 10, down: 10 } });
    h.startMatch();
    h.press("a", Input.LeftDown);
    h.advance(5);
    h.press("a", Input.LeftUp);
    h.runUntil(() => {
      const current = h.a.diagnostics!.snapshot();
      return current.releases.total === 1 && current.rejections.total >= 1;
    }, 3000);

    const diagnostics = h.a.diagnostics!.snapshot();
    expect(diagnostics.rejections.byCode.INPUT_REJECTED).toBeGreaterThanOrEqual(1);
    expect(diagnostics.releases.total).toBe(1);
    expect(h.a.commands.filter(command => command.type === "releaseControls")).toHaveLength(1);
    // Reliable downstream lets the client's stale-frame check fire no later than
    // the authoritative rejection, so either reason is evidence of the same reset.
    const reasons = Object.keys(diagnostics.releases.byReason);
    expect(reasons).toHaveLength(1);
    expect(["stale-prediction", "rejected-input"]).toContain(reasons[0]);
    const release = diagnostics.events.find(event => event.type === "release");
    const rejection = diagnostics.events.find(event => event.type === "rejection" && event.code === "INPUT_REJECTED");
    expect(release).toBeDefined();
    expect(rejection).toBeDefined();
    expect(release!.at).toBeLessThanOrEqual(rejection!.at);
    h.runUntil(() => h.a.session.canPlay, 2000);
    expect(ownerState(h).state.leftHeld).toBe(false);
    expect(ownerState(h).state.rightHeld).toBe(false);
    expect(new Set(seqs(h)).size).toBe(seqs(h).length);
  });

  test("a delayed checkpoint burst is applied in order without false corrections", () => {
    const h = new NetHarness({ diagnostics: true });
    h.startMatch();
    h.press("a", Input.LeftDown);
    h.advance(40);
    h.press("a", Input.LeftUp);
    h.advance(200);
    const before = h.a.session.checkpoint!.serverSequence;
    h.holdDownstream("a", 400);
    h.advance(400);
    h.advance(100);
    h.runUntil(() => h.a.session.pending.length === 0, 2000);

    expect(h.a.session.checkpoint!.serverSequence).toBeGreaterThan(before + 4);
    const sequences = h.a.messages.filter(message => message.type === "checkpoint")
      .map(message => message.serverSequence);
    expect([...sequences].sort((left, right) => left - right)).toEqual(sequences);
    expect(new Set(sequences).size).toBe(sequences.length);
    const diagnostics = h.a.diagnostics!.snapshot();
    expect(diagnostics.releases.total).toBe(0);
    expect(diagnostics.rejections.total).toBe(0);
    expect(diagnostics.checkpoints.maxGapMs).toBeGreaterThanOrEqual(390);
    expect(diagnostics.corrections.total).toBe(0);
    expect(h.a.session.canPlay).toBe(true);
  });

  test("round and generation changes queued during a hold isolate stale traffic", () => {
    const h = new NetHarness({ diagnostics: true });
    h.startMatch({ firstTo: 2 });
    h.dropOut("b");
    expect(h.room!.phase).toBe("roundResult");
    h.advance(100);
    expect(h.a.session.room!.phase).toBe("roundResult");
    const oldGeneration = h.a.session.checkpoint!.owner.generation;
    const batchesBefore = h.a.batches.length;

    h.holdDownstream("a", 3500);
    h.press("a", Input.LeftDown); // stale roundResult view: gameplay is suspended
    h.advance(3600);
    expect(h.a.batches.length).toBe(batchesBefore);
    h.runUntil(() => h.a.session.canPlay && h.a.session.checkpoint?.state?.round === 2, 4000);

    const checkpoint = h.a.session.checkpoint!;
    expect(checkpoint.state!.round).toBe(2);
    expect(checkpoint.owner.generation).toBeGreaterThan(oldGeneration);
    expect(h.a.session.prediction!.round).toBe(2);

    h.press("a", Input.RightDown);
    h.advance(40);
    h.press("a", Input.RightUp);
    h.runUntil(() => h.a.session.pending.length === 0, 2000);
    const fresh = h.a.batches.slice(batchesBefore);
    expect(fresh.flatMap(batch => batch.items.map(item => item.seq))).toEqual([1, 2]);
    expect(fresh.every(batch => batch.generation === checkpoint.owner.generation)).toBe(true);
    expect(ownerState(h).state.rightHeld).toBe(false);
  });

  test("opponent garbage near a local lock is classified as a correction without releasing controls", () => {
    const h = new NetHarness({ diagnostics: true });
    h.startMatch({ mode: "practice", attacksEnabled: true });
    const room = h.room!;
    const aId = h.a.session.playerId;
    const bId = h.b.session.playerId;
    const state = room.match!.saveState();
    quad(state.players[state.roster.indexOf(bId)].game);
    room.match = Match.fromState(state);
    h.advance(100);

    h.press("b", Input.HardDrop);
    h.runUntil(() => room.match!.saveState().players[state.roster.indexOf(aId)].garbage.packets.length > 0, 2000);
    h.advance(400);
    h.press("a", Input.HardDrop);
    h.advance(120);
    h.press("a", Input.HardDrop);
    h.runUntil(() => room.match!.playerState(aId).board.some(cell => cell === GARBAGE), 3000);
    h.runUntil(() => h.a.session.pending.length === 0, 2000);
    h.advance(200);

    const diagnostics = h.a.diagnostics!.snapshot();
    expect(diagnostics.corrections.garbage + diagnostics.corrections.board).toBeGreaterThan(0);
    expect(diagnostics.releases.total).toBe(0);
    expect(diagnostics.rejections.total).toBe(0);
    expect(h.a.session.canPlay).toBe(true);

    const prediction = h.a.session.prediction!;
    const checkpoint = h.a.session.checkpoint!;
    const authoritative = new OwnerPrediction(checkpoint.state!, aId);
    authoritative.advanceToTime(prediction.atMs);
    expect(prediction.gameState().board).toEqual(authoritative.gameState().board);
    expect(prediction.gameState().board.some(cell => cell === GARBAGE)).toBe(true);
  });
});

describe("stale input recovery", () => {
  test("a 500 ms stall during a rapid press and release keeps controls neutral", () => {
    const h = new NetHarness({ diagnostics: true });
    h.startMatch();
    h.press("a", Input.LeftDown); // flushed at once, then accepted
    h.advance(5);
    h.press("a", Input.LeftUp); // the rest sit behind the 34 ms throttle
    h.advance(5);
    h.press("a", Input.RightDown);
    h.advance(5);
    h.press("a", Input.RightUp);
    h.stall("a", 500);
    h.advance(500);

    const diagnostics = h.a.diagnostics!.snapshot();
    expect(diagnostics.releases.total).toBe(0);
    // Only the last transition per control survives, so the tap does not replay
    // as a stray one-cell move.
    expect(diagnostics.staleRecovery).toEqual({ count: 1, retracted: 3, reissued: 1 });

    h.runUntil(() => h.a.session.pending.length === 0, 2000);
    expect(transmitted(h)).toEqual([Input.LeftDown, Input.LeftUp]);
    expect(ownerState(h).state.leftHeld).toBe(false);
    expect(ownerState(h).state.rightHeld).toBe(false);
    expect(converged(h)).toBe(true);
  });

  test("an unsent stale hard drop is dropped, not replayed onto a later piece", () => {
    const h = new NetHarness({ diagnostics: true });
    h.startMatch();
    const playerId = h.a.session.playerId;
    const locks = () => h.room!.events.filter(entry => entry.event.type === "lock" && entry.event.player === playerId).length;
    const before = locks();
    h.press("a", Input.LeftDown);
    h.advance(5);
    h.press("a", Input.HardDrop); // queued behind the throttle when the stall starts
    h.advance(5);
    h.stall("a", 300);
    h.advance(300);

    expect(h.a.diagnostics!.snapshot().releases.total).toBe(0);
    expect(h.a.diagnostics!.snapshot().staleRecovery).toEqual({ count: 1, retracted: 1, reissued: 0 });
    expect(transmitted(h)).toEqual([Input.LeftDown]);
    expect(locks()).toBe(before);

    // The retracted sequence number is reused, not skipped: the server still
    // expects it next, so the following batch stays contiguous.
    h.press("a", Input.RightDown);
    h.advance(60);
    h.press("a", Input.RightUp);
    h.runUntil(() => h.a.session.pending.length === 0, 2000);
    expect(h.a.session.checkpoint!.owner.rejections).toEqual([]);
    expect(h.a.batches.flatMap(batch => batch.items).filter(item => item.input === Input.RightDown)
      .map(item => item.seq)).toEqual([2]);
    expect(ownerState(h).state.rightHeld).toBe(false);
    expect(converged(h)).toBe(true);
  });

  test("an unsent stale rotation is dropped instead of rotating the current piece later", () => {
    const h = new NetHarness({ diagnostics: true });
    h.startMatch();
    const rot = ownerState(h).state.rot;
    h.press("a", Input.LeftDown);
    h.advance(5);
    h.press("a", Input.RotateCw);
    h.advance(5);
    h.stall("a", 300);
    h.advance(300);

    expect(h.a.diagnostics!.snapshot().releases.total).toBe(0);
    expect(h.a.diagnostics!.snapshot().staleRecovery).toEqual({ count: 1, retracted: 1, reissued: 0 });
    expect(transmitted(h)).toEqual([Input.LeftDown]);
    expect(ownerState(h).state.rot).toBe(rot);

    h.press("a", Input.RotateCw);
    h.runUntil(() => h.a.session.pending.length === 0, 2000);
    expect(ownerState(h).state.rot).toBe((rot + 1) & 3);
  });

  test("a direction held through a stall stays held and releases when the key does", () => {
    const h = new NetHarness({ diagnostics: true });
    h.startMatch();
    h.press("a", Input.LeftDown);
    h.advance(40);
    h.stall("a", 300);
    h.advance(300);

    expect(h.a.diagnostics!.snapshot().staleRecovery.count).toBe(0);
    expect(h.a.diagnostics!.snapshot().releases.total).toBe(0);
    expect(ownerState(h).state.leftHeld).toBe(true);

    h.press("a", Input.LeftUp);
    h.runUntil(() => h.a.session.pending.length === 0, 2000);
    expect(ownerState(h).state.leftHeld).toBe(false);
    expect(ownerState(h).state.direction).toBe(0);
    expect(converged(h)).toBe(true);
  });

  test("soft drop held during a stall does not stay held after the key is released", () => {
    const h = new NetHarness({ diagnostics: true });
    h.startMatch();
    h.press("a", Input.SoftDropDown);
    h.advance(5);
    h.press("a", Input.SoftDropUp);
    h.advance(5);
    h.stall("a", 300);
    h.advance(300);

    expect(h.a.diagnostics!.snapshot().releases.total).toBe(0);
    expect(h.a.diagnostics!.snapshot().staleRecovery).toEqual({ count: 1, retracted: 1, reissued: 1 });
    h.runUntil(() => h.a.session.pending.length === 0, 2000);
    expect(transmitted(h)).toEqual([Input.SoftDropDown, Input.SoftDropUp]);
    expect(ownerState(h).state.softHeld).toBe(false);
    expect(converged(h)).toBe(true);
  });

  test("repeated stalls each recover without a generation reset", () => {
    const h = new NetHarness({ diagnostics: true });
    h.startMatch();
    const generation = h.a.session.checkpoint!.owner.generation;
    for (let i = 0; i < 3; i++) {
      h.advance(100);
      h.press("a", Input.LeftDown);
      h.advance(5);
      h.press("a", Input.LeftUp);
      h.stall("a", 300);
      h.advance(300);
      h.runUntil(() => h.a.session.pending.length === 0, 2000);
    }

    const diagnostics = h.a.diagnostics!.snapshot();
    expect(diagnostics.staleRecovery.count).toBe(3);
    expect(diagnostics.releases.total).toBe(0);
    expect(h.a.session.checkpoint!.owner.generation).toBe(generation);
    expect(seqs(h)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(ownerState(h).state.leftHeld).toBe(false);
    expect(converged(h)).toBe(true);
  });

  test("a transmitted but unacknowledged stale input still needs the full release", () => {
    const h = new NetHarness({ diagnostics: true, a: { up: 250, down: 10 }, b: { up: 10, down: 10 } });
    h.startMatch();
    h.press("a", Input.LeftDown);
    h.advance(5);
    h.press("a", Input.LeftUp);
    h.runUntil(() => h.a.diagnostics!.snapshot().releases.total === 1, 3000);

    const diagnostics = h.a.diagnostics!.snapshot();
    expect(diagnostics.staleRecovery.count).toBe(0);
    expect(h.a.commands.filter(command => command.type === "releaseControls")).toHaveLength(1);
    h.runUntil(() => h.a.session.canPlay, 2000);
    expect(ownerState(h).state.leftHeld).toBe(false);
  });
});

describe("post-stall input ordering", () => {
  test.each(["available", "rate-limited"] as const)("the 500 ms deadline releases once without frames or checkpoints when resync is %s", resync => {
    const h = new NetHarness({ diagnostics: true, frameMs: 10_000 });
    h.startMatch();
    const resynced = resync === "rate-limited";
    if (resynced) {
      h.a.session.receive({ type: "error", code: "SEQ_GAP", message: "Retry" });
      h.runUntil(() => h.a.session.canPlay);
    }
    const resyncs = h.a.commands.filter(c => c.type === "resync").length;
    const rejections = h.a.diagnostics!.snapshot().rejections.total;
    h.press("a", Input.LeftDown);
    h.advance(5);
    h.press("a", Input.LeftUp);
    h.stall("a", 300);
    h.holdDownstream("a", 1300);
    h.advance(300);
    expect(transmitted(h)).toEqual([Input.LeftDown]);
    expect(h.scheduledTimers("a")).toHaveLength(1);
    expect(h.a.commands.filter(c => c.type === "resync")).toHaveLength(resyncs + (resynced ? 0 : 1));
    const keysCleared = h.a.keysCleared;
    h.advance(499);
    expect(h.a.diagnostics!.snapshot().releases.total).toBe(0);
    h.advance(1);
    expect(h.a.diagnostics!.snapshot().releases.byReason).toEqual({ "stale-prediction": 1 });
    expect(h.a.keysCleared).toBe(keysCleared + 1);
    expect(h.a.session.pending).toEqual([]);
    expect(h.a.session.canPlay).toBe(false);
    expect(h.scheduledTimers("a")).toHaveLength(0);
    h.advance(20);
    expect(h.room!.match!.playerState(h.a.session.playerId).state.leftHeld).toBe(false);
    h.advance(600);
    expect(h.a.commands.filter(c => c.type === "releaseControls")).toHaveLength(1);
    expect(h.a.diagnostics!.snapshot().rejections.total).toBe(rejections);
    expect(transmitted(h)).toEqual([Input.LeftDown]);
    expect(h.a.session.canPlay).toBe(true);
    h.press("a", Input.RightDown);
    h.runUntil(() => h.a.session.pending.length === 0);
    expect(h.a.batches.at(-1)!.items[0].seq).toBe(1);
    expect(h.a.batches.at(-1)!.generation).toBeGreaterThan(h.a.batches[0].generation);
    expectSequenceOwnership(h);
  });

  test.each([300, 1000])("a %i ms stall defers the trailing timer until checkpoint recovery", duration => {
    const h = new NetHarness({ diagnostics: true });
    h.startMatch();
    const generation = h.a.session.checkpoint!.owner.generation;
    h.press("a", Input.LeftDown);
    h.advance(5);
    h.press("a", Input.LeftUp);
    const unsent = { ...h.a.session.pending.at(-1)! };
    h.stall("a", duration);
    h.holdDownstream("a", duration + 25);
    h.advance(duration);

    expect(transmitted(h)).toEqual([Input.LeftDown]);
    expect(h.a.session.pending.at(-1)).toEqual(unsent);
    expect(h.a.commands.filter(c => c.type === "resync")).toHaveLength(1);
    h.advance(25);
    h.runUntil(() => h.a.session.pending.length === 0, 2000);
    expect(h.a.diagnostics!.snapshot()).toMatchObject({
      staleRecovery: { count: 1, retracted: 1, reissued: 1 },
      rejections: { total: 0 }, releases: { total: 0 },
    });
    expect(h.a.session.checkpoint!.owner.generation).toBe(generation);
    expect(ownerState(h).state.leftHeld).toBe(false);
    expect(seqs(h)).toEqual([1, 2]);
    expect(converged(h)).toBe(true);
    const batches = h.a.batches.length;
    h.advance(600); // the former deferral deadline must have been cancelled
    expect(h.a.batches).toHaveLength(batches);
    expect(h.a.diagnostics!.snapshot().releases.total).toBe(0);
  });

  test("checkpoint freshness expiring during deferral cannot cancel its 500 ms fallback", () => {
    const h = new NetHarness({ diagnostics: true });
    h.startMatch();
    h.press("a", Input.LeftDown);
    h.advance(5);
    h.press("a", Input.LeftUp);
    h.stall("a", 1800);
    h.holdDownstream("a", 2800);
    h.advance(1800);
    expect(h.a.session.canPlay).toBe(true);
    expect(h.scheduledTimers("a")).toHaveLength(1);
    h.advance(499);
    expect(h.a.session.canPlay).toBe(false);
    expect(h.scheduledTimers("a")).toHaveLength(1);
    expect(h.a.diagnostics!.snapshot().releases.total).toBe(0);
    h.advance(1);
    expect(h.a.diagnostics!.snapshot().releases.byReason).toEqual({ "stale-prediction": 1 });
    expect(h.a.session.pending).toHaveLength(0);
    expect(h.scheduledTimers("a")).toHaveLength(0);
    h.advance(20);
    expect(h.room!.match!.playerState(h.a.session.playerId).state.leftHeld).toBe(false);
    h.advance(600);
    h.runUntil(() => h.a.session.canPlay);
    expect(h.a.commands.filter(c => c.type === "releaseControls")).toHaveLength(1);
    expect(h.a.diagnostics!.snapshot().rejections.total).toBe(0);
    expectSequenceOwnership(h);
  });

  test("a room update after checkpoint expiry cannot cancel the deferral deadline", () => {
    const h = new NetHarness({ diagnostics: true });
    h.startMatch();
    h.press("a", Input.LeftDown);
    h.advance(5);
    h.press("a", Input.LeftUp);
    h.stall("a", 1800);
    h.holdDownstream("a", 2800);
    h.advance(1800);
    const [deadline] = h.scheduledTimers("a");
    h.advance(250);
    expect(h.a.session.canPlay).toBe(false);
    // Cosmetic/readiness room updates do not refresh the simulation checkpoint.
    h.a.session.receive({ type: "roomState", room: h.rooms.view(h.room!) });
    expect(h.scheduledTimers("a")[0]?.at).toBe(deadline.at);
    h.advance(250);
    expect(h.a.diagnostics!.snapshot().releases.byReason).toEqual({ "stale-prediction": 1 });
    h.advance(20);
    expect(h.room!.match!.playerState(h.a.session.playerId).state.leftHeld).toBe(false);
    expect(h.a.session.pending).toHaveLength(0);
    expect(h.scheduledTimers("a")).toHaveLength(0);
    expectSequenceOwnership(h);
  });

  test.each(["timeout", "recovered"] as const)("partial recoveries retain the original 500 ms deadline: %s", outcome => {
    const h = new NetHarness({ diagnostics: true });
    h.startMatch();
    const checkpoints: Checkpoint[] = [];
    const send = h.a.peer!.send;
    h.a.peer!.send = message => {
      if (message.type === "checkpoint") checkpoints.push(message);
      else send(message);
    };
    h.holdDownstream("a", 3000);
    h.press("a", Input.LeftDown);
    h.advance(5);
    h.press("a", Input.LeftUp);
    const releaseFrame = h.a.session.pending.at(-1)!.frame;
    h.stall("a", 300);
    h.advance(300);
    const [deadline] = h.scheduledTimers("a");
    h.press("a", Input.RotateCw);
    const rotationFrame = h.a.session.pending.at(-1)!.frame;
    h.advance(95);
    h.press("a", Input.Hold);
    const holdFrame = h.a.session.pending.at(-1)!.frame;
    h.advance(255);

    // Deliver real checkpoints whose frames only validate a prefix of the tail.
    // Each rewrites the correction, but the rest is already late by the clock.
    h.a.session.receive(checkpoints.find(cp => cp.state!.frame > releaseFrame && cp.state!.frame < rotationFrame)!);
    h.advance(0);
    expect(h.scheduledTimers("a")[0].at).toBe(deadline.at);
    const [replacement] = h.scheduledTimers("a");
    deadline.run();
    expect(h.a.diagnostics!.snapshot().releases.total).toBe(0);
    h.advance(50);
    h.a.session.receive(checkpoints.find(cp => cp.state!.frame > rotationFrame && cp.state!.frame < holdFrame)!);
    h.advance(0);
    expect(h.scheduledTimers("a")[0].at).toBe(deadline.at);
    replacement.run();
    expect(h.a.diagnostics!.snapshot().releases.total).toBe(0);
    if (outcome === "recovered") {
      const [lastDeadline] = h.scheduledTimers("a");
      h.a.session.receive(checkpoints.at(-1)!);
      lastDeadline.run();
      h.advance(200);
      h.a.session.receive(checkpoints.at(-1)!);
      expect(h.a.diagnostics!.snapshot().releases.total).toBe(0);
      expect(transmitted(h)).toEqual([Input.LeftDown, Input.LeftUp]);
    } else {
      h.advance(100);
      expect(h.a.diagnostics!.snapshot().releases.byReason).toEqual({ "stale-prediction": 1 });
      expect(transmitted(h)).toEqual([Input.LeftDown]);
    }
    expect(h.a.session.pending).toHaveLength(0);
    expect(h.scheduledTimers("a")).toHaveLength(0);
    h.advance(20);
    expect(h.room!.match!.playerState(h.a.session.playerId).state.leftHeld).toBe(false);
    expectSequenceOwnership(h);
  });

  test("a key handler ahead of an overdue deadline cannot renew or transmit the deferred batch", () => {
    const h = new NetHarness({ diagnostics: true, inputFirst: true });
    h.startMatch();
    h.press("a", Input.LeftDown);
    h.advance(5);
    h.press("a", Input.LeftUp);
    h.stall("a", 300);
    h.holdDownstream("a", 1600);
    h.advance(300);
    const [deadline] = h.scheduledTimers("a");
    h.stall("a", 600);
    h.press("a", Input.RotateCw);
    h.advance(600);
    expect(h.a.diagnostics!.snapshot().releases.byReason).toEqual({ "stale-prediction": 1 });
    expect(h.a.session.pending).toHaveLength(0);
    expect(transmitted(h)).toEqual([Input.LeftDown]);
    expect(h.scheduledTimers("a")).toHaveLength(0);
    deadline.run();
    h.advance(20);
    expect(h.a.commands.filter(c => c.type === "releaseControls")).toHaveLength(1);
    expect(h.room!.match!.playerState(h.a.session.playerId).state.leftHeld).toBe(false);
    expectSequenceOwnership(h);
  });

  test("three corrective releases reserve only unused sequences before surviving one-shots", async () => {
    const h = new NetHarness({ diagnostics: true, inputFirst: true });
    h.startMatch();
    const generation = h.a.session.checkpoint!.owner.generation;
    h.press("a", Input.LeftDown);
    h.advance(34);
    h.press("a", Input.RightDown);
    h.advance(34);
    h.press("a", Input.SoftDropDown);
    h.advance(5);
    h.press("a", Input.LeftUp);
    h.press("a", Input.RightUp);
    h.press("a", Input.SoftDropUp);
    h.stall("a", 300);
    h.holdDownstream("a", 325);
    h.press("a", Input.RotateCw);
    h.press("a", Input.HardDrop);
    h.advance(325);
    const batch = h.a.batches.at(-1)!;
    expect(batch.items.map(i => i.input)).toEqual([
      Input.LeftUp, Input.RightUp, Input.SoftDropUp, Input.RotateCw, Input.HardDrop,
    ]);
    expect(batch.items.map(i => i.seq)).toEqual([4, 5, 6, 7, 8]);
    expect(batch.items.every(i => i.frame === batch.items[0].frame && i.subframe === batch.items[0].subframe)).toBe(true);
    h.runUntil(() => h.a.session.pending.length === 0);
    expect(ownerState(h).state).toMatchObject({ leftHeld: false, rightHeld: false, softHeld: false, sequence: 1 });
    expect(h.a.session.checkpoint!.owner.generation).toBe(generation);
    expect(h.a.diagnostics!.snapshot()).toMatchObject({ releases: { total: 0 }, rejections: { total: 0 },
      staleRecovery: { count: 1, retracted: 3, reissued: 3 } });
    expectSequenceOwnership(h);
    const journal = await h.room!.recorder!.buildIncompleteReplay();
    expect(journal).not.toBeNull();
    expect((await verifyMatchReplayExecution(journal!)).state).toEqual(h.room!.match!.saveState());
  });

  test("a key handler first recovers Left-up before newer rotation and hard drop at their original time", async () => {
    const h = new NetHarness({ diagnostics: true, inputFirst: true });
    h.startMatch();
    const generation = h.a.session.checkpoint!.owner.generation;
    h.press("a", Input.LeftDown);
    h.advance(5);
    h.press("a", Input.LeftUp);
    h.stall("a", 300);
    h.holdDownstream("a", 325);
    h.press("a", Input.RotateCw); // queued handler has priority over the stalled timer
    h.press("a", Input.HardDrop);
    h.advance(300);
    expect(transmitted(h)).toEqual([Input.LeftDown]);
    const actions = h.a.session.pending.filter(i => i.input === Input.RotateCw || i.input === Input.HardDrop)
      .map(({ seq, sent, transmitted, ...item }) => item);
    expect(actions).toHaveLength(2);
    const at = (actions[0].frame + actions[0].subframe) * FRAME_MS;
    h.advance(25);
    const checkpoint = h.a.session.checkpoint!;
    const batch = h.a.batches.at(-1)!;
    expect(batch.items.map(i => i.input)).toEqual([Input.LeftUp, Input.RotateCw, Input.HardDrop]);
    expect(batch.items.map(i => i.seq)).toEqual([2, 3, 4]);
    expect(batch.items.slice(1).map(({ seq, ...item }) => item)).toEqual(actions);
    expect((batch.items[0].frame + batch.items[0].subframe) * FRAME_MS).toBe(at);

    // Execute the same ordered inputs from the authority's pre-recovery state.
    // The journal and prediction must lock the same piece in the same cells.
    const replay = Match.fromState(checkpoint.state!);
    for (const item of batch.items) replay.submit({ ...item, player: h.a.session.playerId,
      order: item.seq, epoch: checkpoint.owner.epoch });
    h.runUntil(() => h.a.session.pending.length === 0, 2000);
    replay.advanceToFrame(h.a.session.checkpoint!.state!.frame);
    expect(ownerState(h)).toEqual(replay.playerState(h.a.session.playerId));
    expect(ownerState(h).state.sequence).toBe(checkpoint.state!.players[0].game.state.sequence + 1);
    expect(ownerState(h).board.some(cell => cell !== 0)).toBe(true);
    expect(ownerState(h).state.leftHeld).toBe(false);
    expect(h.a.session.checkpoint!.owner.generation).toBe(generation);
    expect(h.a.diagnostics!.snapshot()).toMatchObject({ releases: { total: 0 }, rejections: { total: 0 },
      staleRecovery: { count: 1, retracted: 1, reissued: 1 } });
    expect(converged(h)).toBe(true);
    expectSequenceOwnership(h);
    const journal = await h.room!.recorder!.buildIncompleteReplay();
    expect(journal).not.toBeNull();
    const verified = await verifyMatchReplayExecution(journal!);
    expect(verified.state).toEqual(h.room!.match!.saveState());
  });

  test.each([Input.HardDrop, Input.Hold, Input.RotateCw])("a newer one-shot %i that ages during deferral is dropped without retiming", input => {
    const h = new NetHarness({ diagnostics: true, inputFirst: true });
    h.startMatch();
    const sequence = ownerState(h).state.sequence;
    h.press("a", Input.LeftDown);
    h.advance(5);
    h.press("a", Input.LeftUp);
    h.stall("a", 300);
    h.holdDownstream("a", 525);
    h.press("a", input);
    h.advance(300);
    const [deadline] = h.scheduledTimers("a");
    h.advance(100);
    expect(h.scheduledTimers("a")[0].at).toBe(deadline.at);
    expect(h.a.commands.filter(c => c.type === "resync")).toHaveLength(1);
    h.advance(125);
    h.runUntil(() => h.a.session.pending.length === 0);
    expect(transmitted(h)).toEqual([Input.LeftDown, Input.LeftUp]);
    expect(ownerState(h).state.sequence).toBe(sequence);
    expect(ownerState(h).state.rot).toBe(0);
    expect(ownerState(h).state.leftHeld).toBe(false);
    expect(h.a.diagnostics!.snapshot()).toMatchObject({ releases: { total: 0 }, rejections: { total: 0 },
      // The queued checkpoint burst first recovers the old release, then drops
      // that still-unsent correction together with the now-stale one-shot.
      staleRecovery: { count: 2, retracted: 3, reissued: 2 } });
    expectSequenceOwnership(h);
  });

  test("a recovered release precedes a newer press of the same held control", () => {
    const h = new NetHarness({ diagnostics: true, inputFirst: true });
    h.startMatch();
    h.press("a", Input.LeftDown);
    h.advance(5);
    h.press("a", Input.LeftUp);
    h.stall("a", 300);
    h.holdDownstream("a", 325);
    h.press("a", Input.LeftDown);
    h.advance(325);
    expect(transmitted(h)).toEqual([Input.LeftDown, Input.LeftUp, Input.LeftDown]);
    const recovered = h.a.batches.at(-1)!.items;
    expect(recovered[0].frame).toBe(recovered[1].frame);
    expect(recovered[0].subframe).toBe(recovered[1].subframe);
    h.runUntil(() => h.a.session.pending.length === 0);
    expect(ownerState(h).state.leftHeld).toBe(true);
    h.press("a", Input.LeftUp);
    h.runUntil(() => h.a.session.pending.length === 0);
    expect(ownerState(h).state.leftHeld).toBe(false);
    expect(h.a.diagnostics!.snapshot()).toMatchObject({ releases: { total: 0 }, rejections: { total: 0 } });
    expectSequenceOwnership(h);
  });

  test("a gap retry stays transmitted and resends the original fingerprint even when the clock calls it stale", () => {
    const h = new NetHarness({ diagnostics: true });
    h.startMatch();
    h.holdDownstream("a", 400);
    h.press("a", Input.LeftDown);
    const original = structuredClone(h.a.batches[0].items[0]);
    h.advance(5);
    h.press("a", Input.LeftUp);
    // Reliable ordered transport cannot naturally create a gap. Inject a gap
    // response and an old ack while the real server still receives the original.
    h.a.session.receive({ type: "error", code: "SEQ_GAP", message: "Retry" });
    const cp = structuredClone(h.a.session.checkpoint!);
    cp.serverSequence++;
    h.a.session.receive(cp);
    expect(h.a.session.pending[0]).toMatchObject({ sent: false, transmitted: true });
    h.stall("a", 300);
    h.advance(300);
    expect(h.a.batches[1].items[0]).toEqual(original);
    expect(h.a.session.pending[0]).toMatchObject({ sent: true, transmitted: true });
    expect(h.scheduledTimers("a")).toHaveLength(0);
    h.advance(300);
    h.runUntil(() => h.a.session.canPlay && h.a.session.pending.length === 0);
    expect(h.a.diagnostics!.snapshot()).toMatchObject({ staleRecovery: { count: 0 }, releases: { total: 1 } });
    expect(h.a.messages.filter(m => m.type === "error" && m.code === "SEQ_CONFLICT")).toHaveLength(0);
    expect(ownerState(h).state.leftHeld).toBe(false);
    expectSequenceOwnership(h);
  });

  test.each(["stop", "reconnect", "generation", "epoch", "round", "match", "room", "match-state", "room-state", "paused", "frozen", "left"] as const)(
    "%s invalidates a deferred callback, including after fresh input is queued", change => {
      const h = new NetHarness({ diagnostics: true });
      h.startMatch();
      h.press("a", Input.LeftDown);
      h.advance(5);
      h.press("a", Input.LeftUp);
      h.stall("a", 300);
      h.holdDownstream("a", 1000);
      h.advance(300);
      const [deadline] = h.scheduledTimers("a");
      expect(deadline).toBeDefined();
      // Use real checkpoint shapes to exercise each identity component in
      // isolation; actual server pause/resume is covered separately below.
      const cp = structuredClone(h.a.session.checkpoint!);
      cp.serverSequence++;
      if (change === "stop") h.a.session.stop();
      else if (change === "reconnect") h.a.session.retry();
      else if (change === "left") h.a.session.receive({ type: "left" });
      else {
        if (change === "generation") cp.owner.generation++;
        if (change === "epoch") {
          cp.owner.epoch++;
          cp.state!.players[cp.state!.roster.indexOf(h.a.session.playerId)].epoch++;
        }
        if (change === "round") cp.state!.round++;
        if (change === "match" || change === "match-state") cp.matchId = cp.room.matchId = "new-match";
        if (change === "room" || change === "room-state") cp.room.code = "NEWROM";
        if (change === "paused") cp.room.phase = "paused";
        if (change === "frozen") cp.clock.frozen = true;
        h.a.session.receive(change === "match-state" || change === "room-state" ? { type: "roomState", room: cp.room } : cp);
      }
      expect(h.scheduledTimers("a")).toHaveLength(0);
      h.press("a", Input.RightDown);
      const pending = structuredClone(h.a.session.pending);
      const batches = h.a.batches.length;
      deadline.run(); // even an already-dispatched cancelled task is harmless
      expect(h.a.session.pending).toEqual(pending);
      expect(h.a.batches).toHaveLength(batches);
      expect(h.a.diagnostics!.snapshot().releases.total).toBe(0);
    });

  test.each(["a", "b"] as const)("a real %s disconnect and reconnect clear deferral before the room resumes", key => {
    const h = new NetHarness({ diagnostics: true });
    h.startMatch();
    h.press("a", Input.LeftDown);
    h.advance(5);
    h.press("a", Input.LeftUp);
    h.stall("a", 300);
    h.holdDownstream("a", 325);
    h.advance(300);
    const [deadline] = h.scheduledTimers("a");
    if (key === "a") h.a.peer!.close();
    else h.b.session.stop();
    h.advance(25);
    const watcher = key === "a" ? h.b : h.a;
    expect(watcher.session.room!.phase).toBe("paused");
    expect(watcher.session.checkpoint!.clock.frozen).toBe(true);
    if (key === "a") expect(h.a.session.connected).toBe(false);
    expect(h.a.session.pending).toHaveLength(0);
    expect(h.scheduledTimers("a")).toHaveLength(0);
    const frozenAt = watcher.session.prediction!.atMs;
    h.advance(600);
    expect(watcher.session.prediction!.atMs).toBe(frozenAt);
    if (key === "b") h.b.session.start();
    h.runUntil(() => h.a.session.canPlay && h.b.session.canPlay, 6000);
    h.press("a", Input.RightDown);
    deadline.run();
    h.advance(40);
    h.press("a", Input.RightUp);
    h.runUntil(() => h.a.session.pending.length === 0);
    expect(ownerState(h).state.leftHeld).toBe(false);
    expect(ownerState(h).state.rightHeld).toBe(false);
    expect(h.a.diagnostics!.snapshot()).toMatchObject({ releases: { total: 0 }, rejections: { total: 0 } });
  });

  test("healthy 34 ms batching never requests a deferral or adds latency", () => {
    const h = new NetHarness({ diagnostics: true });
    h.startMatch();
    for (let i = 0; i < 10; i++) {
      h.press("a", Input.LeftDown);
      h.advance(5);
      h.press("a", Input.LeftUp);
      const queued = h.time;
      expect(h.scheduledTimers("a")[0].at).toBe(queued + 29);
      h.advance(29);
      expect(h.a.batches.at(-1)!.items.at(-1)!.input).toBe(Input.LeftUp);
      expect(h.a.session.pending.every(i => i.transmitted)).toBe(true);
      h.advance(100);
    }
    h.runUntil(() => h.a.session.pending.length === 0);
    expect(h.a.commands.filter(c => c.type === "resync")).toHaveLength(0);
    expect(h.a.diagnostics!.snapshot()).toMatchObject({ releases: { total: 0 }, rejections: { total: 0 },
      staleRecovery: { count: 0 } });
    expect(h.scheduledTimers("a")).toHaveLength(0);
  });
});

describe("session diagnostics", () => {
  test("classifies only states evaluated at the same simulation timestamp", () => {
    const state = new Match({ players: ["a", "b"], seed: 123 }).saveState();
    const first = new OwnerPrediction(state, "a");
    first.advanceToTime(100);
    const second = new OwnerPrediction(state, "a");
    second.advanceToTime(100);
    const diagnostics = new SessionDiagnostics();

    diagnostics.correction(0, 100, first.saveState(), second.saveState());
    expect(diagnostics.snapshot().corrections).toMatchObject({ compared: 1, skipped: 0, total: 0 });

    const changed = second.saveState();
    changed.game.board[0] = changed.game.board[0] === 0 ? 1 : 0;
    diagnostics.correction(0, 100, first.saveState(), changed);
    expect(diagnostics.snapshot().corrections).toMatchObject({ compared: 2, skipped: 0, total: 1, board: 1 });

    const controls = second.saveState();
    controls.game.state.direction = 1;
    diagnostics.correction(0, 100, first.saveState(), controls);
    expect(diagnostics.snapshot().corrections).toMatchObject({ compared: 3, skipped: 0, total: 2, controls: 1 });

    const garbage = second.saveState();
    garbage.garbage.hole = garbage.garbage.hole === 4 ? 5 : 4;
    diagnostics.correction(0, 100, first.saveState(), garbage);
    expect(diagnostics.snapshot().corrections).toMatchObject({ compared: 4, skipped: 0, total: 3, garbage: 1 });

    const later = new OwnerPrediction(state, "a");
    later.advanceToTime(200);
    diagnostics.correction(0, 100, first.saveState(), later.saveState());
    expect(diagnostics.snapshot().corrections).toMatchObject({ compared: 5, skipped: 1, total: 3 });
    expect(classifyCorrection(first.saveState(), later.saveState())).toBeNull();
  });

  test("splitting advancement for a correction does not change simulation state", () => {
    const state = new Match({ players: ["a", "b"], seed: 321 }).saveState();
    const straight = new OwnerPrediction(state, "a");
    const split = new OwnerPrediction(state, "a");
    const action = { player: "a", frame: 5, subframe: 0.5, order: 0, input: Input.HardDrop };
    straight.submit(action);
    split.submit(action);
    straight.advanceToTime(500);
    split.advanceToTime(100);
    split.advanceToTime(500);
    expect(split.saveState()).toEqual(straight.saveState());
    const straightEvents = straight.drainEvents();
    expect(split.drainEvents()).toEqual(straightEvents);
    expect(straightEvents.some(event => event.type === "lock")).toBe(true);
  });

  test("rejection dedupe is cleared when the round or generation changes", () => {
    const diagnostics = new SessionDiagnostics();
    const info = { sequence: 1, serverNow: 0, frame: 0, round: 1, generation: 0, identityChanged: false };
    diagnostics.checkpoint(0, info);
    diagnostics.rejections(0, [{ seq: 1, code: "INPUT_REJECTED" }], 0);
    diagnostics.rejections(1, [{ seq: 1, code: "INPUT_REJECTED" }], 0);
    expect(diagnostics.snapshot().rejections.total).toBe(1);

    diagnostics.checkpoint(2, { ...info, sequence: 2, round: 2, identityChanged: true });
    diagnostics.rejections(3, [{ seq: 1, code: "INPUT_REJECTED" }], 0);
    expect(diagnostics.snapshot().rejections.total).toBe(2);
  });

  test("batch and connection events are emitted only when they carry evidence", () => {
    const diagnostics = new SessionDiagnostics();
    diagnostics.queuedInput(1, 0);
    diagnostics.sentBatch(10, [1], 0);
    diagnostics.queuedInput(2, 100);
    diagnostics.sentBatch(140, [2], 0);
    diagnostics.sentBatch(150, [3], 0); // no queue timing: must not fabricate a 0 ms event
    expect(diagnostics.snapshot().events.filter(event => event.type === "batch")).toEqual([
      { type: "batch", at: 140, count: 1, maxQueueMs: 40, pending: 0 },
    ]);
    expect(diagnostics.snapshot().inputs).toMatchObject({ batches: 3, sent: 3, maxQueueMs: 40 });

    diagnostics.connection(0, true);
    diagnostics.connection(1, true);
    diagnostics.connection(2, false);
    diagnostics.connection(3, false);
    expect(diagnostics.snapshot().events.filter(event => event.type === "connection")).toHaveLength(2);
  });

  test("disabled diagnostics never clone prediction state", () => {
    const saveState = spyOn(OwnerPrediction.prototype, "saveState");
    try {
      const h = new NetHarness();
      h.startMatch();
      h.press("a", Input.LeftDown);
      h.advance(120);
      h.press("a", Input.LeftUp);
      h.advance(300);
      expect(saveState).toHaveBeenCalledTimes(0);
    } finally {
      saveState.mockRestore();
    }

    const enabled = spyOn(OwnerPrediction.prototype, "saveState");
    try {
      const h = new NetHarness({ diagnostics: true });
      h.startMatch();
      h.press("a", Input.LeftDown);
      h.advance(120);
      expect(enabled.mock.calls.length).toBeGreaterThan(0);
    } finally {
      enabled.mockRestore();
    }
  });

  test("buffers stay bounded and the summary is plain, non-identifying JSON", () => {
    const diagnostics = new SessionDiagnostics();
    for (let i = 0; i < 200; i++) diagnostics.frame(i * 40);
    for (let i = 0; i < 40; i++) diagnostics.rtt(100 + i);
    diagnostics.connection(0, true);
    const snapshot = diagnostics.snapshot();
    expect(snapshot.events.length).toBeLessThanOrEqual(128);
    expect(snapshot.rtt.samples).toBe(16);
    expect(snapshot.frames.maxGapMs).toBe(40);
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
    expect(JSON.stringify(snapshot)).not.toContain("resumeToken");
  });
});
