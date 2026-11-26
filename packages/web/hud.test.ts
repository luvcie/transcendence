import { expect, test } from "bun:test";
import { Input, Piece, ROWS } from "@42tris/core";
import { SprintRecorder } from "@42tris/replay";
import { Singleplayer, SINGLEPLAYER_MODES, formatTime, finesseSummary } from "./src/singleplayer";
import { bindGameStats, snapshotDisplay } from "./src/game-display";
import { SprintPlayback } from "./src/sprint-playback";
import { sprintRecordingFor, startSprintRecording } from "./src/sprint-recording";
import { fitCanvas, pixelRatio } from "./src/canvas-resolution";
import * as domUpdate from "./src/dom-update";
import { FakeDocument } from "./test-dom";
import { NetHarness } from "./netplay-harness";

const source = await Bun.file(new URL("./src/main.ts", import.meta.url)).text();
// Exercise the production functions without starting the app's audio, network or RAF loop.
function appFunction(name: string, next: string, context: Record<string, unknown>) {
  const body = source.slice(source.indexOf(`function ${name}(`), source.indexOf(next, source.indexOf(`function ${name}(`)));
  const js = new Bun.Transpiler({ loader: "ts" }).transformSync(body);
  return new Function("context", `with (context) { ${js}; return ${name}; }`)(context) as (...args: number[]) => void;
}

function harness(mode: "zen" | "sprint" = "sprint") {
  const document = new FakeDocument();
  let writes = 0;
  const node = (id: string) => document.querySelector(`#${id}`);
  const names = {
    sprintClock: "sprint-clock", elapsedTime: "elapsed-time",
    zenStatus: "zen-status", resultPanel: "sprint-result", watchReplayButton: "watch-replay-button",
    navSettingsButton: "nav-settings-button", canvas: "board", holdCanvas: "hold-preview", nextCanvas: "next-preview",
    holdButton: "hold-button", status: "status", countdownOverlay: "sprint-countdown",
  };
  const solo = new Singleplayer(mode, 108, 0);
  const pressed = new Map();
  const context = {
    ...domUpdate, document, solo: solo as Singleplayer | SprintRecorder | null, display: solo.game,
    playback: null as SprintPlayback | null, online: null as Record<string, unknown> | null,
    openingPlayback: false, SINGLEPLAYER_MODES, snapshotDisplay, formatTime, finesseSummary, ROWS, LETTERS: "_ZLOSIJT", SprintRecorder, sprintRecordingFor,
    renderStats: bindGameStats(document as unknown as Document),
    pressed, inputMount: { clear: () => pressed.clear(), setTouchBlocked() {} },
    touchControls: {
      undoCount: null as number | null, setUndoCount(count: number | null) { this.undoCount = count; },
      restart: Object.assign(node("touch-restart"), { hidden: true }),
    },
    coarsePointer: { matches: false }, phonePortrait: { matches: false },
    holdExit: { cancel() {} }, volumeOverlay: { hide() {} },
    atHome: false, competitivePlayback: null, countdown: { active: false, label: () => null },
    holdCtx: node("hold-preview").context, nextCtx: node("next-preview").context,
    ctx: node("board").context, skins: { loaded: undefined }, showGhost: true,
    fitCanvas, pixelRatio, drawPiecePreview() {}, drawBoard() {}, renderOnlineWaiting: () => false,
    lastFrameAt: null, frameId: 0, requestAnimationFrame: () => 1,
    replayControls: { flushSeek() {} }, guestName: { update() {} },
    gameSounds: { observe() {} }, observeSoloSounds() {}, restartOnFinesseFault() {},
    syncPlaybackControls() {}, onlineSoundIdentity: () => "checkpoint",
    ...Object.fromEntries(Object.entries(names).map(([name, id]) => [name, node(id)])),
  };
  node("sprint-result").hidden = true;
  const styleValues = new Map<string, string>();
  Object.assign(node("game-view"), { style: {
    getPropertyValue: (name: string) => styleValues.get(name) ?? "",
    setProperty(name: string, value: string) { writes++; styleValues.set(name, value); },
  } });
  for (const id of [...Object.values(names), "sprint-result-title", "result-time", "result-lines", "result-pieces", "result-finesse"]) {
    const element = node(id);
    for (const key of ["textContent", "hidden", "disabled"] as const) {
      let value = element[key];
      Object.defineProperty(element, key, { get: () => value, set(next) { writes++; value = next; } });
    }
    const setAttribute = element.setAttribute.bind(element);
    element.setAttribute = (name, value) => { writes++; setAttribute(name, value); };
    const removeAttribute = element.removeAttribute.bind(element);
    element.removeAttribute = name => { writes++; removeAttribute(name); };
  }
  const refresh = appFunction("refreshHud", "\nfunction applyInput", context);
  const render = appFunction("render", "\nfunction toggleMenu", context);
  Object.assign(context, { refreshHud: refresh, render });
  const frame = appFunction("frame", "\nlet frameId", context);
  return { context, node, refresh, render, frame, styleValues, writes: () => writes };
}

