import { expect, spyOn, test } from "bun:test";
import { DEFAULT_HANDLING, Input } from "@42tris/core";
import { Match } from "@42tris/match";
import type { Checkpoint, ClientCommand, RoomPhase } from "@42tris/protocol";
import { mountAppView } from "./src/app-view";
import { mountOnline } from "./src/online-view";
import { renderOnlineWaiting } from "./src/waiting-view";
import { Session } from "./src/session";
import { SessionDiagnostics } from "./src/session-diagnostics";
import { experimentalInputLead } from "./src/netplay-options";
import { NetHarness } from "./netplay-harness";
import { SkinState } from "./src/skin-state";
import type { MultiplayerSkinMode } from "./src/multiplayer-skins";

import { FakeDocument } from "./test-dom";

function harness(invite?: string, settings: { skins?: SkinState; skinMode?: () => MultiplayerSkinMode; replay?: Parameters<typeof mountOnline>[1]["replay"];
  href?: string; diagnostics?: SessionDiagnostics } = {}) {
  const document = new FakeDocument();
  if (invite !== undefined) document.location = new URL(`https://example.com/?room=${invite}`);
  if (settings.href !== undefined) document.location = new URL(settings.href);
  const storage = { getItem: () => null, setItem() {}, removeItem() {} };
  const sent: ClientCommand[] = [];
  let returnedLocal = false;
  const showView = mountAppView(document as unknown as Document);
  showView("solo");
  const session = new Session({ now: () => 0, storage, profile: storage, clearKeys() {},
    diagnostics: settings.diagnostics, inputLeadMs: experimentalInputLead(document.location.searchParams),
    connect: () => ({ send(command) { sent.push(command); }, close() {} }) });
  const view = mountOnline(document.root as unknown as HTMLElement, {
    replay: settings.replay, session, invite, clearKeys() {}, handling: () => DEFAULT_HANDLING, view: showView,
    local() { returnedLocal = true; showView("solo"); },
    skins: settings.skins ?? new SkinState(() => storage),
    skinMode: settings.skinMode ?? (() => "player"),
  });
  session.receive({ type: "welcome", guestSessionId: "a", playerId: "a", resumeToken: "token", name: "A", room: null, generation: 0, serverNow: 0 });
  const match = new Match({ players: ["a", "b"], seed: 123, mode: "practice" });
  const state = match.saveState();
  state.players[1].game.board[390] = 1;
  const cp: Checkpoint = {
    type: "checkpoint", serverSequence: 1, serverNow: 0, matchId: "match", state,
    room: { code: "ABCDEF", revision: 1, ownerId: "a", options: { firstTo: 3, maxPlayers: 4, mode: "practice", attacksEnabled: true },
      phase: "playing", matchId: "match", preparationId: 1, startsAt: null, prepareDeadline: null,
      players: ["a", "b"].map(playerId => ({ playerId, name: playerId, skin: "classic", connected: true, ready: true, prepared: true, deadline: null, withdrawn: false })) },
    owner: { generation: 0, epoch: 0, nextSeq: 1, resolvedThroughSeq: 0, pendingAccepted: [], rejections: [] },
    clock: { currentTargetFrame: 0, simulationNow: 0, origin: 0, pausedTotal: 0, commitDelayMs: 100, frozen: false }, roundDurations: [], events: [],
  };
  const render = () => {
    view.update();
    return renderOnlineWaiting(document as unknown as Document, session);
  };
  return { document, session, view, cp, render, sent, showView, get returnedLocal() { return returnedLocal; } };
}

test("invitation joins after welcome and displays the existing waiting interface", () => {
  const h = harness("abcdef");
  expect(h.sent.filter(command => command.type === "join")).toEqual([{ type: "join", code: "ABCDEF" }]);
  h.session.receive({ type: "roomState", room: { ...h.cp.room, phase: "waiting", matchId: null,
    players: h.cp.room.players.map(player => ({ ...player, ready: false })) }, serverNow: 0 });
  h.view.update();
  expect(h.document.querySelector("main").getAttribute("data-view")).toBe("waiting");
  expect(h.document.querySelector("[data-entry]").hidden).toBe(true);
  expect(h.sent.some(command => command.type === "ready")).toBe(false);
  h.view.destroy();
});

