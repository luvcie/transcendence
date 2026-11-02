import { expect, test } from "bun:test";
import { Game, Input, Piece, DEFAULT_HANDLING } from "@42tris/core";
import { Singleplayer, finesseSummary, formatTime } from "./src/singleplayer";
import { initialView } from "./src/app-view";

function well(game: Game, lines = 4) {
  game.board.fill(0);
  Object.assign(game, { piece: Piece.I, rot: 1, x: 2, y: 18 });
  for (let y = 40 - lines; y < 40; y++) {
    game.board.fill(Piece.L, y * 10, (y + 1) * 10);
    game.board[y * 10 + 4] = 0;
  }
}

function almostFinished() {
  const run = new Singleplayer("sprint", 108, 0, { ...DEFAULT_HANDLING, sdarr: 0 });
  run.apply(Input.RotateCw, 0);
  for (let i = 1; i <= 9; i++) {
    well(run.game);
    run.apply(Input.HardDrop, i);
  }
  expect(run.game.stats.lines).toBe(36);
  return run;
}

test("normal entry selects home; invitations and reserved sessions bypass it on local and deployed origins", () => {
  for (const origin of ["http://localhost:5173/", "https://42tris.example/"]) {
    expect(initialView(origin, false)).toBe("home");
    expect(initialView(`${origin}?room=ZYEEVM`, false)).toBe("lobby");
    expect(initialView(`${origin}?room=bad`, false)).toBe("lobby");
    expect(initialView(origin, true)).toBe("lobby");
  }
});

test.each([4, 8, 10, 12])("Zen retains width %i, opening preview and automatic undo without a preference", width => {
  const run = new Singleplayer("zen", 108, 0, DEFAULT_HANDLING, width);
  expect(run.game.width).toBe(width);
  expect(run.game.zen).toBe(true);
  expect(run.game.starting).toBe(true);
  run.tick(250);
  const board = run.game.board.slice();
  run.apply(Input.HardDrop, 251);
  expect(run.game.stats.pieces).toBe(1);
  expect(run.undo(252)).toBe(true);
  expect(run.game.board).toEqual(board);
  expect(run.game.stats.pieces).toBe(0);
});

test("Zen restarts automatically on top-out and can still rewind that board", () => {
  const run = new Singleplayer("zen", 108, 0);
  run.tick(250);
  const first = run.game;
  for (let t = 251; run.game === first && t < 300; t++) run.apply(Input.HardDrop, t);
  expect(first.topOut).toBe(true);
  expect(run.game).not.toBe(first);
  expect(run.game.stats.pieces).toBe(0);
  expect(run.undo(300)).toBe(true);
  expect(run.game).toBe(first);
  expect(run.game.topOut).toBe(false);
});

test.each([4, 12])("Sprint uses ten columns regardless of Zen width %i and never records undo", width => {
  const zen = new Singleplayer("zen", 108, 0, DEFAULT_HANDLING, width);
  const sprint = new Singleplayer("sprint", 108, 0, DEFAULT_HANDLING, width);
  sprint.apply(Input.HardDrop, 10);
  const board = sprint.game.board.slice();
  expect(sprint.game.width).toBe(10);
  expect(sprint.game.zen).toBe(false);
  expect(sprint.game.undoCount).toBe(0);
  expect(sprint.undo(11)).toBe(false);
  expect(sprint.game.undo(11)).toBe(false);
  expect(sprint.game.board).toEqual(board);
  expect(zen.game.width).toBe(width);
});

test("Sprint waits indefinitely for a gameplay press; releases and undo cannot start timing or gravity", () => {
  const run = new Singleplayer("sprint", 108, 100);
  const y = run.game.y;
  run.tick(10000);
  run.apply(Input.LeftUp, 11000);
  run.undo(12000);
  expect(run.elapsedMs).toBe(0);
  expect(run.started).toBe(false);
  expect(run.game.y).toBe(y);
  run.apply(Input.RotateCw, 20000);
  expect(run.elapsedMs).toBe(0);
  expect(run.game.rot).toBe(1);
  run.tick(20500);
  expect(run.elapsedMs).toBe(500);
  expect(run.game.y).toBe(y + 1);
});

test("Zen pause excludes time and releases controls", () => {
  const run = new Singleplayer("zen", 108, 0);
  run.setPaused(true, 100);
  run.apply(Input.HardDrop, 200);
  run.setPaused(false, 10000);
  run.tick(10200);
  run.apply(Input.LeftDown, 11000);
  run.setPaused(true, 11100.125);
  const x = run.game.x;
  const elapsed = run.elapsedMs;
  run.tick(20000);
  expect(run.elapsedMs).toBe(elapsed);
  run.setPaused(false, 21000);
  run.tick(21020.5);
  expect(run.elapsedMs).toBe(elapsed + 20.5);
  expect(run.game.x).toBe(x);
});

