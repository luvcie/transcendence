import { expect, test } from "bun:test";
import { mountAppView } from "./src/app-view";
import { FakeDocument } from "./test-dom";

test("both replay screens share one accessible control bar outside their board containers", async () => {
  const ids: string[] = [], sections: string[] = [], actions: string[] = [];
  const html = await new HTMLRewriter()
    .on("#replay-bar", { element(element) { ids.push(element.getAttribute("id")!); } })
    .on("main > #replay-bar > div", { element(element) { sections.push(element.getAttribute("class")!); } })
    .on(".replay-actions > *", { element(element) { actions.push(element.getAttribute("id") ?? element.tagName); } })
    .on("#replay-state", { element(element) {
      expect(element.getAttribute("role")).toBe("status");
      expect(element.getAttribute("aria-live")).toBe("polite");
    } })
    .on(".replay-timeline > *", { element(element) {
      expect(element.getAttribute("aria-label")).not.toBeNull();
      expect(element.tagName).toBe("input");
      expect(element.getAttribute("type")).toBe("range");
    } })
    .transform(new Response(Bun.file(new URL("./index.html", import.meta.url)))).text();
  expect(html.length).toBeGreaterThan(0);
  expect(ids).toEqual(["replay-bar"]);
  expect(sections).toEqual(["replay-status", "replay-timeline", "replay-actions"]);
  expect(actions).toEqual(["replay-toggle", "replay-restart", "label", "replay-exit"]);
});

test.each(["sprintReplay", "matchReplay"] as const)("%s enters and leaves shared replay styling without losing mode navigation", view => {
  const document = new FakeDocument();
  const showView = mountAppView(document as unknown as Document);
  const node = (selector: string) => document.querySelector(selector);
  const singleplayer = view === "sprintReplay";
  const result = singleplayer ? "solo" : "setResult";
  for (let opening = 0; opening < 2; opening++) {
    showView(result);
    showView(view);
    expect(node("main").getAttribute("data-replay")).toBe("");
    expect(node("#view-title").textContent).toBe(singleplayer ? "Sprint replay" : "Competitive replay");
    expect(node("#game-view").hidden).toBe(!singleplayer);
    expect(node("#online").hidden).toBe(true);
    expect(node("#solo-button").getAttribute("aria-current")).toBe(singleplayer ? "page" : "false");
    expect(document.focused).toBe(node("#view-title"));
    showView(result);
    expect(node("main").getAttribute("data-replay")).toBeNull();
    expect(node("#view-title").textContent).toBe(singleplayer ? "Singleplayer" : "Set results");
    expect(node("#game-view").hidden).toBe(false);
    expect(node("#online").hidden).toBe(singleplayer);
  }
  showView(view);
  showView("home");
  expect(node("main").getAttribute("data-replay")).toBeNull();
  expect(node("#game-view").hidden).toBe(true);
  expect(node("#home-view").hidden).toBe(false);
});
