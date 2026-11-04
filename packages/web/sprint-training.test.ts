import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { DEFAULT_HANDLING, Input } from "@42tris/core";
import { mountGameplayInput } from "./src/gameplay-input";
import { DEFAULT_KEYBINDS } from "./src/keybinds";
import { SprintCountdown, mountSprintCard } from "./src/sprint-training";
import { startSprintRecording } from "./src/sprint-recording";
import { FakeDocument } from "./test-dom";

test("Sprint card changes faces, restores focus and persists only an explicit true", () => {
  const doc = new FakeDocument();
  const card = doc.querySelector("#sprint-card");
  card.classList = { ...card.classList, toggle: (name: string, enabled: boolean) => {
    if (enabled) card.classes.add(name); else card.classes.delete(name);
  } } as typeof card.classList;
  const values = new Map([["42tris.sprint.resetOnFinesseFault", "1"]]);
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) } as Storage;
  const checkbox = mountSprintCard(doc as unknown as Document, () => storage);
  const front = doc.querySelector("#sprint-card-front");
  const back = doc.querySelector("#sprint-card-back");
  expect(checkbox.checked).toBe(false);
  front.dispatchEvent(new Event("click"));
  expect(card.classes.has("flipped")).toBe(true);
  expect((front as unknown as HTMLElement).inert).toBe(true);
  expect((back as unknown as HTMLElement).inert).toBe(false);
  expect(front.getAttribute("aria-expanded")).toBe("true");
  expect(doc.focused).toBe(checkbox as unknown as typeof front);
  checkbox.checked = true;
  checkbox.dispatchEvent(new Event("change"));
  doc.querySelector("#sprint-back").dispatchEvent(new Event("click"));
  expect(card.classes.has("flipped")).toBe(false);
  expect((back as unknown as HTMLElement).inert).toBe(true);
  expect(doc.focused).toBe(front);
  front.dispatchEvent(new Event("click"));
  expect(checkbox.checked).toBe(true);
  expect(mountSprintCard(new FakeDocument() as unknown as Document, () => storage).checked).toBe(true);
  checkbox.checked = false;
  checkbox.dispatchEvent(new Event("change"));
  expect(mountSprintCard(new FakeDocument() as unknown as Document, () => storage).checked).toBe(false);
});

test("Sprint markup starts with an inert back and switches faces without animation", () => {
  const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  expect(html).toMatch(/id="sprint-card-back" inert aria-hidden="true"/);
  expect(html).toMatch(/data-mode="sprint" type="button">Play<\/button>/);
  expect(html).not.toMatch(/\.sprint-card[^{}]*\{[^}]*(?:transition|animation|transform):/);
});

test("blocked storage defaults off and does not prevent changing the option", () => {
  const doc = new FakeDocument();
  const checkbox = mountSprintCard(doc as unknown as Document, () => { throw new Error("blocked"); });
  expect(checkbox.checked).toBe(false);
  checkbox.checked = true;
  expect(() => checkbox.dispatchEvent(new Event("change"))).not.toThrow();
});

test("countdown follows the frame clock and cancellation is final", () => {
  const countdown = new SprintCountdown();
  countdown.begin(100);
  expect([100, 1099, 1100, 2100, 3100, 3349, 3350].map(now => countdown.label(now)))
    .toEqual(["3", "3", "2", "1", "GO", "GO", null]);
  expect(countdown.active).toBe(false);
  countdown.begin(5000);
  countdown.cancel();
  expect(countdown.label(6000)).toBeNull();
});

test("countdown blocks presses and cannot carry held keys into the new attempt", () => {
  const target = new EventTarget();
  const pressed = new Map();
  const inputs: number[] = [];
  let blocked = false;
  const unmount = mountGameplayInput(target, {
    bindings: structuredClone(DEFAULT_KEYBINDS), pressed, editable: () => false, blocked: () => blocked,
    settingsOpen: () => false, starting: () => false, menu() {}, undo() {}, restart() {}, lateRelease() {},
    input: input => inputs.push(input),
  });
  const key = (type: string, repeat = false) => target.dispatchEvent(Object.assign(new Event(type), { key: "ArrowLeft", code: "ArrowLeft", repeat }));
  key("keydown");
  pressed.clear(); blocked = true;
  key("keyup"); key("keydown"); key("keydown", true);
  blocked = false;
  key("keydown", true); key("keyup");
  expect(inputs).toEqual([Input.LeftDown]);
  key("keydown");
  expect(inputs).toEqual([Input.LeftDown, Input.LeftDown]);
  unmount();
});

test("fresh recording stays at zero until the first post-countdown input", () => {
  const recorder = startSprintRecording(33, 100, DEFAULT_HANDLING, true);
  recorder.tick(3350);
  expect(recorder.started).toBe(false);
  expect(recorder.elapsedMs).toBe(0);
  recorder.apply(Input.LeftUp, 3500);
  expect(recorder.started).toBe(false);
  recorder.apply(Input.RotateCw, 3600);
  expect(recorder.elapsedMs).toBe(0);
  recorder.tick(3700);
  expect(recorder.elapsedMs).toBe(100);
});

test("consecutive real finesse faults start exactly one fresh attempt each", async () => {
  const countdown = new SprintCountdown();
  let now = 0;
  let seed = 108;
  let recorder = startSprintRecording(seed, now, DEFAULT_HANDLING, true);
  let resets = 0;
  const reset = () => {
    resets++;
    recorder = startSprintRecording(++seed, now, DEFAULT_HANDLING, true);
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    const failed = recorder;
    const previousQueue = [...failed.game.previews];
    for (const input of [Input.LeftDown, Input.LeftUp, Input.RightDown, Input.RightUp, Input.HardDrop]) failed.apply(input, ++now);
    expect(failed.game.finesse.faults).toBe(1);
    expect(countdown.restartOnFault(failed.game.finesse.faults, reset, () => now)).toBe(true);
    expect(countdown.restartOnFault(failed.game.finesse.faults, reset, () => now)).toBe(false);
    expect(resets).toBe(attempt + 1);
    expect(await failed.completion).toBeNull();
    expect(recorder.game.board.every(cell => cell === 0)).toBe(true);
    expect(recorder.game.held).toBeNull();
    expect(recorder.game.stats.lines).toBe(0);
    expect(recorder.game.finesse.faults).toBe(0);
    expect(recorder.elapsedMs).toBe(0);
    expect([...recorder.game.previews]).not.toEqual(previousQueue);
    now += 3250;
    expect(countdown.label(now)).toBeNull();
  }
});
