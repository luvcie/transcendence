import { animateSteps } from "./gif-pieces";

export type GifPlanJob = { boards: string[][]; hold: number; build: boolean };
export type GifPlanMessage =
  | { kind: "progress"; step: number; total: number }
  | { kind: "done"; plan: ReturnType<typeof animateSteps> };

self.onmessage = ({ data: { boards, hold, build } }: MessageEvent<GifPlanJob>) => {
  const send = (message: GifPlanMessage) => self.postMessage(message);
  const plan = animateSteps(boards, hold, build, {
    onProgress: (step, total) => send({ kind: "progress", step, total }),
  });
  send({ kind: "done", plan });
};
