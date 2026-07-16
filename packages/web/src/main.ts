import {
  COLS,
  Game,
  MINOS,
  ROWS,
  VISIBLE_ROWS,
  cellAt,
  version,
} from "@42tris/core";

const canvas = document.querySelector<HTMLCanvasElement>("#board")!;
const status = document.querySelector<HTMLParagraphElement>("#status")!;

// desynchronized lets chrome skip the compositor queue, lower input latency
const ctx = canvas.getContext("2d", { desynchronized: true })!;

// indexed by cell id, order matches Piece
const COLORS = [
  "",
  "#ef4444", // z
  "#f97316", // l
  "#eab308", // o
  "#22c55e", // s
  "#22d3ee", // i
  "#3b82f6", // j
  "#a855f7", // t
  "#6b7280", // garbage
];

const SEED = 108;
const PREVIEWS = 14;
let game = new Game(SEED, 500, PREVIEWS);

const LETTERS = "_ZLOSIJT";
let lastStatus = "";

function updateStatus() {
  let next = "";
  for (let i = 0; i < game.previews.length; i++) {
    // dealt + i is the deal number of this preview, every 7th starts a bag
    if ((game.dealt + i) % 7 === 0) next += " ";
    next += LETTERS[game.previews[i]];
  }
  const text = `42tris core v${version()} | seed ${SEED} | next:${next}`;
  if (text !== lastStatus) {
    lastStatus = text;
    status.textContent = text;
  }
}

const cell = canvas.width / COLS;
const hidden = ROWS - VISIBLE_ROWS;

function render() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  for (let y = 0; y < VISIBLE_ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const id = cellAt(game.board, x, y + hidden);
      if (id === 0) continue;
      ctx.fillStyle = COLORS[id];
      ctx.fillRect(x * cell, y * cell, cell, cell);
    }
  }

  const m = MINOS[game.piece][game.rot];
  ctx.fillStyle = COLORS[game.piece];
  for (let i = 0; i < 8; i += 2) {
    const px = game.x + m[i];
    const py = game.y + m[i + 1] - hidden;
    if (py >= 0) ctx.fillRect(px * cell, py * cell, cell, cell);
  }

  ctx.strokeStyle = "#333";
  for (let x = 0; x <= COLS; x++) {
    ctx.beginPath();
    ctx.moveTo(x * cell + 0.5, 0);
    ctx.lineTo(x * cell + 0.5, VISIBLE_ROWS * cell);
    ctx.stroke();
  }
  for (let y = 0; y <= VISIBLE_ROWS; y++) {
    ctx.beginPath();
    ctx.moveTo(0, y * cell + 0.5);
    ctx.lineTo(COLS * cell, y * cell + 0.5);
    ctx.stroke();
  }
}

function frame(now: number) {
  game.tick(now);
  // same seed on purpose, the exact same run loops forever, that's determinism
  if (game.topOut) game = new Game(SEED, 500, PREVIEWS);
  updateStatus();
  render();
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
