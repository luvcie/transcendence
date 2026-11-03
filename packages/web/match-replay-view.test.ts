import { expect, test, spyOn } from "bun:test";
import { Match, type MatchEvent } from "@42tris/match";
import { mountMatchReplay, matchReplayLayout, MATCH_REPLAY_NOTICE_FRAMES } from "./src/match-replay-view";
import { FakeDocument, type Element } from "./test-dom";
import { BUILTIN_SKINS } from "./src/skin-catalog";
import type { LoadedSkin } from "./src/skin-loader";

function harness(count = 2, width = 10, options: Parameters<typeof mountMatchReplay>[1] = {}) {
  const document = new FakeDocument();
  document.root.width = 1200;
  const state = new Match({ players: Array.from({ length: count }, (_, i) => `p${i}`), seed: 123, width }).saveState();
  const view = mountMatchReplay(document.root as unknown as HTMLElement, options);
  const container = document.root.children[0];
  const grid = container.children[1];
  return { document, state, view, container, grid, summary: container.children[0] };
}
const field = (card: Element) => card.children[0];
const board = (card: Element) => field(card).children[1].children[1];
const meter = (card: Element) => field(card).children[1].children[0];
const label = (card: Element) => card.children[1];
const queue = (card: Element) => card.children[2];
const effect = (card: Element) => card.children[3];
function packet() { return { id: 1, from: "p0", to: "p1", lines: 6, kind: "base" as const, atMs: 0, eligibleAtMs: 1000 }; }

test.each([2, 3, 8])("renders all %i participants from one unmodified snapshot", count => {
  const h = harness(count);
  h.state.players.forEach((p, i) => { p.game.board[390 + i] = i % 7 + 1; });
  const before = structuredClone(h.state);
  const advance = spyOn(Match.prototype, "advanceToFrame");
  try {
    h.view.render(h.state);
    expect(h.grid.children).toHaveLength(count);
    h.grid.children.forEach((card, i) => {
      expect(card.getAttribute("data-player-id")).toBe(h.state.roster[i]);
      expect(label(card).textContent).toBe(`p${i} · 0 points`);
      expect(board(card).calls).toContain("tile");
      expect(field(card).children[2].children[1].calls).toContain("tile");
    });
    expect(h.state).toEqual(before);
    expect(advance).not.toHaveBeenCalled();
    const canvases = h.grid.children.map(board);
    h.view.render(structuredClone(h.state));
    expect(h.grid.children.map(board)).toEqual(canvases);
  } finally { advance.mockRestore(); h.view.dispose(); }
});

test("maps roster IDs to distinct board cells, names and scores", () => {
  const h = harness(3, 10, { appearance: { names: { p0: "<Ada>", p1: "Bea" } } });
  h.state.players[0].game.board[390] = 1;
  h.state.players[1].game.board[390] = 2;
  h.state.scores = [2, 4, 1];
  h.view.render(h.state);
  expect(h.grid.children.map(card => label(card).textContent)).toEqual(["<Ada> · 2 points", "Bea · 4 points", "p2 · 1 points"]);
  expect(board(h.grid.children[0]).tiles[0]).toEqual({ color: "#ef4444", x: 0, y: 570 });
  expect(board(h.grid.children[1]).tiles[0]).toEqual({ color: "#f97316", x: 0, y: 570 });
  expect(board(h.grid.children[0])).not.toBe(board(h.grid.children[1]));
  h.view.dispose();
});

test("shows authoritative garbage queues, eliminations and withdrawals and replaces them on backward seek", () => {
  const h = harness(3);
  const initial = structuredClone(h.state);
  h.state.players[1].garbage.packets.push(packet(), { ...packet(), id: 2, lines: 3 });
  h.state.players[1].eliminated = true;
  h.state.players[2].withdrawn = true;
  h.view.render(h.state);
  expect(meter(h.grid.children[1]).getAttribute("aria-valuenow")).toBe("9");
  expect(queue(h.grid.children[1]).textContent).toBe("Pending: 6 from p0; 3 from p0");
  expect(label(h.grid.children[1]).textContent).toContain("eliminated");
  expect(label(h.grid.children[2]).textContent).toContain("withdrawn");
  h.view.render(initial, { discontinuity: true });
  expect(meter(h.grid.children[1]).getAttribute("aria-valuenow")).toBe("0");
  expect(queue(h.grid.children[1]).textContent).toBe("No pending garbage");
  expect(label(h.grid.children[1]).textContent).not.toContain("eliminated");
  expect(label(h.grid.children[2]).textContent).not.toContain("withdrawn");
  h.view.dispose();
});