test("unchanged HUD and preview values perform no writes, including after external DOM changes", () => {
  const h = harness();
  h.refresh(); h.render();
  const before = h.writes();
  for (let i = 0; i < 10; i++) { h.refresh(); h.render(); }
  expect(h.writes()).toBe(before);
  h.node("line-count").textContent = "stale";
  h.node("b2b-count").setAttribute("title", "stale");
  h.node("sprint-clock").hidden = true;
  h.refresh();
  expect(h.node("line-count").textContent).toBe("0 / 40");
  expect(h.node("b2b-count").getAttribute("title")).toBe("Clear a Quad, spin or all clear to start B2B.");
  expect(h.node("sprint-clock").hidden).toBe(false);
});

test("local touch undo is available in Zen and hidden in Sprint", () => {
  const sprint = harness("sprint");
  sprint.refresh();
  expect(sprint.context.touchControls.undoCount).toBeNull();
  const zen = harness("zen");
  zen.refresh();
  expect(zen.context.touchControls.undoCount).toBe(0);
  zen.context.solo!.tick(250);
  zen.context.solo!.apply(Input.HardDrop, 251);
  zen.refresh();
  expect(zen.context.touchControls.undoCount).toBe(1);
});

test("online touch undo is only shown to a player in phone portrait practice", () => {
  const h = harness();
  const practice = new NetHarness();
  practice.startMatch({ mode: "practice" });
  const session = practice.a.session;
  h.context.online = { session };
  h.context.coarsePointer.matches = true;
  h.render();
  expect(h.context.touchControls.undoCount).toBeNull();
  h.context.phonePortrait.matches = true;
  h.render();
  expect(h.context.touchControls.undoCount).toBe(1);

  session.practice("practiceUndo");
  expect(session.canPlay).toBe(false);
  h.render();
  expect(h.context.touchControls.undoCount).toBe(1);
  practice.runUntil(() => session.canPlay);

  const room = session.room!;
  session.room = { ...room, phase: "paused" };
  h.render();
  expect(h.context.touchControls.undoCount).toBeNull();

  session.room = room;
  session.playerId = "spectator";
  h.render();
  expect(h.context.touchControls.undoCount).toBeNull();
  session.playerId = practice.aCheckpoint!.state!.roster[0];

  Object.assign(h.context, { competitivePlayback: {} });
  h.render();
  expect(h.context.touchControls.undoCount).toBeNull();
  Object.assign(h.context, { competitivePlayback: null });

  const competitive = new NetHarness();
  competitive.startMatch();
  h.context.online = { session: competitive.a.session };
  h.render();
  expect(h.context.touchControls.undoCount).toBeNull();
});

test("touch restart is visible in solo and online practice but hidden in competitive matches", () => {
  const h = harness();
  h.render();
  expect(h.context.touchControls.restart.hidden).toBe(false);
  const options = { mode: "competitive" };
  h.context.online = { session: { room: { options }, canPlay: true } };
  h.render();
  expect(h.context.touchControls.restart.hidden).toBe(true);
  options.mode = "practice";
  h.render();
  expect(h.context.touchControls.restart.hidden).toBe(false);
});

