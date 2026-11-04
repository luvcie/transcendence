import { expect, test } from "bun:test";
import { DEFAULT_HANDLING, Input, MINOS, ROWS, spawnX, type InputId } from "@42tris/core";
import { SprintRecorder } from "./sprint-recorder";

function sendFault(recorder: SprintRecorder, now = 1): void {
  for (const input of [Input.LeftDown, Input.LeftUp, Input.RightDown, Input.RightUp, Input.HardDrop]) {
    recorder.apply(input as InputId, now++);
  }
}

test("training abandons a real hard-drop fault before finalization; ordinary Sprint does not", async () => {
  const training = new SprintRecorder(108, 0, DEFAULT_HANDLING, { abandonOnFinesseFault: true });
  sendFault(training);
  expect(training.game.finesse.faults).toBe(1);
  expect(training.status).toBe("abandoned");
  expect(await training.completion).toBeNull();
  expect(training.replay).toBeNull();
  const ordinary = new SprintRecorder(108, 0);
  sendFault(ordinary);
  expect(ordinary.game.finesse.faults).toBe(1);
  expect(ordinary.status).toBe("recording");
});

test("training detects a fault from a gravity lock and leaves perfect placements alone", async () => {
  const recorder = new SprintRecorder(108, 0, DEFAULT_HANDLING, { abandonOnFinesseFault: true });
  recorder.apply(Input.HardDrop, 1);
  expect(recorder.status).toBe("recording");
  for (const input of [Input.LeftDown, Input.LeftUp, Input.RightDown, Input.RightUp]) recorder.apply(input, 2);
  recorder.tick(30_000);
  expect(recorder.game.finesse.faults).toBe(1);
  expect(recorder.status).toBe("abandoned");
  expect(await recorder.completion).toBeNull();
});

test("a fault on the winning placement cannot start replay sealing", async () => {
  const recorder = new SprintRecorder(3, 0, DEFAULT_HANDLING, { abandonOnFinesseFault: true });
  recorder.apply(Input.HardDrop, 1);
  const game = recorder.game;
  const last = game.lastClear!;
  (game as unknown as { lastResult: typeof last }).lastResult = { ...last, stats: { ...last.stats, lines: 39 } };
  game.board.fill(0);
  const minos = MINOS[game.piece][0];
  const bottom = Math.max(minos[1], minos[3], minos[5], minos[7]);
  game.board.fill(1, (ROWS - 1) * game.width);
  for (let index = 0; index < 8; index += 2) {
    if (minos[index + 1] === bottom) game.board[(ROWS - 1) * game.width + game.x + minos[index]] = 0;
  }
  sendFault(recorder, 2);
  expect(recorder.result?.outcome).toBe("complete");
  expect(recorder.game.finesse.faults).toBe(1);
  expect(recorder.status).toBe("abandoned");
  expect(await recorder.completion).toBeNull();
  expect(await recorder.finish()).toBeNull();
  expect(recorder.json).toBeNull();
});

test("a fault on a top-out placement cannot start replay sealing", async () => {
  const recorder = new SprintRecorder(1, 0, DEFAULT_HANDLING, { abandonOnFinesseFault: true });
  let now = 1;
  for (const input of [Input.LeftDown, Input.LeftUp, Input.LeftDown, Input.LeftUp,
    Input.RightDown, Input.RightUp, Input.LeftDown, Input.LeftUp]) recorder.apply(input, now++);
  const next = recorder.game.previews[0];
  const minos = MINOS[next][0];
  recorder.game.board[(18 + minos[1]) * recorder.game.width + spawnX(next) + minos[0]] = 1;
  recorder.apply(Input.HardDrop, now);
  expect(recorder.result?.outcome).toBe("failed");
  expect(recorder.game.finesse.faults).toBe(1);
  expect(recorder.status).toBe("abandoned");
  expect(await recorder.completion).toBeNull();
});

test("training preserves a normal top-out without a finesse fault", async () => {
  const recorder = new SprintRecorder(2, 0, DEFAULT_HANDLING, { abandonOnFinesseFault: true });
  for (let now = 1; !recorder.result && now < 100; now++) recorder.apply(Input.HardDrop, now);
  expect(recorder.result?.outcome).toBe("failed");
  expect(recorder.game.finesse.faults).toBe(0);
  expect(await recorder.completion).not.toBeNull();
  expect(recorder.status).toBe("complete");
});

test("unevaluable inherited-control placements do not trigger training cancellation", () => {
  const recorder = new SprintRecorder(108, 0, DEFAULT_HANDLING, { abandonOnFinesseFault: true });
  recorder.apply(Input.LeftDown, 1);
  recorder.apply(Input.HardDrop, 2);
  recorder.apply(Input.HardDrop, 3);
  expect(recorder.game.finesse.evaluated).toBe(1);
  expect(recorder.game.finesse.faults).toBe(0);
  expect(recorder.status).toBe("recording");
});
