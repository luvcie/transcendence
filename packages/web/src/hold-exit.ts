export const EXIT_HOLD_MS = 900;

export function mountHoldExit(target: Window, root: Document, options: {
  active(): boolean;
  exit(): void;
}) {
  const indicator = root.querySelector<HTMLElement>("#exit-hold")!;
  const header = root.querySelector<HTMLElement>(".app-header")!;
  indicator.style.setProperty("--exit-hold-duration", `${EXIT_HOLD_MS}ms`);
  let timer = 0;
  function cancel() {
    target.clearTimeout(timer);
    timer = 0;
    indicator.hidden = true;
  }
  function consume(event: KeyboardEvent) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }
  function down(event: KeyboardEvent) {
    if (event.key !== "Escape") return;
    if (timer) { consume(event); return; }
    if (event.repeat || event.isComposing || event.ctrlKey || event.altKey || event.metaKey || !options.active()) return;
    consume(event);
    indicator.style.height = `${header.getBoundingClientRect().bottom}px`;
    indicator.hidden = false;
    timer = target.setTimeout(() => {
      const active = options.active();
      cancel();
      if (active) options.exit();
    }, EXIT_HOLD_MS);
  }
  function up(event: KeyboardEvent) {
    if (event.key !== "Escape" || !timer) return;
    consume(event);
    cancel();
  }
  const visibility = () => { if (root.hidden) cancel(); };
  target.addEventListener("keydown", down, true);
  target.addEventListener("keyup", up, true);
  target.addEventListener("blur", cancel);
  root.addEventListener("visibilitychange", visibility);
  return { cancel, dispose() {
    cancel();
    target.removeEventListener("keydown", down, true);
    target.removeEventListener("keyup", up, true);
    target.removeEventListener("blur", cancel);
    root.removeEventListener("visibilitychange", visibility);
  } };
}