test.each(["success", "unavailable", "reject", "throw"] as const)("copy invite strips experimental lead on clipboard %s", async mode => {
  const priorNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const copied: string[] = [];
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: {
    clipboard: mode === "unavailable" ? undefined : { writeText(value: string) {
      copied.push(value);
      if (mode === "throw") throw new Error("Clipboard unavailable");
      return mode === "reject" ? Promise.reject(new Error("Clipboard denied")) : Promise.resolve();
    } },
  } });
  try {
    // Keep ordinary invitation behavior as a control, including path/query/hash.
    for (const lead of [104, 0, "auto"] as const) {
      copied.length = 0;
      const href = lead
        ? `https://example.com/play?diagnostics&lead=${lead}${lead === 104 ? "&lead=250" : ""}&room=OLDROM&keep=value#board`
        : "https://example.com/play?room=OLDROM&keep=value#board";
      const expected = lead
        ? "https://example.com/play?diagnostics=&room=ABCDEF&keep=value#board"
        : "https://example.com/play?room=ABCDEF&keep=value#board";
      const diagnostics = new SessionDiagnostics();
      const sender = harness(undefined, { href, diagnostics });
      let recipient: ReturnType<typeof harness> | undefined;
      try {
        sender.session.receive(sender.cp);
        sender.render();
        expect(diagnostics.snapshot().lead).toMatchObject({ requestedMs: lead === "auto" ? null : lead, appliedMs: lead === "auto" ? 0 : lead });
        const prediction = sender.session.prediction;
        sender.document.querySelector("[data-copy]").dispatchEvent(new Event("click"));
        await Promise.resolve(); await Promise.resolve();
        let invitation: string;
        if (mode === "success") {
          expect(copied).toEqual([expected]);
          expect(sender.document.querySelector("[data-notification]").textContent).toBe("Invite copied");
          expect(sender.document.querySelector("[data-notification]").hidden).toBe(false);
          invitation = copied[0];
        } else {
          expect(copied).toEqual(mode === "unavailable" ? [] : [expected]);
          expect(sender.session.status).toBe(`Copy this invite: ${expected}`);
          invitation = sender.session.status.slice("Copy this invite: ".length);
        }
        const url = new URL(invitation);
        expect(url.searchParams.get("room")).toBe("ABCDEF");
        expect(url.searchParams.has("lead")).toBe(false);
        const recipientDiagnostics = new SessionDiagnostics();
        recipient = harness(url.searchParams.get("room")!, { href: invitation, diagnostics: recipientDiagnostics });
        expect(recipient.sent.filter(command => command.type === "join")).toEqual([{ type: "join", code: "ABCDEF" }]);
        recipient.session.receive(recipient.cp);
        expect(recipientDiagnostics.snapshot().lead).toMatchObject({ requestedMs: 0, appliedMs: 0 });
        expect(recipient.session.canPlay).toBe(true);
        expect(recipient.session.prediction!.atMs).toBe(0);
        expect(sender.document.location.href).toBe(href);
        expect(diagnostics.snapshot().lead).toMatchObject({ requestedMs: lead === "auto" ? null : lead, appliedMs: lead === "auto" ? 0 : lead });
        expect(sender.session.prediction).toBe(prediction);
        expect(sender.session.canPlay).toBe(true);
      } finally {
        recipient?.view.destroy(); sender.view.destroy();
      }
    }
  } finally {
    if (priorNavigator) Object.defineProperty(globalThis, "navigator", priorNavigator);
    else Reflect.deleteProperty(globalThis, "navigator");
  }
});