test("round and set presentation use explicit outcomes and discard previous round labels", () => {
  const h = harness();
  h.state.ended = true; h.state.scores[0] = 1;
  h.view.render(h.state, { results: { round: 1, roundWinner: "p0" } });
  expect(h.summary.textContent).toContain("Round complete · p0 wins");
  const next = structuredClone(h.state); next.round = 2; next.frame = 0; next.ended = false;
  h.view.render(next);
  expect(h.summary.textContent).toBe("Round 2 · first to 7");
  expect(label(h.grid.children[0]).textContent).toContain("1 points");
  next.complete = true; next.ended = true;
  h.view.render(next, { discontinuity: true, results: { round: 2, setWinner: "p1" } });
  expect(h.summary.textContent).toContain("Set complete · p1 wins");
  h.view.setAppearance({ names: { p1: "Bea" } });
  expect(h.summary.textContent).toContain("Bea wins");
  h.view.render(next, { discontinuity: true });
  expect(h.summary.textContent).toContain("Set complete");
  expect(h.summary.textContent).not.toContain("wins");
  h.view.render({ ...next, complete: false, ended: true }, { results: { round: 2, roundWinner: null } });
  expect(h.summary.textContent).toContain("no winner");
  h.view.dispose();
});

test("attack and garbage notices survive sequential and paused renders and reset on discontinuities", () => {
  const h = harness();
  const events: MatchEvent[] = [
    { type: "send", packet: packet(), round: 1, atMs: 0 },
    { type: "queue", packet: packet(), round: 1, atMs: 0 },
    { type: "insert", player: "p1", packet: 1, holes: [2, 2], round: 1, atMs: 0 },
    { type: "cancel", player: "p1", packet: 1, lines: 2, round: 1, atMs: 0 },
  ];
  h.view.render(h.state, { events });
  expect(effect(h.grid.children[0]).textContent).toContain("Sent 6 → p1");
  expect(effect(h.grid.children[1]).textContent).toContain("Incoming 6 ← p0");
  expect(effect(h.grid.children[1]).textContent).toContain("Garbage received: 2");
  h.view.resetEffects();
  expect(effect(h.grid.children[0]).textContent).toBe("");
  for (const snapshot of [h.state, structuredClone(h.state), { ...h.state, round: 2 }]) {
    h.view.render(snapshot, { events, discontinuity: true });
    expect(h.grid.children.every(card => effect(card).textContent === "")).toBe(true);
  }
  h.view.render({ ...h.state, round: 2 }, { events });
  expect(effect(h.grid.children[0]).textContent).toBe("");
  h.view.render(h.state, { events });
  h.view.render({ ...h.state, frame: 1 });
  h.view.render({ ...h.state, frame: 1 }, { events: [] });
  expect(effect(h.grid.children[0]).textContent).toBe("Sent 6 → p1");
  h.view.setAppearance({ names: { p1: "Bea" } });
  expect(effect(h.grid.children[0]).textContent).toBe("Sent 6 → Bea");
  h.view.render({ ...h.state, frame: MATCH_REPLAY_NOTICE_FRAMES - 1 });
  expect(effect(h.grid.children[0]).textContent).toBe("Sent 6 → Bea");
  h.view.render({ ...h.state, frame: MATCH_REPLAY_NOTICE_FRAMES });
  expect(effect(h.grid.children[0]).textContent).toBe("");
  h.view.render({ ...h.state, frame: 100 }, { events });
  h.view.render({ ...h.state, frame: 99 });
  expect(effect(h.grid.children[0]).textContent).toBe("");
  h.view.render(h.state, { events });
  h.view.render({ ...h.state, round: 2 });
  expect(effect(h.grid.children[0]).textContent).toBe("");
  h.view.dispose();
});

