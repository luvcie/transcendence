const preferenceKey = "42tris.sprint.resetOnFinesseFault";

export function mountSprintCard(root: ParentNode, storage: () => Storage): HTMLInputElement {
  const card = root.querySelector<HTMLElement>("#sprint-card")!;
  const front = root.querySelector<HTMLButtonElement>("#sprint-card-front")!;
  const back = root.querySelector<HTMLElement>("#sprint-card-back")!;
  const checkbox = root.querySelector<HTMLInputElement>("#sprint-reset-finesse")!;
  const backButton = root.querySelector<HTMLButtonElement>("#sprint-back")!;
  try { checkbox.checked = storage().getItem(preferenceKey) === "true"; } catch { checkbox.checked = false; }
  checkbox.addEventListener("change", () => {
    try { storage().setItem(preferenceKey, String(checkbox.checked)); } catch { return; }
  });
  function flip(open: boolean) {
    card.classList.toggle("flipped", open);
    front.inert = open;
    back.inert = !open;
    front.setAttribute("aria-expanded", String(open));
    front.setAttribute("aria-hidden", String(open));
    back.setAttribute("aria-hidden", String(!open));
    (open ? checkbox : front).focus({ preventScroll: true });
  }
  front.addEventListener("click", () => flip(true));
  backButton.addEventListener("click", () => flip(false));
  return checkbox;
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