test.each([
  ["diagnostics&lead=104", 104], ["lead=104", 0], ["diagnostics&lead=0", 0],
  ["diagnostics&lead=251", 0], ["diagnostics&lead=NaN", 0],
] as const)("explicit URL %s retains strict lead opt-in", (query, expected) => {
  const diagnostics = new SessionDiagnostics();
  const h = harness(undefined, { href: `https://example.com/?${query}`, diagnostics });
  try {
    h.session.receive(h.cp);
    expect(diagnostics.snapshot().lead).toMatchObject({ requestedMs: expected, appliedMs: expected });
    expect(h.session.prediction!.atMs).toBe(expected);
  } finally { h.view.destroy(); }
});

test("mounted opponent view renders settlement-required snapshots without restoring or simulating a Game", () => {
  const h = harness();
  const before = structuredClone(h.cp.state);
  expect(h.cp.state!.players[1].game.settlementRequired).toBe(true);
  h.session.receive(h.cp);
  expect(h.render()).toBe(false);
  const opponents = h.document.querySelector("[data-opponents]");
  expect(opponents.children).toHaveLength(1);
  expect(opponents.children[0].children[1].textContent).toContain("b · 0 points");
  expect(opponents.children[0].children[0].children[1].children[1].calls).toContain("tile");
  h.session.receive({ ...h.cp, serverSequence: 2 });
  expect(() => h.render()).not.toThrow();
  expect(h.cp.state).toEqual(before);
  h.view.destroy();
});

test("disconnect retains boards; authoritative practice end clears all match presentation and shows waiting", () => {
  const h = harness();
  h.session.receive(h.cp);
  h.render();
  const node = (selector: string) => h.document.querySelector(selector);
  const opponent = node("[data-opponents]").children[0];
  for (const id of ["line-count", "combo-count", "b2b-count", "surge-count", "clear-result", "zen-status"]) node(`#${id}`).textContent = "old match";
  node("[data-result]").textContent = "old result";
  node("[data-local-meter]").setAttribute("aria-valuenow", "12");
  h.session.stop();
  expect(h.render()).toBe(false);
  expect(node("[data-opponents]").children[0]).toBe(opponent);
  expect(node("#board").calls).toEqual([]);
  expect(node("#line-count").textContent).toBe("old match");
  h.session.receive({ ...h.cp, serverSequence: 2, matchId: null, state: null, events: [],
    room: { ...h.cp.room, phase: "waiting", matchId: null }, owner: { ...h.cp.owner, generation: 1 } });
  expect(h.render()).toBe(true);
  expect(h.session.prediction).toBeNull();
  expect(node("[data-opponents]").children).toHaveLength(0);
  expect(node("[data-result]").textContent).toBe("");
  expect(node("[data-local-meter]").attributes.get("aria-valuenow")).toBe("0");
  expect(node("[data-local-meter]").hidden).toBe(true);
  expect(node("#board").calls).toContain("Waiting for a match");
  for (const id of ["hold-preview", "next-preview"]) expect(node(`#${id}`).calls).toContain("clear");
  for (const id of ["line-count", "combo-count", "b2b-count", "surge-count", "clear-result", "zen-status"]) expect(node(`#${id}`).textContent).toBe("");
  expect(node("#hold-button").disabled).toBe(true);
  expect(node("#zen-status").hidden).toBe(true);
  h.session.receive({ ...h.cp, serverSequence: 3, matchId: "next-match" });
  expect(h.render()).toBe(false);
  expect(node("[data-opponents]").children).toHaveLength(1);
  expect(node("[data-local-meter]").hidden).toBe(false);
  h.view.destroy();
});

test.each([2, 3, 4, 8])("match layout and garbage use the authoritative roster with %i players", count => {
  const h = harness();
  const ids = Array.from({ length: count }, (_, i) => String.fromCharCode(97 + i));
  const state = new Match({ players: ids, seed: 123, mode: "practice" }).saveState();
  const packet = { id: 1, from: "b", to: "a", lines: 7, kind: "base" as const, atMs: 0, eligibleAtMs: 1000 };
  state.players[0].garbage.packets.push(packet);
  state.players[1].garbage.packets.push({ ...packet, id: 2, from: "a", to: "b", lines: 13 });
  h.session.receive({ ...h.cp, state, room: { ...h.cp.room, players: ids.map(playerId => ({ playerId, name: playerId, skin: "classic", connected: true, ready: true, prepared: true, deadline: null, withdrawn: false })) } });
  h.render();
  expect(h.document.querySelector("main").attributes.get("data-layout")).toBe(count === 2 ? "duel" : "group");
  const opponents = h.document.querySelector("[data-opponents]");
  expect(opponents.children).toHaveLength(count - 1);
  expect(opponents.attributes.get("style")).toBe(`--opponent-columns: ${Math.min(4, count - 1)}`);
  expect(h.document.querySelector("[data-local-meter]").attributes.get("aria-valuenow")).toBe("7");
  expect(opponents.children[0].children[0].children[1].children[0].attributes.get("aria-valuenow")).toBe("13");
  h.view.destroy();
});

