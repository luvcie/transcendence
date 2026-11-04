import { expect, test } from "bun:test";
import { DEFAULT_HANDLING, Input } from "@42tris/core";
import { decodeReplayJson, verifySprintReplayExecution } from "@42tris/replay";
import {
  abandonSprintRecording,
  lastSprintRecording,
  sprintRecordingFor,
  startSprintRecording,
} from "./src/sprint-recording";

function topOut(recorder: ReturnType<typeof startSprintRecording>, first: number): void {
  let now = first;
  while (recorder.result === null && now < first + 5000) {
    now += 10;
    recorder.apply(Input.HardDrop, now);
  }
  expect(recorder.result?.outcome).toBe("failed");
}

test("only a terminal attempt becomes the last completed Sprint recording", async () => {
  const before = lastSprintRecording();
  const abandoned = startSprintRecording(1, 0, DEFAULT_HANDLING);
  abandoned.apply(Input.RotateCw, 10);
  abandonSprintRecording();
  expect(await abandoned.finish()).toBeNull();
  expect(lastSprintRecording()).toBe(before);

  const recorder = startSprintRecording(2, 20, DEFAULT_HANDLING);
  topOut(recorder, 30);
  const replay = await recorder.finish();
  expect(replay).not.toBeNull();
  await recorder.completion;

  const completed = lastSprintRecording();
  expect(completed?.replay).toEqual(replay!);
  expect(completed?.json).toBe(recorder.json!);
  const decoded = await decodeReplayJson(completed!.json);
  const verification = await verifySprintReplayExecution(decoded);
  expect(verification.result.outcome).toBe("failed");

  abandonSprintRecording();
  expect(lastSprintRecording()).toEqual(completed);
});

test("a recorder exposes only its own verified recording, not an earlier completed attempt", async () => {
  const first = startSprintRecording(5, 0, DEFAULT_HANDLING);
  topOut(first, 10);
  await first.completion;
  const firstRecording = lastSprintRecording();
  expect(firstRecording).not.toBeNull();
  expect(sprintRecordingFor(first)).toBe(firstRecording);

  const second = startSprintRecording(6, 20, DEFAULT_HANDLING);
  expect(sprintRecordingFor(second)).toBeNull();
  expect(sprintRecordingFor(first)).toBe(firstRecording);

  second.apply(Input.RotateCw, 30);
  abandonSprintRecording();
  expect(sprintRecordingFor(second)).toBeNull();
  expect(sprintRecordingFor(first)).toBe(firstRecording);
});

test("starting another attempt replaces the active recording without mixing journals", async () => {
  const first = startSprintRecording(3, 100, DEFAULT_HANDLING);
  first.apply(Input.RotateCw, 110);
  const second = startSprintRecording(4, 200, DEFAULT_HANDLING);
  expect(await first.finish()).toBeNull();
  expect(first.status).toBe("abandoned");

  topOut(second, 210);
  const replay = await second.finish();
  expect(replay?.initial.seed).toBe(4);
  expect(replay?.records[0]).toEqual({ seq: 0, op: { type: "tick", atMs: 200 } });
});

test("a finesse-failed recording never replaces a previous completed recording", async () => {
  const completed = startSprintRecording(17, 0, DEFAULT_HANDLING);
  topOut(completed, 1);
  await completed.completion;
  const previous = lastSprintRecording();
  expect(previous).not.toBeNull();
  const failed = startSprintRecording(108, 100, DEFAULT_HANDLING, true);
  let now = 101;
  for (const input of [Input.LeftDown, Input.LeftUp, Input.RightDown, Input.RightUp, Input.HardDrop]) failed.apply(input, now++);
  expect(failed.game.finesse.faults).toBe(1);
  expect(await failed.completion).toBeNull();
  expect(sprintRecordingFor(failed)).toBeNull();
  expect(lastSprintRecording()).toBe(previous);
});
