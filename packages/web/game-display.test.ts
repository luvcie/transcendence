import { expect, test } from "bun:test";
import { Game, Input, INITIAL_STATS, type GameState } from "@42tris/core";
import { snapshotDisplay } from "./src/game-display";
import { drawBoard } from "./src/board-view";
import { drawPiecePreview } from "./src/tile-renderer";
import { BUILTIN_SKINS } from "./src/skin-catalog";

function playedGame() {
  const game = new Game(123, 500, 5);
  game.tick(0);
  game.setZen(true);
  game.apply(Input.Hold, 1);
  game.apply(Input.HardDrop, 2);
  return game;
}

function freeze(value: unknown) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
}

test("display adapter reads only presentation fields from a frozen snapshot, with no Game methods", () => {
  const snapshot = playedGame().saveState();
  snapshot.settlementRequired = true;
  const before = structuredClone(snapshot);
  freeze(snapshot);
  const allowed = new Set(["board", "previews", "state", "lastResult", "zenEnabled"]);
  const guarded = new Proxy(snapshot, {
    get(target, key) {
      if (!allowed.has(String(key))) throw new Error(`Rendering read simulation field ${String(key)}`);
      return Reflect.get(target, key);
    },
  });
  const display = snapshotDisplay(guarded);
  expect(Array.from(display.board)).toEqual(snapshot.board);
  expect(display.previews).toBe(snapshot.previews);
  for (const key of ["piece", "rot", "x", "y", "topOut", "paused", "held", "holdUsed"] as const) {
    expect(display[key]).toBe(snapshot.state[key]);
  }
  expect(display.starting).toBe(false);
  expect(display.zen).toBe(true);
  expect(display.lastClear).toBe(snapshot.lastResult);
  expect(display.stats).toBe(snapshot.lastResult!.stats);
  for (const key of ["tick", "apply", "undo", "restoreState", "bag", "config"]) expect(key in display).toBe(false);
  expect(snapshot).toEqual(before);
});

test("display flags and initial statistics do not require a lock result or undo history", () => {
  const snapshot = new Game(456, 500, 5, undefined, 250).saveState();
  snapshot.state.paused = true;
  snapshot.state.topOut = true;
  snapshot.state.holdUsed = true;
  const display = snapshotDisplay(snapshot);
  expect(display.starting).toBe(true);
  expect(display.paused).toBe(true);
  expect(display.topOut).toBe(true);
  expect(display.holdUsed).toBe(true);
  expect(display.stats).toBe(INITIAL_STATS);
  expect(display.lastClear).toBeNull();
  expect(display.zen).toBe(false);
});

function context() {
  const calls: unknown[][] = [];
  const ctx = {
    canvas: { width: 300, height: 600 }, globalAlpha: 1, fillStyle: "", strokeStyle: "",
    clearRect(...args: number[]) { calls.push(["clear", ...args]); },
    fillRect(...args: number[]) { calls.push(["fill", this.globalAlpha, this.fillStyle, ...args]); },
    drawImage(...args: unknown[]) { calls.push(["image", this.globalAlpha, ...args]); },
    strokeRect(...args: number[]) { calls.push(["rect", ...args]); },
    beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

test("snapshot display draws the same board, flat ghost, hold and next previews across every builtin skin", () => {
  const game = playedGame();
  const snapshot: GameState = game.saveState();
  const before = structuredClone(snapshot);
  freeze(snapshot);
  const display = snapshotDisplay(snapshot);
  for (const def of BUILTIN_SKINS) {
    const skin = def.url ? { def, tile: def.tile || 30, image: {} as HTMLImageElement } : undefined;
    const actual = context(), reference = context();
    drawBoard(actual.ctx, display, skin, true);
    drawBoard(reference.ctx, game, skin, true);
    expect(actual.calls.some(call => call[0] === "fill" && call[1] === .25)).toBe(true);
    expect(actual.calls.some(call => call[0] === "image" && call[1] === .25)).toBe(false);
    const preview = (ctx: CanvasRenderingContext2D, view: typeof display) => {
      if (view.held !== null) drawPiecePreview(ctx, view.held, 30, 150, 90, 0, skin);
      for (let i = 0; i < view.previews.length; i++) {
        drawPiecePreview(ctx, view.previews[i] as typeof view.piece, 30, 150, 90, i * 90, skin);
      }
    };
    preview(actual.ctx, display);
    preview(reference.ctx, game);
    expect(actual.calls).toEqual(reference.calls);
  }
  expect(snapshot).toEqual(before);
});