test("solo, lobby and waiting show one workspace and preserve the room form nodes", () => {
  const h = harness();
  const node = (selector: string) => h.document.querySelector(selector);
  expect(node("#online").hidden).toBe(true);
  expect(node("#pause-button").hidden).toBe(false);
  expect(node("#game-view").hidden).toBe(false);
  h.view.update();
  expect(node("main").getAttribute("data-view")).toBe("lobby");
  expect(node("#pause-button").hidden).toBe(true);
  expect(node("#game-view").hidden).toBe(true);
  expect(node("#online-button").getAttribute("aria-current")).toBe("page");
  const form = node("[data-options]");
  h.session.receive({ type: "roomState", room: { ...h.cp.room, phase: "waiting", matchId: null } });
  h.view.update();
  expect(node("main").getAttribute("data-view")).toBe("waiting");
  expect(node("[data-entry]").hidden).toBe(true);
  expect(node("[data-management-home]").hidden).toBe(false);
  expect(node("[data-roster-panel]").hidden).toBe(false);
  expect(node("[data-roster]").children).toHaveLength(2);
  expect(node("[data-ready]").hidden).toBe(false);
  expect(node("#game-view").hidden).toBe(true);
  h.session.receive({ type: "left" });
  h.view.update();
  expect(node("main").getAttribute("data-view")).toBe("lobby");
  expect(node("[data-options]")).toBe(form);
  expect(node("[data-room]").hidden).toBe(true);
  expect(node("[data-entry]").hidden).toBe(false);
  h.view.local();
  expect(h.returnedLocal).toBe(true);
  expect(node("main").getAttribute("data-view")).toBe("solo");
  h.view.destroy();
});

test.each(["preparing", "countdown", "playing", "paused", "roundResult", "setResult"] as RoomPhase[])(
  "%s keeps boards visible and room management out of the game view", phase => {
    const h = harness();
    h.session.receive({ ...h.cp, room: { ...h.cp.room, phase, startsAt: phase === "countdown" ? 3000 : null } });
    h.view.update();
    const node = (selector: string) => h.document.querySelector(selector);
    expect(node("main").getAttribute("data-view")).toBe(phase);
    expect(node("#game-view").hidden).toBe(false);
    expect(node("[data-management-home]").hidden).toBe(true);
    expect(node("[data-details]").hidden).toBe(false);
    expect(node("[data-ready]").hidden).toBe(phase !== "setResult");
    expect(node("[data-round-summary]").hidden).toBe(!["roundResult", "setResult"].includes(phase));
    expect(node("[data-options]").hidden).toBe(phase !== "setResult");
    h.view.destroy();
  },
);

