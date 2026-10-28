export const FRAME_MS = 1000 / 60;

export const DEFAULT_HANDLING = { das: 10, arr: 2, sddas: 0, sdarr: 2 };
export type Handling = typeof DEFAULT_HANDLING;
export const HANDLING_MAX: Handling = { das: 20, arr: 15, sddas: 10, sdarr: 4 };

export function validateHandling(handling: Handling): void {
  for (const key of Object.keys(DEFAULT_HANDLING) as (keyof Handling)[]) {
    if (!Number.isFinite(handling[key]) || handling[key] < 0 || handling[key] > HANDLING_MAX[key]) {
      throw new RangeError(`Invalid ${key}: ${handling[key]}`);
    }
  }
}
