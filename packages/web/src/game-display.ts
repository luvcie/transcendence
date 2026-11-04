import { copyBoardEdges, INITIAL_STATS, INITIAL_FINESSE, type ClearStats, type FinesseStats, type GameState, type LockResult, type PieceId } from "@42tris/core";

export interface GameDisplay {
  readonly board: Readonly<Uint8Array>;
  readonly previews: ArrayLike<number>;
  readonly piece: PieceId;
  readonly rot: number;
  readonly x: number;
  readonly y: number;
  readonly starting: boolean;
  readonly topOut: boolean;
  readonly paused: boolean;
  readonly held: PieceId | null;
  readonly holdUsed: boolean;
  readonly stats: Readonly<ClearStats>;
  readonly finesse: FinesseStats;
  readonly lastClear: LockResult | null;
  readonly zen: boolean;
}

export function snapshotDisplay(snapshot: GameState): GameDisplay {
  const state = snapshot.state;
  return {
    board: copyBoardEdges(snapshot.board, Uint8Array.from(snapshot.board)), previews: snapshot.previews,
    piece: state.piece, rot: state.rot, x: state.x, y: state.y,
    starting: state.readyMs > 0, topOut: state.topOut, paused: state.paused,
    held: state.held, holdUsed: state.holdUsed,
    stats: snapshot.lastResult?.stats ?? INITIAL_STATS, finesse: snapshot.lastResult?.finesse ?? INITIAL_FINESSE,
    lastClear: snapshot.lastResult, zen: snapshot.zenEnabled,
  };
}
