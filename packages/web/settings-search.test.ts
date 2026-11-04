import { expect, test } from "bun:test";
import { setupSettingsSearch } from "./src/settings-search";
import { FakeDocument } from "./test-dom";

test("settings search filters rows in place and clearing it restores the catalog", () => {
  const document = new FakeDocument();
  const input = document.createElement(), list = document.createElement(), empty = document.createElement();
  const rows = ["tetrio TETR.IO", "Pizza Tower Octoling", "Custom 3 https://example.com/my-skin.png"]
    .map(search => Object.assign(document.createElement(), { dataset: { search } }));
  rows[2].setAttribute("aria-pressed", "true");
  list.append(...rows);
  const filter = setupSettingsSearch(input as unknown as HTMLInputElement, list as unknown as HTMLElement, empty as unknown as HTMLElement);
  const search = (value: string) => { input.value = value; input.dispatchEvent(new Event("input")); };

  filter();
  expect(rows.map(row => row.hidden)).toEqual([false, false, false]);
  search("  OCTOLING  ");
  expect(rows.map(row => row.hidden)).toEqual([true, false, true]);
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
  expect(list.children).toEqual(rows);
  expect(rows[2].getAttribute("aria-pressed")).toBe("true");

  search("new skin");
  list.replaceChildren(Object.assign(document.createElement(), { dataset: { search: "New skin" } }));
  filter();
  expect(list.children[0].hidden).toBe(false);
  expect(empty.hidden).toBe(true);
});
