import type { GameplayAction } from "./gameplay-input";
import { ACTIONS } from "./keybinds";
import { setDisabled, setHidden } from "./dom-update";

const movementStroke = 'fill="none" stroke="currentColor" stroke-width="3.25" stroke-linecap="round" stroke-linejoin="round"';
const chevron = `<path d="M6.75 12L16 20.5L25.25 12" ${movementStroke}/>`;
const rotationArrows = '<path d="M16 4.5A11.5 11.5 0 0 1 27.5 16M16 27.5A11.5 11.5 0 0 1 4.5 16" fill="none" stroke="currentColor" stroke-width="2.5"/>' +
  '<path d="M24 14.5H31L27.5 20.5ZM8 17.5H1L4.5 11.5Z"/>';
const glyph = (text: string, size: number) =>
  `<text x="16" y="${16 + size * .35}" text-anchor="middle" font-family="sans-serif" font-size="${size}" font-weight="600">${text}</text>`;

const clusters = [
  ["Movement", "hardDrop", "left", "right", "softDrop"],
  ["Rotation and hold", "rotate180", "hold", "clockwise", "counterclockwise"],
] as const satisfies readonly [string, ...GameplayAction[]][];
const icons: Record<GameplayAction, string> = {
  hardDrop: `<path d="M6.75 8.25L16 16.75L25.25 8.25 M7.25 23.25H24.75" ${movementStroke}/>`,
  left: `<g transform="rotate(90 16 16)">${chevron}</g>`,
  right: `<g transform="rotate(-90 16 16)">${chevron}</g>`,
  softDrop: chevron,
  rotate180: glyph("180", 16),
  hold: glyph("H", 20),
  clockwise: rotationArrows + glyph("R", 17),
  counterclockwise: `<g transform="translate(32) scale(-1 1)">${rotationArrows}</g>${glyph("L", 17)}`,
};
const rotationLabels: Partial<Record<GameplayAction, string>> = {
  rotate180: "Rotate 180°",
  clockwise: "Rotate clockwise",
  counterclockwise: "Rotate counterclockwise",
};

export type TouchControls = ReturnType<typeof createTouchControls>;

export function createTouchControls(element: HTMLElement) {
  const doc = element.ownerDocument;
  const buttons = new Map<GameplayAction, HTMLButtonElement>();
  const createButton = (label: string, icon: string) => {
    const button = doc.createElement("button");
    button.type = "button";
    button.tabIndex = -1;
    button.setAttribute("aria-label", label);
    button.innerHTML = `<svg viewBox="0 0 32 32" aria-hidden="true" fill="currentColor">${icon}</svg>`;
    // touchend still targets the button if gameplay hid it before release
    button.addEventListener("touchend", e => e.preventDefault(), { passive: false });
    return button;
  };
  for (const [label, ...actions] of clusters) {
    const cluster = doc.createElement("div");
    cluster.className = "touch-cluster";
    cluster.setAttribute("role", "group");
    cluster.setAttribute("aria-label", label);
    cluster.addEventListener("contextmenu", e => e.preventDefault());
    for (const action of actions) {
      const button = createButton(rotationLabels[action] ?? ACTIONS[action].label, icons[action]);
      buttons.set(action, button);
      cluster.append(button);
    }
    element.append(cluster);
  }
  const createTapButton = (action: "undo" | "restart", label: string, icon: string) => {
    const button = createButton(label, icon);
    button.className = `touch-action touch-${action}`;
    button.hidden = true;
    button.addEventListener("contextmenu", e => e.preventDefault());
    element.append(button);
    return button;
  };
  const undo = createTapButton("undo", "Undo", `<path d="M6 13a11 11 0 1 1 7 13M5 5v9h9" ${movementStroke}/>`);
  const restart = createTapButton("restart", ACTIONS.restart.label,
    `<g class="restart-arrow"><path d="M24 10a10 10 0 1 0 1 11" ${movementStroke}/><path d="M26 5v8h-8z"/></g>${glyph("R", 20)}`);
  undo.disabled = true;
  return {
    element, buttons, undo, restart,
    setUndoCount(count: number | null) {
      setHidden(undo, count === null);
      setDisabled(undo, !count);
    },
  };
}
