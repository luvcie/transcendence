import { recordedSet } from "./replay-fixture";
import { expect, test } from "bun:test";
import { FRAME_MS } from "@42tris/core";
import { MatchPlayback } from "@42tris/replay";
import { mountCompetitivePlayback } from "./src/competitive-playback";
import { mountReplayControls } from "./src/replay-controls";
import { FakeDocument } from "./test-dom";


test.each([2, 3, 8])("integrated viewer drives all %i boards through seek, restart and completion", async count => {
  const { replay, match } = await recordedSet(count);
  const playback = await MatchPlayback.create(replay);
  const document = new FakeDocument();
  const root = document.root as unknown as HTMLElement;
  const view = mountCompetitivePlayback(root, playback, replay.summary, { names: { p0: "Ada" } });
  const section = document.root.children[0];
  const grid = section.children[1];
  expect(grid.children.map(card => card.getAttribute("data-player-id"))).toEqual(playback.state.roster);
  expect(grid.children).toHaveLength(count);
  view.pause(); const initial = playback.state;
  view.advance(60_000);
  expect(playback.state).toEqual(initial);
  view.toggle(); view.advance(FRAME_MS * 2);
  expect(view.positionFrames).toBe(2);
  for (const speed of [0.5, 1, 2, 4]) {
    view.setSpeed(speed);
    const frame = view.positionFrames;
    view.advance(FRAME_MS * 2);
    expect(view.positionFrames).toBe(frame + speed * 2);
  }
  view.seek(view.durationFrames);
  expect(view.complete).toBe(true);
  expect(view.playing).toBe(false);
  expect(playback.state).toEqual(match.saveState());
  expect(section.children[0].textContent).toContain("Ada wins");
  expect(section.children[0].textContent).toContain("first to 1");
  view.seek(0);
  expect(playback.state).toEqual(initial);
  expect(section.children[0].textContent).not.toContain("wins");
  view.restart(); expect(view.positionFrames).toBe(0); expect(view.playing).toBe(true);
  view.dispose(); view.dispose();
  expect(document.root.children).toHaveLength(0);
  expect(view.playing).toBe(false);
  const reopened = mountCompetitivePlayback(root, await MatchPlayback.create(replay), replay.summary, {});
  expect(document.root.children).toHaveLength(1);
  reopened.dispose();
});

test("round boundaries and backward seeks restore verified winner metadata and scores", async () => {
  const { replay, boundaries } = await recordedSet(3, 2);
  const playback = await MatchPlayback.create(replay);
  const document = new FakeDocument();
  const view = mountCompetitivePlayback(document.root as unknown as HTMLElement, playback, replay.summary, {});
  view.seek(boundaries[0]);
  expect(playback.state.round).toBe(2);
  expect(playback.state.scores).toEqual([1, 0, 0]);
  expect(document.root.children[0].children[0].textContent).toBe("Round 2 · first to 2");
  view.seek(view.durationFrames);
  expect(document.root.children[0].children[0].textContent).toContain("p0 wins");
  view.seek(boundaries[0] - 1);
  expect(playback.state.round).toBe(1);
  expect(playback.state.scores).toEqual([0, 0, 0]);
  view.dispose();
});

