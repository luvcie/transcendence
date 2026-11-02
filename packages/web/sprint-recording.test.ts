import { expect, test } from "bun:test";
import { DEFAULT_HANDLING, Input } from "@42tris/core";
import { decodeReplayJson, verifySprintReplayExecution } from "@42tris/replay";
import {
  abandonSprintRecording,
  lastSprintRecording,
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