test("round and set results retain scores and only rematches offer readiness", () => {
  const h = harness();
  const node = (selector: string) => h.document.querySelector(selector);
  for (const [index, phase] of (["roundResult", "setResult"] as const).entries()) {
    h.session.receive({ ...h.cp, serverSequence: index + 2, room: { ...h.cp.room, phase, startsAt: phase === "roundResult" ? 3000 : null, players: h.cp.room.players.map(p => ({ ...p, ready: false })) },
      events: [{ sequence: 1, event: { type: phase === "roundResult" ? "roundEnd" : "setEnd", round: h.cp.state!.round,
        winner: "b", atMs: 0, reason: "forfeit", complete: phase === "setResult" } }] });
    h.view.update();
    expect(node("[data-result]").textContent).toContain("b wins");
    expect(node("[data-scores]").children.map(c => c.textContent)).toEqual(["a (you): 0 · Finesse — · 0 faults · 0 pieces placed", "b: 0 · Finesse — · 0 faults · 0 pieces placed"]);
    if (phase === "roundResult") {
      expect(node("[data-phase]").textContent).toBe("Next round in 3…");
      expect(node("[data-ready]").hidden).toBe(true);
      expect(h.sent.some(c => c.type === "ready")).toBe(false);
    } else {
      expect(node("[data-ready]").textContent).toBe("Ready for rematch");
      node("[data-ready]").dispatchEvent(new Event("click"));
      expect(h.sent.at(-1)).toEqual({ type: "ready", ready: true, handling: DEFAULT_HANDLING });
    }
  }
  h.view.destroy();
});

test.each(["round", "firstTo", "forfeit", "aborted"] as const)("pruned authoritative %s results render after more than sixteen later events", result => {
  const net = new NetHarness({ players: Array.from({ length: result === "forfeit" || result === "aborted" ? 3 : 2 }, () => ({})), seed: 42 });
  net.startMatch({ firstTo: result === "firstTo" ? 1 : 7 });
  if (result === "round" || result === "firstTo") net.dropOut("b");
  else if (result === "forfeit") {
    net.b.session.send({ type: "leave" });
    net.clients[2].session.send({ type: "leave" });
    net.advance(100);
  } else {
    net.clients.forEach(c => net.rooms.disconnect(c.peer!.id));
    net.advance(40_000);
    net.a.session.retry();
    net.runUntil(() => net.a.session.connected);
    net.a.session.send({ type: "join", code: net.room!.code });
    net.runUntil(() => net.room!.seats.length === 1);
  }
  const room = net.room!;
  const significant = room.events.findLast(e => e.event.type === (result === "round" ? "roundEnd" : "setEnd"))!;
  for (let i = 0; i < 24; i++) room.recorder!.releaseControls(net.a.session.playerId);
  net.rooms.receive(net.a.peer!.id, { type: "releaseControls" });
  expect(room.events.indexOf(significant)).toBeLessThan(room.events.length - 16);
  net.rooms.snapshots();
  net.advance(100);
  expect(net.aCheckpoint!.events).toContainEqual(significant);
  expect(net.aCheckpoint!.events.length).toBeLessThanOrEqual(3);
  const document = new FakeDocument();
  const store = { getItem: () => null, setItem() {}, removeItem() {} };
  const view = mountOnline(document.root as unknown as HTMLElement, {
    session: net.a.session, clearKeys() {}, handling: () => DEFAULT_HANDLING, local() {},
    skins: new SkinState(() => store), skinMode: () => "player", view: mountAppView(document as unknown as Document),
  });
  try {
    view.update();
    const text = document.querySelector("[data-result]").textContent;
    const winner = net.a.session.name;
    expect(text).toContain(result === "round" ? `Round: ${winner} wins · last player standing`
      : result === "firstTo" ? `Set: ${winner} wins · first to 1`
      : result === "forfeit" ? `Set: ${winner} wins · forfeit` : "Set: aborted; no winner · aborted");
    expect(document.querySelector("[data-round-summary]").hidden).toBe(false);
    if (result === "round") {
      net.runUntil(() => net.aCheckpoint!.state!.round === 2, 5000);
      view.update();
      expect(document.querySelector("[data-result]").textContent).toBe("");
    } else if (result === "firstTo") {
      const oldId = room.matchId;
      for (const c of net.clients) c.session.send({ type: "ready", ready: true, handling: DEFAULT_HANDLING });
      net.runUntil(() => net.aCheckpoint!.matchId !== oldId);
      view.update();
      expect(document.querySelector("[data-result]").textContent).toBe("");
      expect(net.aCheckpoint!.events.some(e => e.event.type === "roundEnd" || e.event.type === "setEnd")).toBe(false);
    }
  } finally { view.destroy(); }
});