test("per-player built-in skins load asynchronously; invalid, missing and custom IDs fall back to Classic", async () => {
  const requested: string[] = [];
  const h = harness(8, 10, { appearance: { skinIds: { p0: "four", p1: "tetrio", p2: "bad", p3: "custom:0", p4: "https://example.com/private.png", p5: "__proto__" } },
    loadSkin: async def => { requested.push(def.id); return { def, image: { id: def.id } as unknown as HTMLImageElement, tile: 30 }; } });
  h.state.players.forEach(p => { p.game.board[390] = 1; });
  h.view.render(h.state);
  await Bun.sleep(0);
  expect(requested.sort()).toEqual(["four", "tetrio"]);
  expect(board(h.grid.children[0]).images.at(-1)).toEqual({ id: "four" });
  expect(board(h.grid.children[1]).images.at(-1)).toEqual({ id: "tetrio" });
  h.grid.children.slice(2).forEach(card => expect(board(card).images).toEqual([]));
  h.view.setAppearance({ skinIds: { p0: "tetrio", p1: "classic" } });
  expect(board(h.grid.children[0]).images.at(-1)).toEqual({ id: "tetrio" });
  h.view.dispose();
});

test("supports local overrides and ignores late skin completions after disposal", async () => {
  let finish!: (skin: LoadedSkin) => void;
  const skin = { def: BUILTIN_SKINS.find(d => d.id === "four")!, image: {} as HTMLImageElement, tile: 30 };
  const h = harness(2, 10, { appearance: { skinIds: { p1: "four" } },
    skinOverride: id => id === "p0" ? skin : undefined,
    loadSkin: () => new Promise(resolve => { finish = resolve; }) });
  h.state.players.forEach(p => { p.game.board[390] = 1; });
  h.view.render(h.state);
  expect(board(h.grid.children[0]).images.at(-1)).toBe(skin.image);
  const canvas = board(h.grid.children[1]); const calls = canvas.calls.length;
  h.view.dispose(); finish(skin); await Bun.sleep(0);
  h.view.render(h.state); h.view.resize(); h.view.dispose();
  expect(h.document.root.children).toHaveLength(0);
  expect(canvas.calls).toHaveLength(calls);
});

test.each([4, 5, 6, 7, 8, 9, 10, 11, 12])("preserves %i-column board proportions and reuses canvases on resize", width => {
  const h = harness(8, width);
  h.view.render(h.state);
  const canvases = h.grid.children.map(board);
  canvases.forEach(canvas => { expect(canvas.width).toBe(width * 30); expect(canvas.height).toBe(600); });
  expect(h.grid.getAttribute("style")).toContain(`--replay-board-track: ${width}fr`);
  expect(h.grid.getAttribute("style")).toContain("repeat(4,");
  h.document.root.width = 350; h.view.resize();
  expect(h.grid.getAttribute("style")).toContain("repeat(1,");
  expect(h.grid.children.map(board)).toEqual(canvases);
  h.view.dispose();
});

test("layout fits available width for 2–8 players at narrow and wide sizes", () => {
  for (let count = 2; count <= 8; count++) for (const width of [0, 240, 560, 900, 1600]) {
    const layout = matchReplayLayout(count, width, 12);
    expect(layout.columns).toBeGreaterThanOrEqual(1);
    expect(layout.columns).toBeLessThanOrEqual(count === 2 ? 2 : 4);
    expect(layout.cardWidth * layout.columns + layout.gap * (layout.columns - 1)).toBeLessThanOrEqual(width + 0.001);
  }
  expect(matchReplayLayout(2, 900, 10).columns).toBe(2);
  expect(matchReplayLayout(8, 1200, 10).columns).toBe(4);
});

test("observes host resizing and disconnects observer and window listener on disposal", () => {
  const document = new FakeDocument();
  let callback!: () => void;
  let observed: unknown;
  let disconnected = false;
  class Observer {
    constructor(next: () => void) { callback = next; }
    observe(target: unknown) { observed = target; }
    disconnect() { disconnected = true; }
  }
  const window = Object.assign(new EventTarget(), { ResizeObserver: Observer });
  Object.assign(document, { defaultView: window });
  const add = spyOn(window, "addEventListener");
  const remove = spyOn(window, "removeEventListener");
  document.root.width = 1200;
  const view = mountMatchReplay(document.root as unknown as HTMLElement);
  const state = new Match({ players: ["a", "b", "c"], seed: 123 }).saveState();
  view.render(state);
  const grid = document.root.children[0].children[1];
  expect(observed).toBe(document.root);
  expect(grid.getAttribute("style")).toContain("repeat(3,");
  document.root.width = 350; callback();
  expect(grid.getAttribute("style")).toContain("repeat(1,");
  document.root.width = 900; window.dispatchEvent(new Event("resize"));
  expect(grid.getAttribute("style")).toContain("repeat(3,");
  view.dispose();
  expect(disconnected).toBe(true);
  expect(remove.mock.calls[0]).toEqual(add.mock.calls[0]);
  const style = grid.getAttribute("style");
  document.root.width = 200; callback(); window.dispatchEvent(new Event("resize"));
  expect(grid.getAttribute("style")).toBe(style);
});

