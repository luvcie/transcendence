import { describe, expect, spyOn, test } from "bun:test";
import { canPlace, clearRows, DEFAULT_HANDLING, FRAME_MS, Input, place, ROWS, type Game, type InputId } from "@42tris/core";
import { MatchPlayback, MatchRecorder, SprintRecorder } from "@42tris/replay";
import { Match } from "@42tris/match";
import { GameSounds } from "./src/game-sounds";
import { withMatchReplaySounds, withSprintReplaySounds, type ReplaySoundOutput } from "./src/replay-sounds";
import { SprintPlayback } from "./src/sprint-playback";
import { clearClips, type SoundClip, type SoundPack } from "./src/sound-pack";
import { recordedSet } from "./replay-fixture";
import { mountReplayControls } from "./src/replay-controls";
import { mountCompetitivePlayback } from "./src/competitive-playback";
import { FakeDocument } from "./test-dom";

const url = (event: string) => `https://example.com/${event}.ogg`;
const pack: SoundPack = {
  name: "Replay test", move: url("move"), rotate: url("rotate"), harddrop: url("drop"), lock: url("lock"),
  hold: url("hold"), go: url("go"), died: url("died"), success: url("success"), fault: url("fault"),
  scoring: { CLEAR1: url("single"), CLEAR2: url("double"), CLEAR3: url("triple"), CLEAR4: url("quad"), PERFECT_CLEAR: url("all-clear") },
  spawns: Object.fromEntries(["I", "O", "T", "L", "J", "S", "Z"].map(piece => [piece, url(piece)])),
  comboTones: [null, url("combo1"), url("combo2")],
};

function output() {
  const clips: SoundClip[] = [];
  let selected: SoundPack | undefined = pack;
  let stops = 0;
  const audio: ReplaySoundOutput = { pack: () => selected, play: next => clips.push(...next), stop: () => { stops++; } };
  return { audio, clips, get stops() { return stops; }, select(next?: SoundPack) { selected = next; } };
}

function recording(seed = 5) {
  const recorder = new SprintRecorder(seed, 1000, { ...DEFAULT_HANDLING, arr: 0, sdarr: 0 });
  const clips: SoundClip[] = [];
  const sounds = new GameSounds(() => pack, next => clips.push(...next));
  sounds.observe(recorder.game, recorder.game);
  function send(input: InputId, at: number) {
    recorder.apply(input, at);
    sounds.observe(recorder.game, recorder.game, input);
    if (recorder.result?.outcome === "complete") sounds.event("success");
  }
  return { recorder, clips, send };
}

async function topOut() {
  const fixture = recording();
  const { recorder, send } = fixture;
  // These operations deliberately share the opening tick's timestamp.
  send(Input.RotateCw, 1000); send(Input.Hold, 1000); send(Input.Hold, 1000);
  send(Input.LeftDown, 1010); send(Input.LeftUp, 1010); send(Input.HardDrop, 1010);
  send(Input.RightDown, 1020); send(Input.Rotate180, 1020); send(Input.RightUp, 1020); send(Input.HardDrop, 1020);
  for (let at = 1030; !recorder.result && at < 3000; at += 10) send(Input.HardDrop, at);
  const replay = await recorder.finish();
  if (!replay) throw recorder.error;
  return { ...fixture, replay };
}

function placement(game: Pick<Game, "board" | "piece">) {
  let best = { rot: 0, x: 0, score: -Infinity };
  for (let rot = 0; rot < 4; rot++) for (let x = -3; x < 10; x++) {
    if (!canPlace(game.board, game.piece, rot, x, 18)) continue;
    let y = 18;
    while (canPlace(game.board, game.piece, rot, x, y + 1)) y++;
    const board = game.board.slice();
    place(board, game.piece, rot, x, y);
    const lines = clearRows(board).rows.length;
    let holes = 0, height = 0, bump = 0, previous = 0;
    for (let column = 0; column < 10; column++) {
      let top = 0;
      for (let row = 0; row < ROWS; row++) {
        if (board[row * 10 + column]) { if (!top) top = ROWS - row; }
        else if (top) holes++;
      }
      height += top;
      if (column) bump += Math.abs(top - previous);
      previous = top;
    }
    const score = lines * 10000 - holes * 500 - height * 5 - bump * 10;
    if (score > best.score) best = { rot, x, score };
  }
  return best;
}

