import {
  Bag,
  COLS,
  Piece,
  ROWS,
  VISIBLE_ROWS,
  cellAt,
  createBoard,
  place,
  version,
} from "@42tris/core";

const canvas = document.querySelector<HTMLCanvasElement>("#board")!;
const status = document.querySelector<HTMLParagraphElement>("#status")!;

// desynchronized lets chrome skip the compositor queue, lower input latency
const ctx = canvas.getContext("2d", { desynchronized: true })!;

// letters indexed by cell id, same order as Piece
const LETTERS = "_ZLOSIJT";
const bag = new Bag(108);
let queue = "";
for (let i = 0; i < 14; i++) {
  if (i === 7) queue += " ";
  queue += LETTERS[bag.next()];
}
status.textContent = `42tris core v${version()} | seed 108 bag: ${queue}`;

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

const board = createBoard();

// one of each piece near the floor to eyeball shapes and colors
place(board, Piece.I, 0, 0, 38);
place(board, Piece.O, 0, 4, 38);
place(board, Piece.T, 0, 6, 38);
place(board, Piece.Z, 0, 0, 36);
place(board, Piece.S, 0, 3, 36);
place(board, Piece.J, 0, 6, 36);
place(board, Piece.L, 0, 0, 34);

const cell = canvas.width / COLS;
const hidden = ROWS - VISIBLE_ROWS;

ctx.clearRect(0, 0, canvas.width, canvas.height);

for (let y = 0; y < VISIBLE_ROWS; y++) {
  for (let x = 0; x < COLS; x++) {
    const id = cellAt(board, x, y + hidden);
    if (id === 0) continue;
    ctx.fillStyle = COLORS[id];
    ctx.fillRect(x * cell, y * cell, cell, cell);
  }
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
