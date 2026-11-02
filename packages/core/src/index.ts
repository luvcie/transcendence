export * from "./pieces";
export * from "./board";
export * from "./rng";
export * from "./bag";
export * from "./game";
export * from "./finesse";
export { GAME_STATE_VERSION, type GameState } from "./game-state";
export * from "./handling";
export * from "./rules";
export * from "./lock-profile";

export function version(): string {
  return "0.1.0";
}