test("Sprint completes on the 40th line at the exact hard-drop input time and freezes results", () => {
  const run = almostFinished();
  well(run.game);
  run.apply(Input.HardDrop, 1234.567);
  expect(run.result?.outcome).toBe("complete");
  expect(run.result?.elapsedMs).toBe(1234.567);
  expect(run.result?.stats.lines).toBe(40);
  expect(run.result?.finesse).toEqual(run.game.finesse);
  const state = run.game.saveState();
  const result = run.result;
  run.tick(100000);
  run.apply(Input.HardDrop, 200000);
  run.setPaused(true, 200001);
  expect(run.undo(200002)).toBe(false);
  expect(run.game.saveState()).toEqual(state);
  expect(run.result).toBe(result);
});

test("a clear crossing 40 lines also completes", () => {
  const run = new Singleplayer("sprint", 108, 0);
  run.apply(Input.RotateCw, 0);
  well(run.game, 3);
  run.apply(Input.HardDrop, 1);
  for (let i = 2; i <= 11; i++) {
    well(run.game);
    run.apply(Input.HardDrop, i);
  }
  expect(run.result?.outcome).toBe("complete");
  expect(run.result?.stats.lines).toBe(43);
});

test("coarse ticks stop at the winning simulation deadline, identical to fine ticks", () => {
  const play = (fine: boolean) => {
    const run = almostFinished();
    well(run.game);
    run.apply(Input.SoftDropDown, 10.125);
    if (fine) for (let t = 11; t < 2000; t += 7) run.tick(t);
    run.tick(100000);
    return run;
  };
  const coarse = play(false), fine = play(true);
  expect(coarse.result?.elapsedMs).toBe(1010.125);
  expect(coarse.result?.stats.pieces).toBe(10);
  expect(coarse.result).toEqual(fine.result);
  expect(coarse.game.saveState()).toEqual(fine.game.saveState());
});

test("Sprint ignores pause requests and completes at the original winning lock time", () => {
  const run = almostFinished();
  well(run.game);
  run.apply(Input.SoftDropDown, 10.125);
  run.setPaused(true, 900.125);
  expect(run.paused).toBe(false);
  run.tick(5000);
  run.setPaused(false, 6000.125);
  run.tick(6110.125);
  expect(run.result?.elapsedMs).toBe(1010.125);
});

test("finesse summary keeps the evaluated count for accuracy without displaying it", () => {
  expect(finesseSummary({ faults: 0, evaluated: 10, points: 50 })).toBe("100.0% · 0 faults");
  expect(finesseSummary({ faults: 2, evaluated: 10, points: 40 })).toBe("80.0% · 2 faults");
});

test("top-out is a terminal failure; a fresh retry resets timer, board, stats and result", () => {
  const run = new Singleplayer("sprint", 108, 0);
  run.apply(Input.RotateCw, 10);
  run.game.board.fill(Piece.L, 18 * 10, 22 * 10);
  run.apply(Input.Hold, 100.125);
  expect(run.result?.outcome).toBe("failed");
  expect(run.result?.elapsedMs).toBe(90.125);
  const game = run.game;
  run.tick(5000);
  expect(run.game).toBe(game);
  const retry = new Singleplayer(run.mode, 109, 5000);
  expect(retry.result).toBeNull();
  expect(retry.elapsedMs).toBe(0);
  expect(retry.started).toBe(false);
  expect(retry.game.topOut).toBe(false);
  expect(retry.game.board.every(cell => cell === 0)).toBe(true);
  expect(retry.game.stats.pieces).toBe(0);
});

test("time formatting retains milliseconds across minute boundaries", () => {
  expect(formatTime(0)).toBe("0:00.000");
  expect(formatTime(61234.567)).toBe("1:01.234");
  expect(formatTime(59999.999)).toBe("0:59.999");
});


test("the winning clear takes precedence over collision on the following spawn", () => {
  const run = almostFinished();
  well(run.game);
  run.game.board.fill(Piece.L, 14 * 10 + 1, 15 * 10);
  run.apply(Input.HardDrop, 10);
  expect(run.game.topOut).toBe(true);
  expect(run.result?.outcome).toBe("complete");
  expect(run.result?.stats.lines).toBe(40);
});


test("rewinding a topped-out Zen board keeps the latest handling", () => {
  const run = new Singleplayer("zen", 108, 0);
  run.tick(250);
  const first = run.game;
  for (let t = 251; run.game === first && t < 300; t++) run.apply(Input.HardDrop, t);
  const handling = { das: 4.9, arr: 0, sddas: 0, sdarr: 0 };
  run.setHandling(handling, 300);
  expect(run.undo(301)).toBe(true);
  expect(run.game.saveState().config.handling).toEqual(handling);
});