test("shared Sprint/Match controls support toggle, all speeds, restart, seeking and disposal", async () => {
  const { replay } = await recordedSet();
  const playback = await MatchPlayback.create(replay);
  const document = new FakeDocument();
  const view = mountCompetitivePlayback(document.root as unknown as HTMLElement, playback, replay.summary, {});
  let resets = 0, exits = 0;
  const controls = mountReplayControls(document as unknown as Document, {
    playback: () => view, resetClock: () => { resets++; }, exit: () => { exits++; },
  });
  const node = (id: string) => document.querySelector(`#replay-${id}`);
  Object.assign(node("toggle"), { blur() {} });
  controls.sync(); expect(node("toggle").textContent).toBe("Pause");
  expect(node("seek").hidden).toBe(false);
  expect((node("seek") as unknown as HTMLInputElement).step).toBe("1");
  expect((node("seek") as unknown as HTMLInputElement).max).toBe(String(view.durationFrames));
  expect(node("state").textContent).toBe("Playing · 1×");
  node("toggle").dispatchEvent(new Event("click"));
  expect(view.playing).toBe(false); expect(node("toggle").textContent).toBe("Play");
  expect(node("state").textContent).toBe("Paused · 1×");
  view.advance(90_000); expect(view.positionFrames).toBe(0);
  node("toggle").dispatchEvent(new Event("click"));
  view.advance(FRAME_MS); expect(view.positionFrames).toBe(1);
  for (const speed of [0.5, 1, 2, 4]) {
    node("speed").value = String(speed); node("speed").dispatchEvent(new Event("change"));
    expect(view.speed).toBe(speed);
  }
  node("seek").value = String(view.durationFrames); node("seek").dispatchEvent(new Event("input"));
  controls.flushSeek();
  expect(node("toggle").textContent).toBe("Replay");
  expect(node("state").textContent).toBe("Finished");
  expect(node("seek").getAttribute("aria-valuetext")).toBe(node("time").textContent);
  node("seek").value = "1"; node("seek").dispatchEvent(new Event("input"));
  controls.flushSeek();
  expect(view.positionFrames).toBe(1);
  node("restart").dispatchEvent(new Event("click")); expect(view.positionFrames).toBe(0);
  node("exit").dispatchEvent(new Event("click")); expect(exits).toBe(1);
  expect(resets).toBe(9);
  controls.dispose(); node("exit").dispatchEvent(new Event("click")); expect(exits).toBe(1);
  view.dispose();
});

test("ordinary playback delivers garbage notices and queues; seek and restart clear effects", async () => {
  const { Match } = await import("@42tris/match");
  const { MatchRecorder } = await import("@42tris/replay");
  const { Input } = await import("@42tris/core");
  const match = new Match({ players: ["p0", "p1"], seed: 16, width: 4, firstTo: 1 });
  const recorder = new MatchRecorder(match, "garbage-viewer");
  recorder.submit({ player: "p0", epoch: match.playerEpoch("p0"), frame: 0, subframe: 0, order: 0, input: Input.HardDrop });
  recorder.advanceToFrame(1);
  expect(match.saveState().players[1].garbage.packets.length).toBeGreaterThan(0);
  recorder.advanceToFrame(10);
  recorder.forfeit("p1");
  const replay = await recorder.completion;
  if (!replay) throw recorder.error;
  const playback = await MatchPlayback.create(replay);
  const document = new FakeDocument();
  const view = mountCompetitivePlayback(document.root as unknown as HTMLElement, playback, replay.summary, {});
  const cards = document.root.children[0].children[1].children;
  view.advance(FRAME_MS);
  expect(cards[0].children[3].textContent).toContain("Sent");
  expect(cards[1].children[3].textContent).toContain("Incoming");
  expect(cards[1].children[2].textContent).toContain("from p0");
  view.pause(); view.advance(100_000);
  expect(cards[1].children[3].textContent).toContain("Incoming");
  view.seek(1);
  expect(cards[0].children[3].textContent).toBe("");
  expect(cards[1].children[3].textContent).toBe("");
  expect(cards[1].children[2].textContent).toContain("from p0");
  view.restart();
  expect(cards[1].children[2].textContent).toBe("No pending garbage");
  expect(cards[1].children[3].textContent).toBe("");
  view.dispose();
});

test("zero-duration aborted endings display an explicit authoritative no-winner result", async () => {
  const { Match } = await import("@42tris/match");
  const { MatchRecorder } = await import("@42tris/replay");
  const match = new Match({ players: ["p0", "p1"], seed: 16, firstTo: 1 });
  const recorder = new MatchRecorder(match, "aborted-viewer", { manualCompletion: true });
  recorder.forfeit("p0"); recorder.forfeit("p1");
  const replay = await recorder.finish();
  if (!replay) throw recorder.error;
  const playback = await MatchPlayback.create(replay);
  const document = new FakeDocument();
  const view = mountCompetitivePlayback(document.root as unknown as HTMLElement, playback, replay.summary, {});
  expect(view.complete).toBe(true);
  expect(view.durationFrames).toBe(0);
  expect(document.root.children[0].children[0].textContent).toContain("no winner");
  expect(document.root.children[0].children[0].textContent).toContain("aborted");
  view.seek(0); view.restart();
  expect(view.complete).toBe(true); expect(view.playing).toBe(false);
  view.dispose();
});
