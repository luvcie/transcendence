// Cosmetic data stays outside serialized game state and replay hashes.
const edgesByBoard = new WeakMap<object, Uint8Array>();

export function boardEdges(board: ArrayLike<number>): Uint8Array {
  let edges = edgesByBoard.get(board);
  if (!edges || edges.length !== board.length) {
    edges = new Uint8Array(board.length);
    edgesByBoard.set(board, edges);
  }
  return edges;
}

export function setBoardEdges(board: ArrayLike<number>, edges: Uint8Array): void {
  if (edges.length !== board.length) throw new RangeError("Board edge dimensions differ");
  edgesByBoard.set(board, edges.slice());
}

export function copyBoardEdges<T extends ArrayLike<number>>(source: ArrayLike<number>, target: T): T {
  setBoardEdges(target, boardEdges(source));
  return target;
}

// Cardinal bits: left=1, down=2, right=4, up=8; diagonals: NE=16, SE=32, SW=64, NW=128.
export function pieceEdges(minos: ArrayLike<number>, index: number): number {
  let edges = 0;
  for (let j = 0; j < minos.length; j += 2) {
    const dx = minos[j] - minos[index], dy = minos[j + 1] - minos[index + 1];
    if (dy === 0 && dx === -1) edges |= 1;
    if (dy === 1 && dx === 0) edges |= 2;
    if (dy === 0 && dx === 1) edges |= 4;
    if (dy === -1 && dx === 0) edges |= 8;
    if (dy === -1 && dx === 1) edges |= 16;
    if (dy === 1 && dx === 1) edges |= 32;
    if (dy === 1 && dx === -1) edges |= 64;
    if (dy === -1 && dx === -1) edges |= 128;
  }
  return edges;
}