test("multiplayer results use placed pieces independently of finesse evaluations and show round durations", () => {
  const h = harness();
  const match = new Match({ players: ["a", "b"], seed: 123 });
  match.submit({ player: "a", frame: 0, subframe: 0, order: 0, input: Input.HardDrop });
  match.advanceToFrame(1);
  const state = match.saveState();
  const result = state.players[0].game.lastResult!;
  result.stats.pieces = 52;
  result.finesse = { evaluated: 48, faults: 1, points: 237 };
  h.session.receive({ ...h.cp, state, room: { ...h.cp.room, phase: "setResult", options: { ...h.cp.room.options, mode: "competitive" } },
    roundDurations: [{ round: 1, durationMs: 84385 }, { round: 2, durationMs: 2500 }] });
  h.view.update();
  expect(h.document.querySelector("[data-scores]").children[0].textContent).toContain("Finesse 98.8% · 1 fault · 52 pieces placed");
  expect(h.document.querySelector("[data-result]").textContent).toContain("Round 1: 1:24.385 · Round 2: 0:02.500");
  h.view.destroy();
});

test("competitive timer displays committed simulation time only while playing", () => {
  const h = harness();
  const state = structuredClone(h.cp.state!);
  state.frame = 60;
  const room = { ...h.cp.room, options: { ...h.cp.room.options, mode: "competitive" as const } };
  h.session.receive({ ...h.cp, state, room });
  h.view.update();
  expect(h.document.querySelector("[data-round-time]").textContent).toBe("Round time 0:01.000");
  h.session.receive({ ...h.cp, serverSequence: 2, state, room: { ...room, phase: "roundResult", startsAt: 3000 }, roundDurations: [{ round: 1, durationMs: 1000 }] });
  h.view.update();
  expect(h.document.querySelector("[data-result]").textContent).toContain("Round 1: 0:01.000");
  expect(h.document.querySelector("[data-round-time]").textContent).toBe("");
  h.view.destroy();
});

test("room details release controls without pausing, close on phase change and return focus to gameplay", () => {
  const h = harness();
  h.session.receive(h.cp);
  h.view.update();
  const node = (selector: string) => h.document.querySelector(selector);
  const management = node("[data-management]");
  node("[data-details]").dispatchEvent(new Event("click"));
  expect(h.view.detailsOpen).toBe(true);
  expect(h.sent.at(-1)?.type).toBe("releaseControls");
  expect(h.session.room?.phase).toBe("playing");
  expect(management.parentElement).toBe(node("[data-room-dialog]"));
  h.view.closeDetails();
  expect(h.view.detailsOpen).toBe(false);
  expect(h.document.focused).toBe(node("#game-view"));
  node("[data-details]").dispatchEvent(new Event("click"));
  h.session.receive({ ...h.cp, serverSequence: 2, room: { ...h.cp.room, phase: "roundResult" } });
  h.view.update();
  expect(h.view.detailsOpen).toBe(false);
  expect(management.parentElement).toBe(node("[data-management-home]"));
  h.view.destroy();
});

test("socket loss shows reconnection without clearing boards; leave waits for acknowledgement before Solo", () => {
  const h = harness();
  const node = (selector: string) => h.document.querySelector(selector);
  h.session.receive(h.cp);
  h.view.update();
  const opponent = node("[data-opponents]").children[0];
  h.session.stop();
  h.view.update();
  expect(node("main").getAttribute("data-view")).toBe("paused");
  expect(node("#game-view").hidden).toBe(false);
  expect(node("[data-opponents]").children[0]).toBe(opponent);
  expect(node("[data-phase]").textContent).toContain("Connection lost");
  h.session.start();
  h.session.receive({ type: "welcome", guestSessionId: "a", playerId: "a", resumeToken: "token", name: "A", room: { ...h.cp.room, phase: "setResult" }, generation: 1, serverNow: 0 });
  h.view.update();
  h.view.local();
  expect(h.returnedLocal).toBe(false);
  expect(h.sent.at(-1)?.type).toBe("leave");
  h.session.receive({ type: "left" });
  h.view.update();
  expect(h.returnedLocal).toBe(true);
  expect(node("main").getAttribute("data-view")).toBe("solo");
  h.view.destroy();
});

