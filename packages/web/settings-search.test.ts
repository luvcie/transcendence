import { expect, test } from "bun:test";
import { createSettingsGroup, setupSettingsSearch } from "./src/settings-search";
import { Element, FakeDocument } from "./test-dom";

test("settings search reveals matching groups and restores their open state when cleared", () => {
  const document = new FakeDocument();
  const input = document.createElement(), list = document.createElement(), empty = document.createElement();
  const rows = ["tetrio TETR.IO", "Pizza Tower Octoling", "Custom 3 https://example.com/my-skin.png"]
    .map(search => Object.assign(document.createElement(), { dataset: { search } }));
  rows[2].setAttribute("aria-pressed", "true");
  const group = (label: string, open: boolean) => createSettingsGroup(list as unknown as HTMLElement, label, open) as unknown as Element;
  const presets = group("Jstris+ presets", true), community = group("TETR.IO+ database", false), custom = group("Custom", false);
  presets.append(rows[0]); community.append(rows[1]); custom.append(rows[2]);
  const groups = [...list.children];
  const counts = () => groups.map(group => group.children[0].children[0].textContent);
  const filter = setupSettingsSearch(input as unknown as HTMLInputElement, list as unknown as HTMLElement, empty as unknown as HTMLElement);
  const search = (value: string) => { input.value = value; input.dispatchEvent(new Event("input")); };

  filter();
  expect(rows.map(row => row.hidden)).toEqual([false, false, false]);
  expect(groups.map(group => group.open)).toEqual([true, false, false]);
  expect(counts()).toEqual(["1", "1", "1"]);
  search("  OCTOLING  ");
  expect(rows.map(row => row.hidden)).toEqual([true, false, true]);
  expect(groups.map(group => group.hidden)).toEqual([true, false, true]);
  expect(groups.map(group => group.open)).toEqual([false, true, false]);
  expect(counts()).toEqual(["0/1", "1/1", "0/1"]);
  expect(empty.hidden).toBe(true);
  search("tetrio");
  expect(rows.map(row => row.hidden)).toEqual([false, true, true]);
  search("my-skin.png");
  expect(rows.map(row => row.hidden)).toEqual([true, true, false]);
  search("nothing matches");
  expect(rows.every(row => row.hidden)).toBe(true);
  expect(empty.hidden).toBe(false);
  search("");
  expect(rows.map(row => row.hidden)).toEqual([false, false, false]);
  expect(empty.hidden).toBe(true);
  expect(groups.map(group => group.open)).toEqual([true, false, false]);
  expect(groups.every(group => !group.hidden)).toBe(true);
  expect(counts()).toEqual(["1", "1", "1"]);
  expect(presets.children).toEqual([rows[0]]);
  expect(rows[2].getAttribute("aria-pressed")).toBe("true");

  groups[0].open = false; groups[2].open = true;
  search("octoling");
  search("");
  expect(groups.map(group => group.open)).toEqual([false, false, true]);

  search("new skin");
  list.replaceChildren();
  const added = group("Custom", true);
  added.append(Object.assign(document.createElement(), { dataset: { search: "New skin" } }));
  filter();
  expect(list.children[0].hidden).toBe(false);
  expect(empty.hidden).toBe(true);
  search("");
  expect(list.children[0].open).toBe(true);
});

test("nested categories count skins, reveal matching branches, and restore each open state", () => {
  const document = new FakeDocument();
  const input = document.createElement(), list = document.createElement(), empty = document.createElement();
  const group = (parent: Element, label: string, open: boolean) =>
    createSettingsGroup(parent as unknown as HTMLElement, label, open) as unknown as Element;
  const database = group(list, "TETR.IO+ database", false);
  const standard = group(database, "Standard", false), connected = group(database, "Connected", true), animated = group(database, "Animated", false);
  const rows = ["Carbon Fiber", "Nightjar, Transmit", "Axiom Verge", "Cloud"]
    .map(search => Object.assign(document.createElement(), { dataset: { search } }));
  standard.append(rows[0]); connected.append(rows[1]); animated.append(rows[2], rows[3]);
  const groups = [list.children[0], ...database.children];
  const counts = () => groups.map(group => group.children[0].children[0].textContent);
  const filter = setupSettingsSearch(input as unknown as HTMLInputElement, list as unknown as HTMLElement, empty as unknown as HTMLElement);
  const search = (value: string) => { input.value = value; input.dispatchEvent(new Event("input")); };

  filter();
  expect(counts()).toEqual(["4", "1", "1", "2"]);
  search("axiom");
  expect(groups.map(group => group.hidden)).toEqual([false, true, true, false]);
  expect(groups.map(group => group.open)).toEqual([true, false, false, true]);
  expect(rows.map(row => row.hidden)).toEqual([true, true, false, true]);
  expect(counts()).toEqual(["1/4", "0/1", "0/1", "1/2"]);
  search("nightjar");
  expect(groups.map(group => group.hidden)).toEqual([false, true, false, true]);
  search("nothing matches");
  expect(groups.every(group => group.hidden)).toBe(true);
  expect(empty.hidden).toBe(false);
  search("");
  expect(groups.map(group => group.open)).toEqual([false, false, true, false]);
  expect(groups.every(group => !group.hidden)).toBe(true);
  expect(rows.every(row => !row.hidden)).toBe(true);
  expect(counts()).toEqual(["4", "1", "1", "2"]);
  expect(empty.hidden).toBe(true);
});
