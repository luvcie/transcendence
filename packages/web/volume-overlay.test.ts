import { expect, mock, test } from "bun:test";
import { mountVolumeOverlay } from "./src/volume-overlay";
import type { SoundState } from "./src/sound-state";
import type { ZenMusic } from "./src/zen-music";
import { FakeDocument } from "./test-dom";

function fixture() {
  const document = new FakeDocument();
  const overlay = document.querySelector("#volume-overlay");
  overlay.hidden = true;
  Object.assign(overlay, { contains: () => false });
  const channels = ["sfx", "music"].map(name => {
    const element = document.querySelector(`#volume-overlay-${name}`);
    Object.assign(element.querySelector(".volume-bar"), { style: {} });
    return element;
  });
  let now = 0, timerId = 0, active = true;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const target = Object.assign(new EventTarget(), {
    performance: { now: () => now },
    setTimeout(callback: () => void, delay: number) {
      const id = ++timerId;
      timers.set(id, { at: now + delay, callback });
      return id;
    },
    clearTimeout(id: number) { timers.delete(id); },
  });
  function advance(ms: number) {
    const until = now + ms;
    for (;;) {
      const next = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      timers.delete(next[0]); now = next[1].at; next[1].callback();
    }
    now = until;
  }
  function state() {
    const preferences = { volume: 0.5, enabled: true };
    return { preferences, configure: mock((value: object, _persist = true) => Object.assign(preferences, value)) };
  }
  const sfx = state(), music = state(), feedback = mock(() => {});
  const controls = mountVolumeOverlay(document as unknown as Document, target as unknown as Window, {
    active: () => active, sfx: sfx as unknown as SoundState, music: music as unknown as ZenMusic,
    feedback, changed() {},
  });
  function wheel(channel?: string, extra: object = {}, editable = false) {
    const event = new Event("wheel", { cancelable: true });
    const element = { dataset: { volumeChannel: channel }, closest: (selector: string) =>
      selector === "[data-volume-channel]" ? channel ? element : null : editable ? element : null };
    Object.defineProperties(event, { target: { value: element }, deltaY: { value: -1 },
      ...Object.fromEntries(Object.entries(extra).map(([key, value]) => [key, { value }])) });
    target.dispatchEvent(event);
    return event;
  }
  return { overlay, channels, sfx, music, feedback, controls, wheel, advance, deactivate: () => { active = false; } };
}

test("wheel selects both channels or only the hovered channel and skips menus, editing and zoom", () => {
  const f = fixture();
  expect(f.wheel().defaultPrevented).toBe(true);
  expect(f.sfx.preferences.volume).toBe(0.55);
  expect(f.music.preferences.volume).toBe(0.55);
  f.wheel("sfx");
  f.wheel("music");
  expect(f.sfx.preferences.volume).toBe(0.6);
  expect(f.music.preferences.volume).toBe(0.6);
  expect(f.feedback).toHaveBeenCalledTimes(2);
  expect(f.channels[1].getAttribute("aria-valuenow")).toBe("60");
  for (const extra of [{ deltaY: 0 }, { deltaY: NaN }, { ctrlKey: true }, { metaKey: true }]) {
    expect(f.wheel(undefined, extra).defaultPrevented).toBe(false);
  }
  expect(f.wheel(undefined, {}, true).defaultPrevented).toBe(false);
  f.deactivate();
  expect(f.wheel().defaultPrevented).toBe(false);
  expect(f.sfx.preferences.volume).toBe(0.6);
  expect(f.music.preferences.volume).toBe(0.6);
  f.controls.dispose();
});

test("scrolling debounces storage, resets the fade, and cleanup flushes without leaving listeners", () => {
  const f = fixture();
  f.wheel();
  expect(f.overlay.hidden).toBe(false);
  expect(f.sfx.configure.mock.calls).toEqual([[{ volume: 0.55 }, false]]);
  f.advance(1199);
  expect(f.overlay.classes.has("fading")).toBe(false);
  f.advance(1);
  expect(f.overlay.classes.has("fading")).toBe(true);
  f.wheel("sfx");
  expect(f.overlay.classes.has("fading")).toBe(false);
  f.advance(149);
  expect(f.sfx.configure).toHaveBeenCalledTimes(3);
  f.advance(1);
  expect(f.sfx.configure.mock.calls.at(-1)).toEqual([{ volume: 0.6 }]);
  expect(f.music.configure.mock.calls.at(-1)).toEqual([{ volume: 0.55 }]);
  f.advance(1049);
  expect(f.overlay.classes.has("fading")).toBe(false);
  f.advance(1);
  expect(f.overlay.classes.has("fading")).toBe(true);
  f.advance(3999);
  expect(f.overlay.hidden).toBe(false);
  f.advance(1);
  expect(f.overlay.hidden).toBe(true);
  f.wheel("music");
  f.controls.dispose();
  expect(f.overlay.hidden).toBe(true);
  expect(f.music.configure.mock.calls.at(-1)).toEqual([{ volume: 0.6 }]);
  expect(f.wheel().defaultPrevented).toBe(false);
  f.advance(6000);
  expect(f.overlay.hidden).toBe(true);
});
