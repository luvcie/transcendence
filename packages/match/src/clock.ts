import { FRAME_MS } from "@42tris/core";
import type { MatchInput } from "./match";

export const inputTime = (i: MatchInput): number => (i.frame + i.subframe) * FRAME_MS;
export const compareInputs = (a: MatchInput, b: MatchInput): number =>
  a.frame - b.frame || a.subframe - b.subframe || a.order - b.order;

export function hasFrameTimestamp(input: MatchInput): boolean {
  const at = inputTime(input);
  return Number.isSafeInteger(input.frame + 1) && Number.isFinite(at)
    && at >= input.frame * FRAME_MS && at < (input.frame + 1) * FRAME_MS;
}

export function validInput(input: MatchInput, frame: number): boolean {
  return Number.isSafeInteger(input.frame) && input.frame >= frame
    && Number.isFinite(input.subframe) && input.subframe >= 0 && input.subframe < 1
    && Number.isSafeInteger(input.order) && input.order >= 0
    && Number.isInteger(input.input) && input.input >= 0 && input.input <= 10
    && hasFrameTimestamp(input);
}
