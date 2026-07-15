import { version } from "@42tris/core";

const canvas = document.querySelector<HTMLCanvasElement>("#board")!;
const status = document.querySelector<HTMLParagraphElement>("#status")!;

// desynchronized lets chrome skip the compositor queue, lower input latency
const ctx = canvas.getContext("2d", { desynchronized: true })!;

status.textContent = `42tris core v${version()}`;

const cols = 10;
const rows = 20;
const cell = canvas.width / cols;

ctx.strokeStyle = "#333";
for (let x = 0; x <= cols; x++) {
  ctx.beginPath();
  ctx.moveTo(x * cell + 0.5, 0);
  ctx.lineTo(x * cell + 0.5, rows * cell);
  ctx.stroke();
}
for (let y = 0; y <= rows; y++) {
  ctx.beginPath();
  ctx.moveTo(0, y * cell + 0.5);
  ctx.lineTo(cols * cell, y * cell + 0.5);
  ctx.stroke();
}
