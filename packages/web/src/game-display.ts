import { copyBoardEdges, finesseAccuracy, finesseSummary, INITIAL_STATS, INITIAL_FINESSE, Piece, type ClearStats, type FinesseStats, type GameState, type LockResult, type PieceId } from "@42tris/core";
import { setAttributeIfChanged, setText } from "./dom-update";

export interface GameDisplay {
  readonly board: Readonly<Uint8Array>;
  readonly previews: ArrayLike<number>;
  readonly piece: PieceId;
  readonly rot: number;
  readonly x: number;
  readonly y: number;
  readonly starting: boolean;
  readonly topOut: boolean;
  readonly paused: boolean;
  readonly held: PieceId | null;
  readonly holdUsed: boolean;
  readonly stats: Readonly<ClearStats>;
  readonly finesse: FinesseStats;
  readonly lastClear: LockResult | null;
  readonly zen: boolean;
}

export function snapshotDisplay(snapshot: GameState): GameDisplay {
  const state = snapshot.state;
  return {
    board: copyBoardEdges(snapshot.board, Uint8Array.from(snapshot.board)), previews: snapshot.previews,
    piece: state.piece, rot: state.rot, x: state.x, y: state.y,
    starting: state.readyMs > 0, topOut: state.topOut, paused: state.paused,
    held: state.held, holdUsed: state.holdUsed,
    stats: snapshot.lastResult?.stats ?? INITIAL_STATS, finesse: snapshot.lastResult?.finesse ?? INITIAL_FINESSE,
    lastClear: snapshot.lastResult, zen: snapshot.zenEnabled,
  };
}

// tetr.io interpolates rounded rgb channels between these displayed b2b counts.
const surgeColors = [
  [4, 0x00ffcc], [8, 0x00ff00], [12, 0xffff00],
  [30, 0xff0000], [60, 0xff00ff], [100, 0x0091ff],
  [150, 0x94ffe4], [250, 0xffdd87], [500, 0xffffff],
] as const;

function surgeColor(b2b: number): string {
  for (let i = 1; i < surgeColors.length; i++) {
    const [end, to] = surgeColors[i];
    if (b2b < end) {
      const [start, from] = surgeColors[i - 1];
      const progress = (b2b - start) / (end - start);
      return "#" + [16, 8, 0].map(shift => {
        const a = (from >> shift) & 255;
        const b = (to >> shift) & 255;
        return Math.round(a + progress * (b - a)).toString(16).padStart(2, "0");
      }).join("");
    }
  }
  return "#ffffff";
}

function renderB2B(element: Element, { chainLength, b2b, surge }: Readonly<ClearStats>, value: Element): void {
  const charged = surge > 0;
  const count = String(b2b);
  setText(element, chainLength === 0 ? "\u2014" : b2b === 0 ? "Ready" : !charged ? `×${count}` : count);
  setAttributeIfChanged(element, "title", chainLength === 0
    ? "Clear a Quad, spin or all clear to start B2B."
    : b2b === 0 ? "Chain started. The next qualifying clear earns the B2B bonus." : `${b2b} back-to-back clears.`);
  if (charged) {
    const scale = Math.min(4, Math.max(1, (b2b - 3) / 6));
    // tetr.io advances by this many degrees per 60 hz frame, starting at ×4.
    const degreesPerFrame = Math.min(4, Math.max(1, 1 + .1 * (b2b - 3)));
    setAttributeIfChanged(value, "data-charged", "");
    setAttributeIfChanged(value, "style",
      `--surge-color: ${surgeColor(b2b)}; --b2b-digits: ${count.length}; --surge-growth: ${(scale - 1) / 3};`
      + ` --surge-spin-duration: ${6 / degreesPerFrame}s`);
  } else if (value.getAttribute("data-charged") !== null) {
    value.removeAttribute("data-charged");
    value.removeAttribute("style");
  }
}

export function bindGameStats(root: ParentNode, prefix = "") {
  const lineCount = root.querySelector(`#${prefix}line-count`)!;
  const comboCount = root.querySelector(`#${prefix}combo-count`)!;
  const b2bCount = root.querySelector(`#${prefix}b2b-count`)!;
  const b2bValue = root.querySelector(`#${prefix}b2b-value`)!;
  const finesseCount = root.querySelector(`#${prefix}finesse-count`)!;
  const clearResult = root.querySelector(`#${prefix}clear-result`)!;

  return (display: Pick<GameDisplay, "stats" | "finesse" | "lastClear">, sprint = false, compactFinesse = false) => {
    const { lines, combo } = display.stats;
    setText(lineCount, sprint ? `${lines} / 40` : String(lines));
    setText(comboCount, String(Math.max(0, combo)));
    renderB2B(b2bCount, display.stats, b2bValue);
    if (compactFinesse) {
      const accuracy = finesseAccuracy(display.finesse);
      setText(finesseCount, accuracy === null ? "\u2014" : `${accuracy.toFixed(1)}%`);
    } else setText(finesseCount, finesseSummary(display.finesse));
    const result = display.lastClear;
    const labels: string[] = [];
    if (result) {
      const clear = ["", "Single", "Double", "Triple", "Quad"][result.rows.length];
      let spin = "";
      if (result.spin !== "none") {
        spin = `${"_ZLOSIJT"[result.piece]}-spin`;
        if (result.piece === Piece.T && result.spin === "mini") spin += " mini";
      }
      const placement = [spin, clear].filter(Boolean).join(" ");
      if (placement) labels.push(placement);
      if (result.allClear) labels.push("All clear");
      const attack = result.attacks.reduce((sum, packet) => sum + packet.lines, 0);
      if (attack) labels.push(`Attack ${attack}`);
    }
    setText(clearResult, labels.join(" · "));
  };
}
