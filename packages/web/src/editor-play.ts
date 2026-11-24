import { MINOS, ROWS, VISIBLE_ROWS, canPlace, type Handling, type InputId, type PieceId } from "@42tris/core";
import { emojis, empty, ids } from "./board-emoji";
import type { GameDisplay } from "./game-display";
import { mountGameplayInput } from "./gameplay-input";
import type { GameSounds } from "./game-sounds";
import type { Action, Keybinds } from "./keybinds";
import type { LoadedSkin } from "./skin-loader";
import { Singleplayer } from "./singleplayer";
import { fitCanvas } from "./canvas-resolution";
import { drawPiecePreview, previewLayout } from "./tile-renderer";

const cols = 10;
const hidden = ROWS - VISIBLE_ROWS;
// mirror swaps Z/S and L/J
const mirrored = [0, 4, 6, 3, 1, 5, 2, 7, 8];

// editor rows sit at the bottom of the 40 row game board
export function boardToGame(lines: string[], board: Uint8Array) {
  board.fill(0);
  const top = ROWS - lines.length;
  lines.forEach((line, y) => Array.from(line).forEach((emoji, x) => { board[(top + y) * cols + x] = ids[emoji] ?? 0; }));
}

export function gameToLines(board: ArrayLike<number>) {
  return Array.from({ length: VISIBLE_ROWS }, (_, y) =>
    Array.from({ length: cols }, (_, x) => emojis[board[(hidden + y) * cols + x]] ?? empty).join(""));
}

type View = Pick<GameDisplay, "board" | "piece" | "rot" | "x" | "y" | "starting" | "topOut">;
type Piece = { piece: PieceId; rot: number; x: number; y: number };

// visible cell indexes covered by a piece at row y
function pieceCells(game: View, y = game.y) {
  const minos = MINOS[game.piece][game.rot], out: number[] = [];
  for (let i = 0; i < 8; i += 2) {
    const row = y + minos[i + 1] - hidden;
    if (row >= 0) out.push(row * cols + game.x + minos[i]);
  }
  return out;
}

export function playCells(game: View, ghost: boolean) {
  const cells = gameToLines(game.board).flatMap(line => Array.from(line));
  const ghosts = new Set<number>();
  if (game.starting || game.topOut) return { cells, ghosts };
  if (ghost) {
    let y = game.y;
    while (canPlace(game.board, game.piece, game.rot, game.x, y + 1)) y++;
    for (const index of pieceCells(game, y)) {
      cells[index] = emojis[game.piece];
      ghosts.add(index);
    }
  }
  for (const index of pieceCells(game)) {
    cells[index] = emojis[game.piece];
    ghosts.delete(index);
  }
  return { cells, ghosts };
}

// cells under the active piece are left alone
export function paintGame(game: View & { board: Uint8Array }, index: number, emoji: string) {
  if (!game.starting && !game.topOut && pieceCells(game).includes(index)) return false;
  game.board[hidden * cols + index] = ids[emoji] ?? 0;
  return true;
}

export function mirrorBoard(board: Uint8Array) {
  for (let y = 0; y < ROWS; y++) {
    const row = board.slice(y * cols, (y + 1) * cols).reverse();
    row.forEach((id, x) => { board[y * cols + x] = mirrored[id]; });
  }
}

// the same cells flipped, as the mirrored piece type in whichever rotation draws them
export function mirrorPiece(game: Piece) {
  const flip = MINOS[game.piece][game.rot];
  const want = new Set<string>();
  for (let i = 0; i < 8; i += 2) want.add(`${cols - 1 - game.x - flip[i]},${flip[i + 1]}`);
  const piece = mirrored[game.piece] as PieceId;
  for (let rot = 0; rot < 4; rot++) {
    const minos = MINOS[piece][rot];
    for (let x = -3; x < cols; x++) {
      let same = true;
      for (let i = 0; i < 8 && same; i += 2) same = want.has(`${x + minos[i]},${minos[i + 1]}`);
      if (same) return Object.assign(game, { piece, rot, x });
    }
  }
  return game;
}

// a whole piece per 4 cells of a colour, garbage and leftovers do not count
export function boardPieces(board: ArrayLike<number>) {
  const cells = new Array(8).fill(0);
  for (let index = 0; index < board.length; index++) if (board[index] >= 1 && board[index] <= 7) cells[board[index]]++;
  return cells.map(count => Math.floor(count / 4));
}

// types placed as often as the most placed one are used up in the current bag
export function bagLeft(board: ArrayLike<number>) {
  const counts = boardPieces(board).slice(1);
  const most = Math.max(...counts);
  const left = [1, 2, 3, 4, 5, 6, 7].filter(id => counts[id - 1] < most);
  return (left.length ? left : [1, 2, 3, 4, 5, 6, 7]) as PieceId[];
}

const randomIndex = (n: number) => crypto.getRandomValues(new Uint32Array(1))[0] % n;