test("new notices replace only that player's batch without extending other players' lifetime", () => {
  const h = harness();
  const send: MatchEvent = { type: "send", packet: packet(), round: 1, atMs: 0 };
  const incoming: MatchEvent = { ...send, type: "queue" };
  h.view.render(h.state, { events: [send, incoming] });
  h.view.render({ ...h.state, frame: 30 }, { events: [{ ...send, packet: { ...packet(), lines: 2 } }] });
  expect(effect(h.grid.children[0]).textContent).toBe("Sent 2 → p1");
  expect(effect(h.grid.children[1]).textContent).toBe("Incoming 6 ← p0");
  h.view.render({ ...h.state, frame: 60 });
  expect(effect(h.grid.children[0]).textContent).toBe("Sent 2 → p1");
  expect(effect(h.grid.children[1]).textContent).toBe("");
  h.view.dispose();
});

test("late skin loads draw the latest roster metadata and snapshot without clearing notices", async () => {
  const complete = new Map<string, (skin: LoadedSkin) => void>();
  const h = harness(2, 10, { appearance: { skinIds: { p0: "four" } },
    loadSkin: def => new Promise(resolve => { complete.set(def.id, resolve); }) });
  h.state.players.forEach(p => { p.game.board[390] = 1; });
  h.view.render(h.state, { events: [{ type: "send", packet: packet(), round: 1, atMs: 0 }] });
  const canvas = board(h.grid.children[0]);
  h.view.setAppearance({ names: { p1: "Bea" }, skinIds: { p0: "tetrio" } });
  h.view.render({ ...h.state, frame: 1 });
  const loaded = (id: string): LoadedSkin => ({ def: BUILTIN_SKINS.find(def => def.id === id)!, image: { id } as unknown as HTMLImageElement, tile: 30 });
  complete.get("four")!(loaded("four")); await Bun.sleep(0);
  expect(canvas.images).toEqual([]);
  complete.get("tetrio")!(loaded("tetrio")); await Bun.sleep(0);
  expect(canvas.images.at(-1)).toEqual({ id: "tetrio" });
  expect(effect(h.grid.children[0]).textContent).toBe("Sent 6 → Bea");
  h.view.setAppearance({ skinIds: { p0: "classic" } });
  const images = canvas.images.length;
  h.view.render(h.state);
  expect(canvas.images).toHaveLength(images);
  expect(label(h.grid.children[1]).textContent).toBe("p1 · 0 points");
  h.view.dispose();
});

test("winner text requires current-round result metadata even when scores reach first-to", () => {
  const h = harness();
  h.state.scores[0] = h.state.firstTo;
  h.state.ended = true; h.state.complete = true;
  for (const results of [undefined, { round: 2, setWinner: "p0" }, { round: 1, setWinner: "absent" }]) {
    h.view.render(h.state, { results });
    expect(h.summary.textContent).toContain("Set complete");
    expect(h.summary.textContent).not.toContain("wins");
  }
  h.view.dispose();
});

test("repeated mounting and disposal leave the host's other elements intact", () => {
  const document = new FakeDocument();
  const sibling = document.createElement(); document.root.append(sibling);
  const state = new Match({ players: ["a", "b"], seed: 123 }).saveState();
  for (let i = 0; i < 5; i++) {
    const view = mountMatchReplay(document.root as unknown as HTMLElement);
    view.render(state);
    expect(document.root.children).toHaveLength(2);
    view.dispose(); view.dispose(); view.render(state); view.resize(); view.resetEffects();
    view.setAppearance({ skinIds: { a: "four" } });
    expect(document.root.children).toEqual([sibling]);
  }
});
