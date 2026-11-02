import { expect, test } from "bun:test";
import { mountGuestName } from "./src/guest-name";
import type { Session } from "./src/session";

class Node extends EventTarget {
  hidden = false;
  disabled = false;
  textContent = "";
  value = "";
  focused = false;
  nodes = new Map<string, Node>();
  elements = { namedItem: () => this.querySelector("input") };
  querySelector(selector: string) {
    if (!this.nodes.has(selector)) this.nodes.set(selector, new Node());
    return this.nodes.get(selector)!;
  }
  focus() { this.focused = true; }
  select() {}
}
function key(key: string) {
  const event = new Event("keydown", { cancelable: true });
  Object.defineProperty(event, "key", { value: key });
  return event;
}

test("waiting header edits only the local name and preserves the draft during updates", () => {
  const root = new Node();
  const button = root.querySelector("[data-edit-name]");
  const label = root.querySelector("[data-current-name]");
  const form = root.querySelector("[data-edit-form]");
  const input = form.querySelector("input");
  form.hidden = true;
  const names: string[] = [];
  const session = { connected: true, playerId: "a", name: "Guest", room: { phase: "waiting", players: [{ playerId: "a", name: "Guest" }, { playerId: "b", name: "Other" }] }, rename: (name: string) => names.push(name) };
  const editor = mountGuestName(root as unknown as HTMLElement, () => session as unknown as Session);
  editor.update();
  expect(label.textContent).toBe("Guest");
  button.dispatchEvent(new Event("click"));
  expect(input.value).toBe("Guest");
  input.value = "New name";
  editor.update();
  expect(input.value).toBe("New name");
  form.dispatchEvent(key("Escape"));
  expect(names).toEqual([]);
  expect(form.hidden).toBe(true);
  button.dispatchEvent(new Event("click"));
  input.value = "New name";
  form.dispatchEvent(new Event("submit", { cancelable: true }));
  expect(names).toEqual(["New name"]);
  expect(button.focused).toBe(true);
  session.connected = false;
  editor.update();
  expect(button.disabled).toBe(true);
  session.room.phase = "playing";
  editor.update();
  expect(root.hidden).toBe(true);
});