export function shuffled(pieces: PieceId[], random = randomIndex) {
  const out = [...pieces];
  for (let i = out.length - 1; i > 0; i--) {
    const j = random(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// the rest of the board's bag, then fresh bags for the rest of the practice
export function boardQueue(board: ArrayLike<number>, random = randomIndex) {
  const left = shuffled(bagLeft(board), random);
  const bags = Array.from({ length: 40 }, () => shuffled([1, 2, 3, 4, 5, 6, 7], random));
  return { left, queue: [...left, ...bags.flat()] };
}

// the previews follow the queue until it runs out, then the bag carries on
export function followQueue(game: { previews: Uint8Array; dealt: number }, queue: ArrayLike<number>) {
  for (let i = 0; i < game.previews.length && game.dealt + i < queue.length; i++) game.previews[i] = queue[game.dealt + i];
}

export function drawQueue(ctx: CanvasRenderingContext2D, pieces: ArrayLike<number>, look: LoadedSkin | undefined | "emoji", slots: number) {
  const cell = fitCanvas(ctx.canvas, 5, slots * 3), { width } = ctx.canvas;
  ctx.clearRect(0, 0, width, ctx.canvas.height);
  for (let slot = 0; slot < pieces.length; slot++) {
    const piece = pieces[slot] as PieceId;
    if (look !== "emoji") {
      drawPiecePreview(ctx, piece, cell, width, cell * 3, slot * cell * 3, look);
      continue;
    }
    const offset = previewLayout(piece, width, cell * 3, cell);
    const minos = MINOS[piece][0];
    ctx.font = `${cell * .85}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (let i = 0; i < 8; i += 2) ctx.fillText(emojis[piece],
      offset.x + (minos[i] + .5) * cell, slot * cell * 3 + offset.y + (minos[i + 1] + .55) * cell);
  }
}

export type PlayRun = ReturnType<typeof playBoard>;

// zen on the drawn board, a top out starts over from the same board and ctrl+z still reaches the old one
export function playBoard(drawn: string[], options: {
  bindings: Keybinds;
  handling: Handling;
  sounds: GameSounds;
  queue: PieceId[];
  render(run: Singleplayer): void;
  stuck(): void;
  pause(): void;
  restart(): void;
}) {
  let lines = drawn;
  const random = new Uint32Array(1);
  crypto.getRandomValues(random);
  const run = new Singleplayer("zen", random[0], performance.now(), options.handling);
  boardToGame(lines, run.game.board);
  followQueue(run.game, options.queue);
  let game = run.game;
  let sounded = run.game;
  let frameId = 0;
  let held = false;
  const pressed = new Map<string, Action>();
  options.sounds.reset();
  const sync = (input?: InputId) => {
    followQueue(run.game, options.queue);
    if (sounded !== run.game && sounded.topOut) options.sounds.observe(sounded, sounded, input);
    options.sounds.observe(run.game, run.game, input);
    sounded = run.game;
    if (run.game === game) return;
    pressed.clear();
    const old = game;
    game = run.game;
    if (!old.topOut) return;
    if (!old.undoCount) options.stuck();
    else boardToGame(lines, run.game.board);
  };
  const unmount = mountGameplayInput(window, {
    bindings: options.bindings, pressed,
    editable: target => target instanceof HTMLElement &&
      !!target.closest("input:not([type=checkbox], [type=radio]), textarea, select, [contenteditable]"),
    blocked: () => run.paused,
    settingsOpen: () => false,
    starting: () => run.game.starting,
    menu: options.pause,
    undo() {
      if (!run.undo(performance.now())) return;
      options.sounds.reset();
      sync();
    },
    restart: options.restart,
    input(input) {
      run.apply(input, performance.now());
      sync(input);
    },
    lateRelease() {},
  });
  const render = () => { if (frameId) options.render(run); };
  const settle = (now: number) => {
    const paused = held || document.hidden || !document.hasFocus() || !!document.querySelector("dialog[open]");
    if (paused === run.paused) return;
    run.setPaused(paused, now);
    pressed.clear();
  };
  const frame = () => {
    const now = performance.now();
    settle(now);
    run.tick(now);
    sync();
    // render or a top out may have stopped the run
    render();
    if (frameId) frameId = requestAnimationFrame(frame);
  };
  frameId = requestAnimationFrame(frame);
  return {
    run,
    get paused() { return held; },
    setPaused(paused: boolean) {
      held = paused;
      settle(performance.now());
      render();
    },
    paint(index: number, emoji: string) {
      if (paintGame(run.game, index, emoji)) render();
    },
    clear() {
      for (let index = 0; index < cols * VISIBLE_ROWS; index++) paintGame(run.game, index, empty);
      render();
    },
    // the drawn board flips too, so a top out comes back mirrored
    mirror(next: string[]) {
      lines = next;
      mirrorBoard(run.game.board);
      if (!run.game.starting) mirrorPiece(run.game);
      render();
    },
    stop() {
      cancelAnimationFrame(frameId);
      frameId = 0;
      unmount();
    },
  };
}