test("mutable clear statistics, the B2B value and its Surge art, and attack labels update immediately", () => {
  const h = harness();
  h.refresh();
  const game = { ...snapshotDisplay(h.context.display.saveState()), stats: { ...h.context.display.stats } };
  Object.assign(h.context, { display: game });
  Object.assign(game, { stats: { ...game.stats, lines: 4, combo: 2, chainLength: 1, b2b: 0, surge: 0 } });
  h.refresh();
  expect(h.node("line-count").textContent).toBe("4 / 40");
  expect(h.node("combo-count").textContent).toBe("2");
  expect(h.node("b2b-count").textContent).toBe("Ready");
  expect(h.node("b2b-count").getAttribute("title")).toBe("Chain started. The next qualifying clear earns the B2B bonus.");
  expect(h.node("b2b-value").getAttribute("data-charged")).toBeNull();
  Object.assign(game, { stats: { ...game.stats, chainLength: 3, b2b: 2 } });
  Object.assign(game, { lastClear: { rows: [38, 39], spin: "mini", piece: Piece.T, allClear: true, attacks: [{ lines: 3 }, { lines: 2 }] } });
  h.refresh();
  expect(h.node("b2b-count").textContent).toBe("×2");
  expect(h.node("b2b-count").getAttribute("title")).toBe("2 back-to-back clears.");
  expect(h.node("b2b-value").getAttribute("data-charged")).toBeNull();
  expect(h.node("clear-result").textContent).toBe("T-spin mini Double · All clear · Attack 5");
  for (const [b2b, tint] of [
    [4, "#00ffcc"], [5, "#00ff99"], [8, "#00ff00"], [12, "#ffff00"], [16, "#ffc600"],
    [24, "#ff5500"], [30, "#ff0000"], [32, "#ff0011"], [48, "#ff0099"], [60, "#ff00ff"],
    [77, "#933eff"], [100, "#0091ff"], [123, "#44c4f3"], [150, "#94ffe4"],
    [250, "#ffdd87"], [500, "#ffffff"], [501, "#ffffff"],
  ] as const) {
    Object.assign(game.stats, { chainLength: b2b + 1, b2b, surge: b2b });
    h.refresh();
    expect(h.node("b2b-count").textContent).toBe(String(b2b));
    expect(h.node("b2b-value").getAttribute("data-charged")).toBe("");
    expect(h.node("b2b-value").getAttribute("style")).toContain(`--b2b-digits: ${String(b2b).length}`);
    expect(h.node("b2b-value").getAttribute("style")).toContain(`--surge-color: ${tint};`);
    const before = h.writes(); h.refresh(); expect(h.writes()).toBe(before);
  }
  Object.assign(game, { lastClear: null });
  Object.assign(game, { stats: { ...game.stats, combo: -1, chainLength: 0, b2b: 0, surge: 0 } });
  h.refresh();
  expect(h.node("combo-count").textContent).toBe("0");
  expect(h.node("clear-result").textContent).toBe("");
  expect(h.node("b2b-count").textContent).toBe("—");
  expect(h.node("b2b-value").getAttribute("data-charged")).toBeNull();
  expect(h.node("b2b-value").getAttribute("style")).toBeNull();
});

test("Sprint timer retains millisecond updates and finesse changes after placements", () => {
  const h = harness();
  const run = h.context.solo!;
  h.refresh();
  expect(h.node("zen-status").hidden).toBe(false);
  run.apply(Input.LeftDown, 100);
  run.apply(Input.LeftUp, 100);
  run.apply(Input.RightDown, 101);
  run.apply(Input.RightUp, 101);
  run.apply(Input.HardDrop, 102);
  h.refresh();
  expect(run.game.finesse.faults).toBeGreaterThan(0);
  expect(h.node("finesse-count").textContent).toBe(finesseSummary(run.game.finesse));
  expect(h.node("zen-status").hidden).toBe(true);
  run.tick(1334); h.refresh();
  expect(h.node("elapsed-time").textContent).toBe("0:01.234");
  run.tick(1335); h.refresh();
  expect(h.node("elapsed-time").textContent).toBe("0:01.235");
});

