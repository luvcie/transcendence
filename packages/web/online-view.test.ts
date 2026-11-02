import { expect, test } from "bun:test";
import { DEFAULT_HANDLING } from "@42tris/core";
import { Match } from "@42tris/match";
import type { Checkpoint, ClientCommand, RoomPhase } from "@42tris/protocol";
import { mountAppView } from "./src/app-view";
import { mountOnline } from "./src/online-view";
import { renderOnlineWaiting } from "./src/waiting-view";
import { Session } from "./src/session";
import { SkinState } from "./src/skin-state";

class Element extends EventTarget {
  textContent = "";
  innerHTML = "";
  value: string | number = "";
  hidden = false;
  disabled = false;
  checked = false;
  open = false;
  width = 300;
  height = 600;
  children: Element[] = [];
  parentElement?: Element;
  nodes = new Map<string, Element>();
  attributes = new Map<string, string>();
  className = "";
  classes = new Set<string>();
  classList = { add: (name: string) => this.classes.add(name), remove: (name: string) => this.classes.delete(name) };
  calls: string[] = [];
  elements = { namedItem: (name: string) => this.querySelector(name) };
  context = {
    canvas: this, clearRect: () => { this.calls.push("clear"); }, fillRect: () => { this.calls.push("tile"); },
    fillText: (text: string) => { this.calls.push(text); }, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, strokeRect() {},
  };
  constructor(readonly ownerDocument: FakeDocument) { super(); }
  querySelector(selector: string): Element {
    if (!this.nodes.has(selector)) this.nodes.set(selector, new Element(this.ownerDocument));
    return this.nodes.get(selector)!;
  }
  append(...children: Element[]) { children.forEach(child => { child.remove(); child.parentElement = this; this.children.push(child); }); }
  replaceChildren(...children: Element[]) { this.children = []; this.append(...children); }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(c => c !== this); }
  setAttribute(key: string, value: string) { this.attributes.set(key, value); }
  getAttribute(key: string) { return this.attributes.get(key) ?? null; }
  removeAttribute(key: string) { this.attributes.delete(key); }
  showModal() { this.open = true; }
  close() { this.open = false; }
  focus() { this.ownerDocument.focused = this; }
  getContext() { return this.context; }
}
class FakeDocument {
  location = new URL("http://localhost:5173/");
  root = new Element(this);
  focused?: Element;
  createElement() { return new Element(this); }
  querySelector(selector: string): Element {
    if (selector === "dialog[open]") return [...this.root.nodes.values()].find(node => node.open) ?? null as unknown as Element;
    return this.root.querySelector(selector);
  }
}

function harness(invite?: string) {
  const document = new FakeDocument();
  if (invite !== undefined) document.location = new URL(`https://example.com/?room=${invite}`);
  const storage = { getItem: () => null, setItem() {}, removeItem() {} };
  const sent: ClientCommand[] = [];
  let returnedLocal = false;
  const showView = mountAppView(document as unknown as Document);
  showView("solo");
  const session = new Session({ now: () => 0, storage, profile: storage, clearKeys() {},
    connect: () => ({ send(command) { sent.push(command); }, close() {} }) });
  const view = mountOnline(document.root as unknown as HTMLElement, {
    session, invite, clearKeys() {}, handling: () => DEFAULT_HANDLING, view: showView,
    local() { returnedLocal = true; showView("solo"); },
    skins: new SkinState(() => storage),
  });
  session.receive({ type: "welcome", guestSessionId: "a", playerId: "a", resumeToken: "token", name: "A", room: null, generation: 0, serverNow: 0 });
  const match = new Match({ players: ["a", "b"], seed: 123, mode: "practice" });
  const state = match.saveState();
  state.players[1].game.board[390] = 1;
  const cp: Checkpoint = {
    type: "checkpoint", serverSequence: 1, serverNow: 0, matchId: "match", state,
    room: { code: "ABCDEF", revision: 1, ownerId: "a", options: { firstTo: 3, maxPlayers: 4, mode: "practice", attacksEnabled: true },
      phase: "playing", matchId: "match", preparationId: 1, startsAt: null, prepareDeadline: null,
      players: ["a", "b"].map(playerId => ({ playerId, name: playerId, connected: true, ready: true, prepared: true, deadline: null, withdrawn: false })) },
    owner: { generation: 0, epoch: 0, nextSeq: 1, resolvedThroughSeq: 0, pendingAccepted: [], rejections: [] },
    clock: { currentTargetFrame: 0, simulationNow: 0, origin: 0, pausedTotal: 0, commitDelayMs: 100, frozen: false }, events: [],
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
  h.session.receive({ ...h.cp, state, room: { ...h.cp.room, players: ids.map(playerId => ({ playerId, name: playerId, connected: true, ready: true, prepared: true, deadline: null, withdrawn: false })) } });
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
    expect(node("[data-ready]").hidden).toBe(!["roundResult", "setResult"].includes(phase));
    expect(node("[data-round-summary]").hidden).toBe(!["roundResult", "setResult"].includes(phase));
    expect(node("[data-options]").hidden).toBe(phase !== "setResult");
    h.view.destroy();
  },
);

test("round and set results retain scores and send explicit next-round/rematch readiness", () => {
  const h = harness();
  const node = (selector: string) => h.document.querySelector(selector);
  for (const [index, phase] of (["roundResult", "setResult"] as const).entries()) {
    h.session.receive({ ...h.cp, serverSequence: index + 2, room: { ...h.cp.room, phase, players: h.cp.room.players.map(p => ({ ...p, ready: false })) },
      events: [{ sequence: 1, event: { type: phase === "roundResult" ? "roundEnd" : "setEnd", round: h.cp.state!.round,
        winner: "b", atMs: 0, reason: "forfeit", complete: phase === "setResult" } }] });
    h.view.update();
    expect(node("[data-result]").textContent).toContain("b wins");
    expect(node("[data-scores]").children.map(c => c.textContent)).toEqual(["a (you): 0 · Finesse —, 0 faults / 0 evaluated", "b: 0 · Finesse —, 0 faults / 0 evaluated"]);
    expect(node("[data-ready]").textContent).toBe(phase === "roundResult" ? "Ready for next round" : "Ready for rematch");
    node("[data-ready]").dispatchEvent(new Event("click"));
    expect(h.sent.at(-1)).toEqual({ type: "ready", ready: true, handling: DEFAULT_HANDLING });
  }
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
  h.session.receive({ type: "welcome", guestSessionId: "a", playerId: "a", resumeToken: "token", name: "A", room: { ...h.cp.room, phase: "roundResult" }, generation: 1, serverNow: 0 });
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
