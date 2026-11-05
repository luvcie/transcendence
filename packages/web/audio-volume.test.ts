import { expect, test } from "bun:test";
import { levelToVolume, VolumeSteps, volumeToLevel } from "./src/audio-volume";

test("the normal range takes two-thirds of the meter and boost takes the remaining third", () => {
  expect(volumeToLevel(0)).toBe(0);
  expect(volumeToLevel(1)).toBe(1);
  expect(volumeToLevel(2)).toBe(1.5);
  expect(volumeToLevel(1.5)).toBe(1.25);
  for (const volume of [0, 0.05, 0.5, 1, 1.05, 1.5, 2]) {
    expect(levelToVolume(volumeToLevel(volume))).toBeCloseTo(volume);
  }
});

test("wheel steps are 5%, bounded at zero and 200% without floating point drift", () => {
  const steps = new VolumeSteps();
  expect(steps.step(0, -1, 0)).toBe(0);
  expect(steps.step(2, 1, 0)).toBe(2);
  expect(steps.step(0.55, 1, 0)).toBe(0.6);
  expect(steps.step(0.6, -1, 0)).toBe(0.55);
  expect(steps.step(1.05, -1, 0)).toBe(1);
});

test("100% holds for 500 ms from the first attempt to exceed it", () => {
  const steps = new VolumeSteps();
  expect(steps.step(0.95, 1, 0)).toBe(1);
  expect(steps.step(1, 1, 1000)).toBe(1);
  expect(steps.step(1, 1, 1250)).toBe(1);
  expect(steps.step(1, 1, 1499)).toBe(1);
  expect(steps.step(1, 1, 1500)).toBe(1.05);
  expect(steps.step(1.05, 1, 1501)).toBe(1.1);
});

test("both channels share the boost pause and it rearms three seconds after unlocking", () => {
  const steps = new VolumeSteps();
  expect(steps.step(1, 1, 0)).toBe(1);
  expect(steps.step(1, 1, 0)).toBe(1);
  expect(steps.step(1, 1, 500)).toBe(1.05);
  expect(steps.step(1, 1, 500)).toBe(1.05);
  expect(steps.step(1, 1, 3499)).toBe(1.05);
  expect(steps.step(1, 1, 3500)).toBe(1);
  expect(steps.step(1, 1, 3999)).toBe(1);
  expect(steps.step(1, 1, 4000)).toBe(1.05);
});
