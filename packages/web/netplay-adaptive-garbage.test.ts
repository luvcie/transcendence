import { expect, test } from "bun:test";
import { FRAME_MS, GARBAGE, Input, Piece, type GameState } from "@42tris/core";
import { Match, OwnerPrediction } from "@42tris/match";
import { NetHarness } from "./netplay-harness";

function quad(game: GameState, allClear = true) {
  game.board.fill(0);
  Object.assign(game.state, { piece: Piece.I, rot: 1, x: 2, y: 18 });
  for (let y = 36; y < 40; y++) { game.board.fill(Piece.L, y * 10, (y + 1) * 10); game.board[y * 10 + 4] = 0; }
  if (!allClear) game.board[350] = Piece.L;
}

// Modified boards are synthetic Match fixtures and never competitive replay evidence.
test.each([0, 44, 54, 104])("adaptive policy value %i: future/on-time crossing, cancellation and garbage eligibility", lead => {
  for (const scenario of ["crossing", "cancellation", "eligibility"] as const) {
    const state = new Match({ players: ["a", "b"], seed: 108 }).saveState();
    quad(state.players[0].game, scenario === "eligibility");
    if (scenario !== "eligibility") quad(state.players[1].game, false);
    const early = Match.fromState(state), onTime = Match.fromState(state);
    const input = (player: string, stamp: number, key: typeof Input.HardDrop | typeof Input.Hold, order: number) => {
      const time = stamp;
      return { player, frame: Math.floor(time), subframe: time - Math.floor(time), input: key, order };
    };
    const first = 10.25 + Math.ceil(lead / FRAME_MS);
    const second = scenario === "crossing" ? first + 0.5 : scenario === "cancellation" ? first + 1 : first + 20 - 1e-10;
    const inputs = [input("a", first, Input.HardDrop, 0), input("b", second, Input.HardDrop, 1),
      ...(scenario === "eligibility" ? [input("b", first + 20, Input.HardDrop, 2)] : []),
      input("a", first + 22, Input.Hold, 3)];
    for (const i of inputs) early.submit(i);
    for (let frame = 0; frame < 45; frame++) {
      for (const i of inputs.filter(i => i.frame === frame)) onTime.submit(i);
      early.advanceToFrame(frame + 1); onTime.advanceToFrame(frame + 1);
    }
    expect(early.saveState()).toEqual(onTime.saveState());
    const events = early.drainEvents(); expect(events).toEqual(onTime.drainEvents());
    if (scenario === "crossing") expect(events.some(e => e.type === "crossCancel")).toBe(true);
    if (scenario === "cancellation") expect(events.some(e => e.type === "cancel")).toBe(true);
    if (scenario === "eligibility") expect(events.filter(e => e.type === "insert").flatMap(e => e.holes)).toHaveLength(8);
  }
});

test.each([40, 180, 200, 300])("RTT %i adaptive/fixed equivalent garbage, Hard Drop, Hold and piece identity", rtt => {
  const lead = Math.max(0, rtt / 2 - 46);
  const run = (mode: number | "auto") => {
    const h = new NetHarness({ seed: 42, diagnostics: true, inputLeadMs: { a: mode },
      a: { up: rtt / 2, down: rtt / 2 }, b: { up: 20, down: 20 } });
    h.startMatch({ mode: "practice", attacksEnabled: true });
    expect(h.a.diagnostics!.snapshot().lead.appliedMs).toBe(lead);
    expect(h.a.diagnostics!.snapshot().clock.effectiveOffsetMs).toBe(0);
    const state = h.room!.match!.saveState(); quad(state.players[state.roster.indexOf(h.b.session.playerId)].game);
    h.room!.match = Match.fromState(state); h.advance(100);
    h.holdDownstream("a", 600); h.press("b", Input.HardDrop);
    h.runUntil(() => h.room!.match!.saveState().players[h.room!.match!.roster.indexOf(h.a.session.playerId)].garbage.packets.length > 0);
    h.advance(350);
    const intended = { sequence: h.a.session.prediction!.gameState().state.sequence,
      piece: h.a.session.prediction!.gameState().state.piece };
    h.press("a", Input.HardDrop); h.advance(40);
    const intendedHold = h.a.session.prediction!.gameState().state.piece;
    h.press("a", Input.Hold);
    const hold = structuredClone(h.a.batches.at(-1)!.items.at(-1)!);
    h.advance(1200);
    const prediction = h.a.session.prediction!;
    const authority = new OwnerPrediction(h.aCheckpoint!.state!, h.a.session.playerId); authority.advanceToTime(prediction.atMs);
    expect(prediction.gameState()).toEqual(authority.gameState());
    expect(h.room!.match!.playerState(h.a.session.playerId).state.held).toBe(intendedHold);
    expect(prediction.gameState().board.some(cell => cell === GARBAGE)).toBe(true);
    expect(h.a.batches.flatMap(b => b.items).find(i => i.seq === hold.seq)).toEqual(hold);
    expect(h.a.diagnostics!.snapshot().releases.total).toBe(0);
    const locks = h.room!.events.flatMap(e => e.event.type === "lock" && e.event.player === h.a.session.playerId ? [e.event.result] : []);
    expect(locks[0]).toMatchObject({ sequence: intended.sequence + 1, piece: intended.piece });
    return { state: h.room!.match!.saveState(), events: h.room!.events, batches: h.a.batches,
      prediction: prediction.saveState(), intended, intendedHold, locks };
  };
  expect(run("auto")).toEqual(run(lead));
});
