import type { Handling } from "@42tris/core";
import { SprintRecorder, type SprintReplay } from "@42tris/replay";

export interface CompletedSprintRecording {
  readonly replay: SprintReplay;
  readonly json: string;
}

let active: SprintRecorder | null = null;
let last: CompletedSprintRecording | null = null;

export function startSprintRecording(seed: number, now: number, handling: Handling): SprintRecorder {
  abandonSprintRecording();
  const recorder = new SprintRecorder(seed, now, handling);
  active = recorder;
  void recorder.completion.then(replay => {
    const json = recorder.json;
    if (replay && json) last = { replay, json };
    else if (recorder.error) console.warn("Sprint replay recording failed:", recorder.error.message);
  });
  return recorder;
}

export function abandonSprintRecording(): void {
  const recorder = active;
  active = null;
  recorder?.abandon();
}

/** Last sealed Sprint attempt, ready for the playback milestone to consume. */
export function lastSprintRecording(): CompletedSprintRecording | null {
  return last;
}
