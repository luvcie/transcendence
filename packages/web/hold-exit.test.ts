import { expect, mock, test } from "bun:test";
import { EXIT_HOLD_MS, mountHoldExit } from "./src/hold-exit";

function fixture() {
  let now = 0, due = 0, callback: (() => void) | undefined, active = true;
  const indicator = { hidden: true, style: { height: "", setProperty() {} } };
  const header = { getBoundingClientRect: () => ({ bottom: 64 }) };
  const root = Object.assign(new EventTarget(), { hidden: false,
    querySelector: (selector: string) => selector === ".app-header" ? header : indicator });
  const target = Object.assign(new EventTarget(), {
    setTimeout(fn: () => void, delay: number) { due = now + delay; callback = fn; return 1; },
    clearTimeout() { callback = undefined; },
  });
  const exit = mock(() => {}), fallback = mock(() => {});
  const controls = mountHoldExit(target as unknown as Window, root as unknown as Document, {
    active: () => active, exit,
  });
  target.addEventListener("keydown", fallback);
  function key(type: string, extra: object = {}) {
    const event = Object.assign(new Event(type, { cancelable: true }), { key: "Escape", ...extra });
    target.dispatchEvent(event);
    return event;
  }
  function advance(ms: number) {
    now += ms;
    if (callback && now >= due) { const run = callback; callback = undefined; run(); }
  }
  return { root, target, indicator, controls, exit, fallback, key, advance, deactivate: () => { active = false; } };
}

test("holding Escape exits once at the threshold and repeats do not restart the timer", () => {
  const f = fixture();
  expect(f.key("keydown").defaultPrevented).toBe(true);
  expect(f.indicator.hidden).toBe(false);
  expect(f.indicator.style.height).toBe("64px");
  f.advance(400);
  f.key("keydown", { repeat: true });
  f.advance(EXIT_HOLD_MS - 401);
  expect(f.exit).not.toHaveBeenCalled();
  f.advance(1);
  expect(f.exit).toHaveBeenCalledTimes(1);
  expect(f.indicator.hidden).toBe(true);
  f.key("keyup");
  f.advance(EXIT_HOLD_MS);
  expect(f.exit).toHaveBeenCalledTimes(1);
  expect(f.fallback).not.toHaveBeenCalled();
  f.controls.dispose();
});

test("early release cancels the exit and a new hold starts from zero", () => {
  const f = fixture();
  f.key("keydown");
  f.advance(EXIT_HOLD_MS - 1);
  expect(f.key("keyup").defaultPrevented).toBe(true);
  expect(f.indicator.hidden).toBe(true);
  expect(f.fallback).not.toHaveBeenCalled();
  f.advance(EXIT_HOLD_MS);
  expect(f.exit).not.toHaveBeenCalled();
  f.key("keydown");
  f.advance(EXIT_HOLD_MS - 1);
  expect(f.exit).not.toHaveBeenCalled();
  f.advance(1);
  expect(f.exit).toHaveBeenCalledTimes(1);
  f.controls.dispose();
});

test("inactive views and modified, composing or repeated key presses keep their existing handling", () => {
  const f = fixture();
  for (const extra of [{ key: "r" }, { ctrlKey: true }, { altKey: true }, { metaKey: true }, { isComposing: true }, { repeat: true }]) {
    expect(f.key("keydown", extra).defaultPrevented).toBe(false);
  }
  f.deactivate();
  expect(f.key("keydown").defaultPrevented).toBe(false);
  f.key("keyup");
  f.advance(EXIT_HOLD_MS);
  expect(f.fallback).toHaveBeenCalledTimes(7);
  expect(f.exit).not.toHaveBeenCalled();
  expect(f.indicator.hidden).toBe(true);
  f.controls.dispose();
});

test("blur, visibility loss, navigation and disposal cancel without exiting", () => {
  for (const reason of ["blur", "visibility", "navigation", "dispose"]) {
    const f = fixture();
    f.key("keydown");
    f.advance(EXIT_HOLD_MS / 2);
    if (reason === "blur") f.target.dispatchEvent(new Event("blur"));
    if (reason === "visibility") { f.root.hidden = true; f.root.dispatchEvent(new Event("visibilitychange")); }
    if (reason === "navigation") f.controls.cancel();
    if (reason === "dispose") f.controls.dispose();
    f.advance(EXIT_HOLD_MS);
    f.key("keyup");
    expect(f.indicator.hidden).toBe(true);
    expect(f.exit).not.toHaveBeenCalled();
    f.controls.dispose();
  }
});

test("a mode change before the threshold prevents a delayed exit", () => {
  const f = fixture();
  f.key("keydown");
  f.deactivate();
  f.advance(EXIT_HOLD_MS);
  expect(f.indicator.hidden).toBe(true);
  expect(f.exit).not.toHaveBeenCalled();
  f.controls.dispose();
});
