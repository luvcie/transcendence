import { expect, test } from "bun:test";
import { GARBAGE, Input } from "@42tris/core";
import { bagLeft, boardQueue, boardToGame, drawQueue, followQueue, gameToLines, mirrorBoard, mirrorPiece, paintGame, playCells } from "./src/editor-play";
import { emojis } from "./src/board-emoji";
import { mirrorRows } from "./src/emoji-editor";
import { editorSkin } from "./src/emoji-editor";
import { Singleplayer } from "./src/singleplayer";
import { FakeDocument } from "./test-dom";

const row = (emoji: string) => emoji.repeat(10);
const blank = Array(20).fill(row("⬛"));

test("drawn rows land at the bottom of the game board and read back the same", () => {
  const board = new Uint8Array(400);
  boardToGame([row("🟥"), "⬜🟪⬛⬛⬛⬛⬛⬛🟦🟧"], board);
  expect(board[390]).toBe(5);
  expect(board[391]).toBe(7);
  expect(board[380]).toBe(1);
  expect(board[379]).toBe(0);
  expect(gameToLines(board)).toEqual([...blank.slice(2), row("🟥"), "⬜🟪⬛⬛⬛⬛⬛⬛🟦🟧"]);
  boardToGame(blank, board);
  expect(board.every(cell => cell === 0)).toBe(true);
});

test("the active piece and its ghost are drawn into the cells", () => {
  const board = new Uint8Array(400);
  boardToGame([row("🟨")], board);
  // flat I in rows 18 and above the floor row
  const game = { board, piece: 5 as const, rot: 0, x: 3, y: 20, starting: false, topOut: false };
  const { cells, ghosts } = playCells(game, true);
  const at = (y: number, x: number) => y * 10 + x;
  expect(cells[at(1, 3)]).toBe("⬜");
  expect(cells[at(18, 3)]).toBe("⬜");
  expect(ghosts.has(at(18, 3))).toBe(true);
  expect(ghosts.has(at(1, 3))).toBe(false);
  expect(cells[at(19, 0)]).toBe("🟨");
  expect(playCells(game, false).ghosts.size).toBe(0);
  expect(playCells({ ...game, starting: true }, true).cells[at(1, 3)]).toBe("⬛");
});

test("a zen run starts on the drawn board and pieces stack on top of it", () => {
  const run = new Singleplayer("zen", 108, 0);
  const gap = "🟫".repeat(9) + "⬛";
  boardToGame([gap, gap], run.game.board);
  expect(run.game.board[390]).toBe(GARBAGE);
  run.tick(1000);
  run.apply(Input.HardDrop, 1000);
  const lines = gameToLines(run.game.board);
  expect(lines.slice(18)).toEqual([gap, gap]);
  expect(lines[17]).not.toBe(row("⬛"));
  expect(run.undo(1001)).toBe(true);
  expect(gameToLines(run.game.board).slice(17)).toEqual([row("⬛"), gap, gap]);
});

test("mirroring the live board flips rows and swaps S/Z and J/L", () => {
  const board = new Uint8Array(400);
  boardToGame(["🟥🟦🟨⬛⬛⬛⬛⬛⬛⬜"], board);
  mirrorBoard(board);
  expect(gameToLines(board)[19]).toBe("⬜⬛⬛⬛⬛⬛⬛🟨🟧🟩");
});

test("the active piece mirrors into the swapped type covering the flipped cells", () => {
  // J at spawn covers (3,0) (3,1) (4,1) (5,1), mirrored that is an L covering (6,0) (6,1) (5,1) (4,1)
  expect(mirrorPiece({ piece: 6, rot: 0, x: 3, y: 18 })).toEqual({ piece: 2, rot: 0, x: 4, y: 18 });
  const t = mirrorPiece({ piece: 7, rot: 1, x: 0, y: 30 });
  expect(t.piece).toBe(7);
  expect(t.rot).toBe(3);
});

test("painting skips cells under the active piece", () => {
  const game = { board: new Uint8Array(400), piece: 3 as const, rot: 0, x: 4, y: 20, starting: false, topOut: false };
  expect(paintGame(game, 14, "🟥")).toBe(false);
  expect(paintGame(game, 0, "🟥")).toBe(true);
  expect(game.board[200]).toBe(1);
  expect(paintGame(game, 0, "⬛")).toBe(true);
  expect(game.board[200]).toBe(0);
});

