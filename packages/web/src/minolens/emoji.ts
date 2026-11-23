import { emojis } from "../board-emoji";

export function toEmoji(cells: ArrayLike<number>, cols: number, trim = true): string[] {
  const lines: string[] = [];
  for (let i = 0; i < cells.length; i += cols) {
    const row = Array.from({ length: cols }, (_, c) => cells[i + c] ?? 0);
    if (trim && !lines.length && row.every(id => id === 0)) continue;
    lines.push(row.map(id => emojis[id]).join(""));
  }
  return lines;
}
