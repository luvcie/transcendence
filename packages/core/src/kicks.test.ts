import { expect, test } from "bun:test";
import { kicksFor } from "./kicks";
import { Piece } from "./pieces";

// kicksets["SRS+"] from the tetr.io client bundle, keys are "fromTo", [x, y] with y down.
// the o piece has disallow_kick, but srs+ sets allow_o_kick so tetr.io hands it the
// plain kicks table. its oo_kicks belong to the separate big "oo" piece, not to o
const KICKS = {"01":[[-1,0],[-1,-1],[0,2],[-1,2]],"10":[[1,0],[1,1],[0,-2],[1,-2]],"12":[[1,0],[1,1],[0,-2],[1,-2]],"21":[[-1,0],[-1,-1],[0,2],[-1,2]],"23":[[1,0],[1,-1],[0,2],[1,2]],"32":[[-1,0],[-1,1],[0,-2],[-1,-2]],"30":[[-1,0],[-1,1],[0,-2],[-1,-2]],"03":[[1,0],[1,-1],[0,2],[1,2]],"02":[[0,-1],[1,-1],[-1,-1],[1,0],[-1,0]],"13":[[1,0],[1,-2],[1,-1],[0,-2],[0,-1]],"20":[[0,1],[-1,1],[1,1],[-1,0],[1,0]],"31":[[-1,0],[-1,-2],[-1,-1],[0,-2],[0,-1]]};
const I_KICKS = {"01":[[1,0],[-2,0],[-2,1],[1,-2]],"10":[[-1,0],[2,0],[-1,2],[2,-1]],"12":[[-1,0],[2,0],[-1,-2],[2,1]],"21":[[-2,0],[1,0],[-2,-1],[1,2]],"23":[[2,0],[-1,0],[2,-1],[-1,2]],"32":[[1,0],[-2,0],[1,-2],[-2,1]],"30":[[1,0],[-2,0],[1,2],[-2,-1]],"03":[[-1,0],[2,0],[2,1],[-1,-2]],"02":[[0,-1]],"13":[[1,0]],"20":[[0,1]],"31":[[-1,0]]};

test("kicksFor matches tetr.io srs+ for every piece and transition", () => {
  for (const piece of Object.values(Piece)) {
    const table: Record<string, number[][]> = piece === Piece.I ? I_KICKS : KICKS;
    for (let from = 0; from < 4; from++) {
      for (let to = 0; to < 4; to++) {
        if (from === to) continue;
        expect([...kicksFor(piece, from, to)]).toEqual(table[`${from}${to}`].flat());
      }
    }
  }
});
