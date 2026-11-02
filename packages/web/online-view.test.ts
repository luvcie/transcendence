import { expect, test } from "bun:test";
import { DEFAULT_HANDLING } from "@42tris/core";
import { Match } from "@42tris/match";
import type { Checkpoint } from "@42tris/protocol";
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
  width = 300;
  height = 600;
  children: Element[] = [];
  parentElement?: Element;
  nodes = new Map<string, Element>();
  attributes = new Map<string, string>();
  calls: string[] = [];
  elements = { namedItem: (name: string) => this.querySelector(name) };
  context = {
    canvas: this, clearRect: () => { this.calls.push("clear"); }, fillRect: () => { this.calls.push("tile"); },
    fillText: (text: string) => { this.calls.push(text); }, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
  };
  constructor(readonly ownerDocument: FakeDocument) { super(); }
  querySelector(selector: string): Element {
    if (!this.nodes.has(selector)) this.nodes.set(selector, new Element(this.ownerDocument));
    return this.nodes.get(selector)!;
  }
  append(...children: Element[]) { children.forEach(child => { child.parentElement = this; this.children.push(child); }); }
  replaceChildren(...children: Element[]) { this.children = []; this.append(...children); }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(c => c !== this); }
  setAttribute(key: string, value: string) { this.attributes.set(key, value); }
  removeAttribute(key: string) { this.attributes.delete(key); }
  getContext() { return this.context; }
}
class FakeDocument {
  location = new URL("http://localhost:5173/");
  root = new Element(this);
  createElement() { return new Element(this); }
  querySelector(selector: string) { return this.root.querySelector(selector); }
}

function harness() {
  const document = new FakeDocument();
  const storage = { getItem: () => null, setItem() {}, removeItem() {} };
  const session = new Session({ now: () => 0, storage, profile: storage, clearKeys() {},
    connect: () => ({ send() {}, close() {} }) });
  const view = mountOnline(document.root as unknown as HTMLElement, {
    session, clearKeys() {}, handling: () => DEFAULT_HANDLING, local() { throw new Error("Must remain online"); },
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
  return { document, session, view, cp, render };
}

test("mounted opponent view renders settlement-required snapshots without restoring or simulating a Game", () => {
  const h = harness();
  const before = structuredClone(h.cp.state);
  expect(h.cp.state!.players[1].game.settlementRequired).toBe(true);
  h.session.receive(h.cp);
  expect(h.render()).toBe(false);
  const opponents = h.document.querySelector("[data-opponents]");
  expect(opponents.children).toHaveLength(1);
  expect(opponents.children[0].children[0].textContent).toContain("b · 0 points");
  expect(opponents.children[0].children[1].calls).toContain("tile");
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
  node("[data-meter]").value = 12;
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
  expect(node("[data-garbage]").textContent).toBe("");
  expect(node("[data-meter]").value).toBe(0);
  expect(node("[data-meter]").hidden).toBe(true);
  expect(node("#board").calls).toContain("Waiting for a match");
  for (const id of ["hold-preview", "next-preview"]) expect(node(`#${id}`).calls).toContain("clear");
  for (const id of ["line-count", "combo-count", "b2b-count", "surge-count", "clear-result", "zen-status"]) expect(node(`#${id}`).textContent).toBe("");
  expect(node("#hold-button").disabled).toBe(true);
  expect(node("#zen-status").hidden).toBe(true);
  h.session.receive({ ...h.cp, serverSequence: 3, matchId: "next-match" });
  expect(h.render()).toBe(false);
  expect(node("[data-opponents]").children).toHaveLength(1);
  expect(node("[data-meter]").hidden).toBe(false);
  h.view.destroy();
});