async function completedSprint() {
  const fixture = recording(1);
  const { recorder, send } = fixture;
  let at = 1000;
  for (let pieces = 0; !recorder.result && pieces < 1000; pieces++) {
    const target = placement(recorder.game);
    for (let rotations = 0; recorder.game.rot !== target.rot && rotations < 4; rotations++) send(Input.RotateCw, ++at);
    for (let moves = 0; recorder.game.x !== target.x && moves < 20; moves++) {
      const right = recorder.game.x < target.x;
      send(right ? Input.RightDown : Input.LeftDown, ++at);
      send(right ? Input.RightUp : Input.LeftUp, ++at);
    }
    send(Input.HardDrop, ++at);
  }
  expect(recorder.result?.outcome).toBe("complete");
  const replay = await recorder.finish();
  if (!replay) throw recorder.error;
  return { ...fixture, replay };
}

async function clearedMatch() {
  const match = new Match({ players: ["p0", "p1"], seed: 1, firstTo: 1 });
  const recorder = new MatchRecorder(match, "audio-clears");
  let order = 0;
  const send = (input: InputId) => recorder.submit({ player: "p1", epoch: 0, input, frame: match.frame, subframe: 0, order: order++ });
  for (let pieces = 0; pieces < 100; pieces++) {
    const game = match.playerState("p1");
    if ((game.lastResult?.stats.lines ?? 0) > 0) break;
    const target = placement({ board: Uint8Array.from(game.board), piece: game.state.piece });
    for (let rot = game.state.rot; rot !== target.rot; rot = (rot + 1) % 4) send(Input.RotateCw);
    for (let x = game.state.x; x !== target.x; x += x < target.x ? 1 : -1) {
      const right = x < target.x;
      send(right ? Input.RightDown : Input.LeftDown);
      send(right ? Input.RightUp : Input.LeftUp);
    }
    send(Input.HardDrop);
    recorder.advanceToFrame(match.frame + 1);
  }
  expect(match.playerState("p1").lastResult!.stats.lines).toBeGreaterThan(0);
  recorder.forfeit("p0");
  const replay = await recorder.completion;
  if (!replay) throw recorder.error;
  return { replay, match };
}

describe("Sprint replay audio", () => {
  test.each([0.5, 1, 2, 4])("matches live sounds at %s×, including same-time inputs and frame batching", async speed => {
    const { replay, clips } = await topOut();
    const original = JSON.stringify(replay);
    const expected = await SprintPlayback.create(replay, { speed });
    const raw = await SprintPlayback.create(replay, { speed });
    const sound = output();
    const audible = withSprintReplaySounds(raw, sound.audio);
    const state = raw.state;
    expect(sound.clips).toEqual([]);
    expect(raw.state).toEqual(state);
    while (!audible.complete) {
      audible.advance(100);
      expected.advance(100);
      expect(raw.state).toEqual(expected.state);
      expect(audible.positionMs).toBe(expected.positionMs);
    }
    expect(sound.clips).toEqual(clips);
    expect(raw.result).toEqual(expected.result);
    expect(JSON.stringify(replay)).toBe(original);
  });

  test("a completed Sprint plays all clears, combos and success once", async () => {
    const { replay, clips } = await completedSprint();
    const sound = output();
    const audible = withSprintReplaySounds(await SprintPlayback.create(replay, { speed: 4 }), sound.audio);
    while (!audible.complete) audible.advance(100);
    expect(sound.clips).toEqual(clips);
    expect(sound.clips.filter(clip => clip.url === pack.success)).toHaveLength(1);
    expect(sound.clips.some(clip => clip.url === pack.scoring!.CLEAR1)).toBe(true);
  });

  test("pause, seeks, restart and speed controls stop clips without sounding skipped actions", async () => {
    const { replay, clips } = await topOut();
    const sound = output();
    const audible = withSprintReplaySounds(await SprintPlayback.create(replay), sound.audio);
    const document = new FakeDocument();
    Object.assign(document.querySelector("#replay-toggle"), { blur() {} });
    const controls = mountReplayControls(document as unknown as Document, { playback: () => audible, resetClock() {}, exit: () => audible.dispose() });
    audible.advance(10);
    const initialCount = sound.clips.length, stops = sound.stops;
    document.querySelector("#replay-toggle").dispatchEvent(new Event("click"));
    expect(sound.stops).toBeGreaterThan(stops);
    audible.advance(1000);
    expect(sound.clips).toHaveLength(initialCount);
    const seek = document.querySelector("#replay-seek");
    seek.value = String(audible.durationMs - 1); seek.dispatchEvent(new Event("input")); controls.flushSeek();
    expect(sound.clips).toHaveLength(initialCount);
    document.querySelector("#replay-toggle").dispatchEvent(new Event("click"));
    audible.advance(1);
    expect(sound.clips.filter(clip => clip.url === pack.died)).toHaveLength(1);
    expect(sound.clips.length - initialCount).toBeLessThan(clips.length - initialCount);
    seek.value = "0"; seek.dispatchEvent(new Event("input")); controls.flushSeek();
    const afterSeek = sound.clips.length;
    audible.play(); audible.advance(0);
    expect(sound.clips).toHaveLength(afterSeek);
    document.querySelector("#replay-restart").dispatchEvent(new Event("click"));
    sound.clips.length = 0;
    document.querySelector("#replay-speed").value = "4";
    document.querySelector("#replay-speed").dispatchEvent(new Event("change"));
    while (!audible.complete) audible.advance(100);
    expect(sound.clips).toEqual(clips);
    const finalCount = sound.clips.length;
    audible.dispose(); audible.advance(1000);
    expect(sound.clips).toHaveLength(finalCount);
    controls.dispose();
  });

  test("enabling sounds mid-replay does not play the muted history", async () => {
    const { replay } = await topOut();
    const sound = output(); sound.select(undefined);
    const audible = withSprintReplaySounds(await SprintPlayback.create(replay), sound.audio);
    audible.advance(20);
    expect(sound.clips).toEqual([]);
    sound.select(pack);
    audible.advance(10);
    expect(sound.clips.filter(clip => clip.url === pack.harddrop)).toHaveLength(1);
    expect(sound.clips.some(clip => clip.url === pack.go || clip.url === pack.hold)).toBe(false);
  });

  test("an audio error cannot interrupt playback or change its result", async () => {
    const { replay } = await topOut();
    const raw = await SprintPlayback.create(replay);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const sound = output();
    try {
      const audible = withSprintReplaySounds(raw, { ...sound.audio, play() { throw new Error("Audio unavailable"); } });
      audible.advance(audible.durationMs);
      expect(raw.complete).toBe(true);
      expect(raw.result?.outcome).toBe("failed");
      expect(warn).toHaveBeenCalledTimes(1);
    } finally { warn.mockRestore(); }
  });
});