test("room updates preserve form focus and phase changes do not steal focus from an open menu", () => {
  const h = harness();
  h.view.update();
  const node = (selector: string) => h.document.querySelector(selector);
  const code = node("[data-join]").querySelector("code");
  code.focus();
  h.view.update();
  expect(h.document.focused).toBe(code);
  const dialog = node("#settings-dialog");
  dialog.showModal();
  const setting = node("#settings-general");
  setting.focus();
  h.session.receive(h.cp);
  h.view.update();
  expect(node("main").getAttribute("data-view")).toBe("playing");
  expect(h.document.focused).toBe(setting);
  dialog.close();
  h.session.receive({ ...h.cp, serverSequence: 2, room: { ...h.cp.room, phase: "roundResult" } });
  h.view.update();
  expect(h.document.focused).toBe(node("#view-title"));
  h.view.destroy();
});


test("opponent boards use their owner's skin and the local override redraws immediately", async () => {
  let mode: MultiplayerSkinMode = "player";
  const images: Record<string, unknown> = { four: {}, tetrio: {} };
  const storage = { getItem: () => null, setItem() {} };
  const skins = new SkinState(() => storage, async skin => skin.url
    ? { def: skin, image: images[skin.id] as HTMLImageElement, tile: 30 } : undefined);
  await skins.select("four");
  const h = harness(undefined, { skins, skinMode: () => mode });
  h.cp.room.players[0].skin = "four";
  h.cp.room.players[1].skin = "tetrio";
  h.session.receive({ ...h.cp, serverSequence: 2 });
  h.render();
  const opponent = h.document.querySelector("[data-opponents]").children[0];
  const board = opponent.children[0].children[1].children[1];
  await Bun.sleep(0);
  h.render();
  expect(board.images.at(-1)).toBe(images.tetrio);
  mode = "local";
  h.render();
  expect(board.images.at(-1)).toBe(images.four);
  h.view.destroy();
});

test("home and mode selection hide gameplay without leaving the connected online room", () => {
  const h = harness();
  h.session.receive(h.cp);
  h.view.update();
  h.showView("home");
  expect(h.document.querySelector("#home-view").hidden).toBe(false);
  expect(h.document.querySelector("#game-view").hidden).toBe(true);
  expect(h.document.querySelector("#online").hidden).toBe(true);
  expect(h.document.querySelector("#pause-button").hidden).toBe(true);
  expect(h.session.room?.code).toBe(h.cp.room.code);
  expect(h.session.connected).toBe(true);
  expect(h.sent.some(command => command.type === "leave")).toBe(false);
  h.showView("playing");
  expect(h.document.querySelector("#home-view").hidden).toBe(true);
  expect(h.document.querySelector("#game-view").hidden).toBe(false);
  expect(h.session.room?.code).toBe(h.cp.room.code);
  h.view.destroy();
});

test("Watch replay is restricted to completed competitive participants and never practice or late joiners", () => {
  const h = harness(undefined, { replay() {} });
  const button = () => h.document.querySelector("[data-watch-replay]");
  h.session.receive({ ...h.cp, room: { ...h.cp.room, phase: "setResult" } });
  h.view.update(); expect(button().hidden).toBe(true);
  const state = { ...h.cp.state!, complete: true };
  const room = { ...h.cp.room, phase: "setResult" as const, options: { ...h.cp.room.options, mode: "competitive" as const } };
  h.session.receive({ ...h.cp, serverSequence: 2, state, room });
  h.view.update(); expect(button().hidden).toBe(false);
  h.session.playerId = "late-joiner";
  h.view.update(); expect(button().hidden).toBe(true);
  h.session.playerId = "a";
  h.session.receive({ ...h.cp, serverSequence: 3, state, room: { ...room, phase: "playing" } });
  h.view.update(); expect(button().hidden).toBe(true);
  h.view.destroy();
});

