import { Input } from "@42tris/core";
import { Match } from "@42tris/match";
import { MatchRecorder } from "@42tris/replay";

export async function recordedSet(count = 2, rounds = 1) {
  const roster = Array.from({ length: count }, (_, i) => `p${i}`);
  const match = new Match({ players: roster, seed: 123, firstTo: rounds });
  const recorder = new MatchRecorder(match, "viewer-test");
  const boundaries: number[] = [];
  let duration = 0, order = 0;
  for (let round = 0; round < rounds; round++) {
    while (!match.ended) {
      for (const id of roster.slice(1)) {
        if (match.playerState(id).state.topOut) continue;
        recorder.submit({ player: id, epoch: match.playerEpoch(id), input: Input.HardDrop, order: order++, frame: match.frame, subframe: 0 });
      }
      const before = match.frame;
      recorder.advanceToFrame(match.frame + 20);
      duration += match.frame - before;
    }
    boundaries.push(duration);
    if (!match.complete) recorder.nextRound(124 + round);
  }
  const replay = await recorder.completion;
  if (!replay) throw recorder.error;
  return { replay, match, boundaries };
}