describe("competitive replay audio", () => {
  test("plays every owner lock in a coarse advance and preserves returned events and final state", async () => {
    const { replay, match } = await clearedMatch();
    const original = JSON.stringify(replay);
    const reference = await MatchPlayback.create(replay);
    const raw = await MatchPlayback.create(replay);
    const sound = output();
    const audible = withMatchReplaySounds(raw, "p1", sound.audio);
    audible.setSpeed(4); reference.setSpeed(4);
    const events = audible.advance(60000);
    expect(events).toEqual(reference.advance(60000));
    expect(raw.state).toEqual(match.saveState());
    expect(raw.state).toEqual(reference.state);
    const locks = events.filter(event => event.type === "lock" && event.player === "p1");
    expect(locks.length).toBeGreaterThan(1);
    expect(sound.clips.filter(clip => clip.url === pack.lock)).toHaveLength(locks.length);
    const clearSounds = locks.flatMap(event => event.type === "lock" ? clearClips(pack, event.result) : []);
    expect(clearSounds.length).toBeGreaterThan(0);
    for (const clip of clearSounds) expect(sound.clips).toContainEqual(clip);
    expect(JSON.stringify(replay)).toBe(original);
  });

  test("the existing viewer remains silent during seek and pause, and restarts audio with playback", async () => {
    const { replay } = await recordedSet();
    const raw = await MatchPlayback.create(replay);
    const sound = output();
    const audible = withMatchReplaySounds(raw, "p1", sound.audio);
    const document = new FakeDocument();
    const view = mountCompetitivePlayback(document.root as unknown as HTMLElement, audible, replay.summary, {});
    view.seek(view.durationFrames);
    expect(sound.clips).toEqual([]);
    view.restart();
    while (!view.complete) view.advance(FRAME_MS * 4);
    expect(sound.clips.filter(clip => clip.url === pack.lock).length).toBeGreaterThan(0);
    view.restart(); sound.clips.length = 0;
    const stops = sound.stops;
    view.pause(); view.advance(60000);
    expect(sound.clips).toEqual([]);
    expect(sound.stops).toBeGreaterThan(stops);
    view.dispose();
    expect(document.root.children).toHaveLength(0);
  });
});