test("Watch replay retains membership, handles pending with explicit retry and opens only the same set", async () => {
  let opened = 0;
  const h = harness(undefined, { replay() { opened++; } });
  h.session.receive({ ...h.cp, state: { ...h.cp.state!, complete: true }, room: { ...h.cp.room, phase: "setResult",
    options: { ...h.cp.room.options, mode: "competitive" } } });
  h.view.update();
  const button = h.document.querySelector("[data-watch-replay]");
  let attempts = 0;
  h.session.replay = async () => { attempts++; throw new Error("Replay is still being verified. Try again shortly."); };
  button.dispatchEvent(new Event("click"));
  await Promise.resolve(); await Promise.resolve();
  expect(button.disabled).toBe(false);
  expect(h.document.querySelector("[data-replay-status]").textContent).toContain("still being verified");
  expect(attempts).toBe(1);
  expect(h.sent.some(command => command.type === "leave")).toBe(false);
  h.session.replay = async () => ({} as Awaited<ReturnType<Session["replay"]>>);
  button.dispatchEvent(new Event("click"));
  await Promise.resolve(); await Promise.resolve();
  expect(opened).toBe(1);
  expect(h.sent.some(command => command.type === "leave")).toBe(false);
  let resolve!: (value: Awaited<ReturnType<Session["replay"]>>) => void;
  h.session.replay = () => new Promise(done => { resolve = done; });
  button.dispatchEvent(new Event("click"));
  h.view.cancelReplay(); resolve({} as Awaited<ReturnType<Session["replay"]>>);
  await Promise.resolve(); await Promise.resolve();
  expect(opened).toBe(1);
  h.view.destroy();
});

test.each([false, true])("native Eden message accounting is opt-in (%s) and preserves UTF-8 payload size", enabled => {
  const priorSocket = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
  const priorWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const sockets: FakeSocket[] = [];
  class FakeSocket extends EventTarget {
    constructor(readonly url: string) { super(); sockets.push(this); }
    send() {}
    close() { this.dispatchEvent(new Event("close")); }
  }
  const storage = { getItem: () => null, setItem() {}, removeItem() {} };
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: FakeSocket });
  Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: storage, sessionStorage: storage } });
  const document = new FakeDocument();
  const diagnostics = enabled ? new SessionDiagnostics() : undefined;
  const received = spyOn(SessionDiagnostics.prototype, "receivedMessage");
  let view: ReturnType<typeof mountOnline> | undefined;
  try {
    view = mountOnline(document.root as unknown as HTMLElement, {
      clearKeys() {}, handling: () => DEFAULT_HANDLING, local() {}, skins: new SkinState(() => storage),
      skinMode: () => "player", diagnostics, inputLeadMs: enabled ? 104 : undefined,
    });
    sockets[0].dispatchEvent(new Event("open"));
    const payload = JSON.stringify({ type: "welcome", guestSessionId: "a", playerId: "a", resumeToken: "private-token",
      name: "é🎮", room: null, generation: 0, serverNow: 0 });
    sockets[0].dispatchEvent(new MessageEvent("message", { data: payload }));
    expect(view.session.connected).toBe(true);
    expect(view.session.name).toBe("é🎮");
    expect(received.mock.calls.length).toBe(enabled ? 1 : 0);
    if (diagnostics) {
      expect(diagnostics.snapshot().lead).toMatchObject({ requestedMs: 104, appliedMs: 0 });
      expect(diagnostics.snapshot().transport.maxMessageBytes).toBe(new TextEncoder().encode(payload).byteLength);
      expect(JSON.stringify(diagnostics.snapshot())).not.toContain("private-token");
      expect(JSON.stringify(diagnostics.snapshot())).not.toContain("é🎮");
    }
    view.session.retry();
    sockets[0].dispatchEvent(new MessageEvent("message", { data: payload }));
    expect(received.mock.calls.length).toBe(enabled ? 1 : 0); // closed sockets cannot pollute the next connection
  } finally {
    view?.destroy(); received.mockRestore();
    if (priorSocket) Object.defineProperty(globalThis, "WebSocket", priorSocket);
    if (priorWindow) Object.defineProperty(globalThis, "window", priorWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