test("the editor skin starts from the game skin and keeps its own pick", () => {
  const preferences = { active: "classic", customs: [] };
  expect(editorSkin(null, preferences).id).toBe("classic");
  expect(editorSkin("nope", preferences).id).toBe("classic");
  const other = editorSkin("effect", preferences);
  expect(other.id).toBe("effect");
  expect(preferences.active).toBe("classic");
});

const drawn = (...lines: string[]) => {
  const board = new Uint8Array(400);
  boardToGame(lines, board);
  return board;
};
const T = "🟪🟪🟪🟪⬛⬛⬛⬛⬛⬛", I = "⬜⬜⬜⬜⬛⬛⬛⬛⬛⬛";

test("the bag left is what the board has not used yet", () => {
  expect(bagLeft(drawn())).toEqual([1, 2, 3, 4, 5, 6, 7]);
  expect(bagLeft(drawn(T, I))).toEqual([1, 2, 3, 4, 6]);
  expect(bagLeft(drawn(T, T, I))).toEqual([1, 2, 3, 4, 5, 6]);
  expect(bagLeft(drawn("🟥🟥🟥🟥🟧🟧🟧🟧🟨🟨", "🟨🟨🟩🟩🟩🟩⬜⬜⬜⬜", "🟦🟦🟦🟦🟪🟪🟪🟪⬛⬛"))).toEqual([1, 2, 3, 4, 5, 6, 7]);
  expect(bagLeft(drawn(T, "🟥🟥🟥⬛⬛⬛⬛⬛⬛⬛"))).toEqual([1, 2, 3, 4, 5, 6]);
  const board = drawn(T);
  board.fill(8, 300, 310);
  expect(bagLeft(board)).toEqual([1, 2, 3, 4, 5, 6]);
});

test("a mirrored board counts the swapped colours it shows", () => {
  const z = "🟥🟥🟥🟥⬛⬛⬛⬛⬛⬛";
  expect(bagLeft(drawn(z))).not.toContain(1);
  expect(bagLeft(drawn(...mirrorRows([z])))).toEqual([1, 2, 3, 5, 6, 7]);
});

test("the queue finishes the board's bag then deals whole bags", () => {
  const { left, queue } = boardQueue(drawn(T, I));
  expect(left).toHaveLength(5);
  expect(new Set(queue.slice(0, 5))).toEqual(new Set([1, 2, 3, 4, 6]));
  const rest = queue.slice(5);
  expect(rest.length).toBe(280);
  for (let i = 0; i < rest.length; i += 7) expect([...rest.slice(i, i + 7)].sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
});

test("a zen run deals the board queue through hold and keeps it through undo", () => {
  const { queue } = boardQueue(drawn(T, I), n => n - 1);
  const run = new Singleplayer("zen", 108, 0);
  followQueue(run.game, queue);
  expect([...run.game.previews]).toEqual(queue.slice(0, 5));
  const dealt: number[] = [];
  let now = 1000;
  run.tick(now);
  followQueue(run.game, queue);
  run.apply(Input.Hold, ++now);
  followQueue(run.game, queue);
  expect(run.game.held).toBe(queue[0]);
  for (let i = 0; i < 8; i++) {
    dealt.push(run.game.piece);
    run.apply(Input.HardDrop, ++now);
    followQueue(run.game, queue);
  }
  expect(dealt).toEqual(queue.slice(1, 9));
  run.undo(++now);
  followQueue(run.game, queue);
  expect(run.game.piece).toBe(dealt[7]);
});

test("editor previews draw the held piece and the advanced queue after hold", () => {
  const document = new FakeDocument();
  const hold = document.createElement(), next = document.createElement();
  const run = new Singleplayer("zen", 108, 0);
  run.tick(1000);
  const piece = run.game.piece;
  run.apply(Input.Hold, 1001);
  drawQueue(hold.context as unknown as CanvasRenderingContext2D, [run.game.held!], "emoji", 1);
  drawQueue(next.context as unknown as CanvasRenderingContext2D, run.game.previews, "emoji", 5);
  expect(hold.calls).toEqual(["clear", ...Array(4).fill(emojis[piece])]);
  expect(next.calls).toEqual(["clear", ...Array.from(run.game.previews).flatMap(id => Array(4).fill(emojis[id]))]);
});