test("restart and Zen/Sprint switching reset statistics, timer and visibility", () => {
  const h = harness("zen");
  h.context.solo!.tick(250);
  h.context.solo!.apply(Input.HardDrop, 300);
  h.refresh();
  expect(h.node("zen-status").textContent).toBe("Zen · Ctrl+Z to undo (1 available)");
  for (const mode of ["sprint", "zen", "sprint"] as const) {
    h.context.solo = new Singleplayer(mode, 108, 0);
    h.context.display = h.context.solo.game;
    h.refresh();
    expect(h.node("line-count").textContent).toBe(mode === "sprint" ? "0 / 40" : "0");
    expect(h.node("elapsed-time").textContent).toBe("0:00.000");
    expect(h.node("sprint-clock").hidden).toBe(mode !== "sprint");
    expect(h.node("finesse-count").textContent).toBe(finesseSummary(h.context.solo.game.finesse));
    expect(h.node("clear-result").textContent).toBe("");
  }
});

test.each(["complete", "failed"])("%s results keep text, focus and repeated refresh behavior", outcome => {
  const h = harness();
  Object.assign(h.context.solo!, { result: { outcome, elapsedMs: 12345, stats: { lines: 40, pieces: 102 }, finesse: { evaluated: 100, faults: 2, points: 490 } } });
  h.context.pressed.set("Space", "drop");
  h.refresh();
  expect(h.node("sprint-result").hidden).toBe(false);
  expect(h.node("sprint-result-title").textContent).toBe(outcome === "complete" ? "Sprint complete" : "Topped out");
  expect(h.node("result-time").textContent).toBe("0:12.345");
  expect(h.node("result-lines").textContent).toBe(`40 / 40 lines cleared${outcome === "failed" ? " · Attempt failed" : ""}`);
  expect(h.node("result-pieces").textContent).toBe("102 pieces placed");
  expect(h.node("result-finesse").textContent).toBe(`Finesse ${finesseSummary(h.context.solo!.result!.finesse)}`);
  expect(h.context.document.focused).toBe(h.node("sprint-result-title"));
  expect(h.context.pressed.size).toBe(0);
  const before = h.writes(); h.refresh(); expect(h.writes()).toBe(before);
});

test("preview labels, width and hold availability follow game state without redundant writes", () => {
  const h = harness("zen");
  h.context.solo!.tick(250);
  h.render();
  expect(h.node("hold-preview").getAttribute("aria-label")).toBe("Hold empty");
  h.context.solo!.apply(Input.Hold, 251); h.render();
  expect(h.node("hold-preview").getAttribute("aria-label")).toBe(`Held piece ${h.context.LETTERS[h.context.display.held!]}`);
  expect(h.node("hold-button").disabled).toBe(false);
  const nextHeld = h.context.display.piece;
  h.context.solo!.apply(Input.Hold, 252); h.render();
  expect(h.node("hold-preview").getAttribute("aria-label")).toBe(`Held piece ${h.context.LETTERS[nextHeld]}`);
  expect(h.node("hold-button").disabled).toBe(false);
  expect(h.node("next-preview").getAttribute("aria-label")).toBe("Next pieces:" + Array.from(h.context.display.previews, p => ` ${h.context.LETTERS[p]}`).join(""));
  h.context.solo = new Singleplayer("zen", 108, 0, undefined, 12);
  h.context.display = h.context.solo.game; h.render();
  expect(h.styleValues.get("--board-ratio")).toBe("1.2");
  expect(h.node("board").getAttribute("aria-label")).toBe("42tris playfield");
});

