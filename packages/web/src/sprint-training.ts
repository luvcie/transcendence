import type { SingleplayerMode } from "./singleplayer";

export function mountModeCard(root: ParentNode, mode: SingleplayerMode, storage: () => Storage) {
  const card = root.querySelector<HTMLElement>(`#${mode}-card`)!;
  const front = root.querySelector<HTMLButtonElement>(`#${mode}-card-front`)!;
  const back = root.querySelector<HTMLElement>(`#${mode}-card-back`)!;
  const checkboxes = [...back.querySelectorAll<HTMLInputElement>("input[data-preference]")];
  const backButton = root.querySelector<HTMLButtonElement>(`#${mode}-back`)!;
  for (const checkbox of checkboxes) {
    const key = `42tris.${mode}.${checkbox.dataset.preference}`;
    try { checkbox.checked = storage().getItem(key) === "true"; } catch { checkbox.checked = false; }
    checkbox.addEventListener("change", () => {
      try { storage().setItem(key, String(checkbox.checked)); } catch { return; }
    });
  }
  function flip(open: boolean) {
    card.classList.toggle("flipped", open);
    front.inert = open;
    back.inert = !open;
    front.setAttribute("aria-expanded", String(open));
    front.setAttribute("aria-hidden", String(open));
    back.setAttribute("aria-hidden", String(!open));
    (open ? checkboxes[0] : front).focus({ preventScroll: true });
  }
  front.addEventListener("click", () => flip(true));
  backButton.addEventListener("click", () => flip(false));
}

export class SprintCountdown {
  private start: number | null = null;

  begin(now: number): void { this.start = now; }
  cancel(): void { this.start = null; }

  restartOnFault(faults: number, restart: () => void, now: () => number): boolean {
    if (this.active || faults === 0) return false;
    restart();
    this.begin(now());
    return true;
  }

  label(now: number): string | null {
    if (this.start === null) return null;
    const elapsed = Math.max(0, now - this.start);
    if (elapsed < 1000) return "3";
    if (elapsed < 2000) return "2";
    if (elapsed < 3000) return "1";
    if (elapsed < 3250) return "GO";
    this.cancel();
    return null;
  }

  get active(): boolean { return this.start !== null; }
}
