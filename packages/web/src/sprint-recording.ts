import type { Handling } from "@42tris/core";
import { SprintRecorder, type SprintReplay } from "@42tris/replay";

export interface CompletedSprintRecording {
  readonly replay: SprintReplay;
  readonly json: string;
}

interface StoredRecording {
  readonly recorder: SprintRecorder;
  readonly recording: CompletedSprintRecording;
}

let active: SprintRecorder | null = null;
let last: StoredRecording | null = null;

export function startSprintRecording(seed: number, now: number, handling: Handling, resetOnFinesseFault = false): SprintRecorder {
  abandonSprintRecording();
  const recorder = new SprintRecorder(seed, now, handling, { abandonOnFinesseFault: resetOnFinesseFault });
  active = recorder;
  void recorder.completion.then(replay => {
    const json = recorder.json;
    if (replay && json) last = { recorder, recording: { replay, json } };
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
  return last?.recording ?? null;
}

/**
 * The verified recording produced by this exact recorder, or null while it is still
 * recording, finalizing, failed or abandoned. Keeps the Watch Replay action tied to
 * the attempt currently on screen instead of an earlier completed run.
 */
export function sprintRecordingFor(recorder: SprintRecorder): CompletedSprintRecording | null {
  return last?.recorder === recorder ? last.recording : null;
}