test("multiplayer frame displays checkpoint statistics, score, top-out and waiting status", () => {
  const h = harness("zen");
  const state = h.context.display.saveState();
  const session = {
    name: "Player", playerId: "p", room: { phase: "playing", options: { mode: "practice" } }, canPlay: true,
    prediction: { gameState: () => state },
    checkpoint: { state: { roster: ["p"], scores: [1], players: [{ game: state }] } },
  };
  h.context.online = { session, update() {} };
  h.frame(100);
  expect(h.node("status").textContent).toBe("Player (you) · 1 point");
  expect(h.node("zen-status").textContent).toBe("Online practice · Ctrl+Z to undo; restart resets your board.");
  const replacement = new Singleplayer("zen", 108, 0).game;
  replacement.tick(250);
  replacement.apply(Input.HardDrop, 251);
  const next = replacement.saveState();
  next.lastResult = { ...next.lastResult!, stats: { ...next.lastResult!.stats, chainLength: 6, b2b: 5, surge: 5 } };
  session.prediction.gameState = () => next;
  session.checkpoint.state.players[0].game = next;
  session.checkpoint.state.scores[0] = 3;
  next.state.topOut = true;
  h.frame(116);
  expect(h.node("status").textContent).toBe("Player (you) · 3 points · Top out");
  expect(h.node("finesse-count").textContent).toBe(finesseSummary(snapshotDisplay(next).finesse));
  expect(h.node("b2b-count").textContent).toBe("5");
  expect(h.node("b2b-value").getAttribute("data-charged")).toBe("");
  expect(h.node("hold-button").disabled).toBe(true);
  h.context.phonePortrait.matches = true;
  h.frame(120);
  expect(h.node("finesse-count").textContent).toBe("100.0%");
  const before = h.writes(); h.frame(124); expect(h.writes()).toBe(before);
  session.room.phase = "waiting"; h.frame(132);
  expect(h.node("status").hidden).toBe(true);
});

test("Sprint replay playback, seeking and exit restore the live result and replay metadata", async () => {
  const h = harness();
  const run = startSprintRecording(108, 0, h.context.solo!.game.handling);
  for (let at = 100; !run.result; at += 100) run.apply(Input.HardDrop, at);
  await run.completion;
  await Promise.resolve();
  const recording = sprintRecordingFor(run)!;
  expect(recording).not.toBeNull();
  h.context.solo = run; h.context.display = run.game;
  h.refresh();
  expect(h.node("watch-replay-button").textContent).toBe("Watch replay");
  expect(h.node("watch-replay-button").getAttribute("title")).toBe("Watch this attempt from the beginning");
  const before = h.writes(); h.refresh(); expect(h.writes()).toBe(before);
  h.context.openingPlayback = true; h.refresh();
  expect(h.node("watch-replay-button").disabled).toBe(true);
  expect(h.node("watch-replay-button").textContent).toBe("Opening replay…");
  h.context.openingPlayback = false;
  h.context.playback = await SprintPlayback.create(recording.replay);
  h.node("sprint-result").hidden = true;
  h.frame(0); h.frame(100);
  expect(h.node("elapsed-time").textContent).toBe(formatTime(h.context.playback.elapsedMs));
  expect(h.node("zen-status").hidden).toBe(true);
  await h.context.playback.seek(0);
  h.context.display = snapshotDisplay(h.context.playback.state) as typeof h.context.display;
  h.refresh();
  expect(h.node("elapsed-time").textContent).toBe("0:00.000");
  expect(h.node("line-count").textContent).toBe("0 / 40");
  h.context.playback.seek(h.context.playback.durationMs);
  h.frame(200);
  expect(h.node("sprint-result").hidden).toBe(true);
  expect(h.node("finesse-count").textContent).toBe(finesseSummary(run.game.finesse));
  Object.assign(h.context, {
    activePlayback: () => h.context.playback,
    matchReplayHost: h.node("match-replay-host"), replaySeek: h.node("replay-seek"), replayBar: h.node("replay-bar"),
    showView() {},
  });
  Object.assign(h.context, { stopPlayback: appFunction("stopPlayback", "\nfunction backToResults", h.context) });
  appFunction("backToResults", "\nfunction watchCompetitiveReplay", h.context)();
  expect(h.node("sprint-result").hidden).toBe(false);
  expect(h.node("result-time").textContent).toBe(formatTime(run.result!.elapsedMs));
  expect(h.node("elapsed-time").textContent).toBe(formatTime(run.elapsedMs));
  expect(h.node("finesse-count").textContent).toBe(finesseSummary(run.game.finesse));
});
