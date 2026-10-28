import { expect, test } from "bun:test";
import { canPlace, COLS, ROWS } from "./board";
import { Game, Input } from "./game";
import { DEFAULT_HANDLING, FRAME_MS, type Handling } from "./handling";
import { Piece, SPAWN_Y } from "./pieces";

function game(settings: Partial<Handling> = {}, gravity = 100000) {
  return new Game(108, gravity, 5, { ...DEFAULT_HANDLING, ...settings });
}

test("fractional DAS and ARR fire at their deadlines", () => {
  const g = game({ das: 4.8, arr: 0.6 });
  const x = g.x;
  g.apply(Input.LeftDown, 0);
  expect(g.x).toBe(x - 1);
  g.tick(79.999);
  expect(g.x).toBe(x - 1);
  g.tick(80);
  expect(g.x).toBe(x - 2);
  g.tick(89.999);
  expect(g.x).toBe(x - 2);
  g.tick(90);
  expect(g.x).toBe(x - 3);
});

test("zero ARR waits for DAS, then moves to the wall", () => {
  const g = game({ das: 4.8, arr: 0 });
  g.apply(Input.RightDown, 0);
  expect(canPlace(g.board, g.piece, g.rot, g.x + 1, g.y)).toBe(true);
  g.tick(80);
  expect(canPlace(g.board, g.piece, g.rot, g.x + 1, g.y)).toBe(false);
});

test("zero DAS and ARR move to the wall immediately", () => {
  const g = game({ das: 0, arr: 0 });
  g.apply(Input.LeftDown, 0);
  expect(canPlace(g.board, g.piece, g.rot, g.x - 1, g.y)).toBe(false);
});

test("duplicate down events do not move or reset DAS", () => {
  const g = game({ das: 4.8 });
  const x = g.x;
  g.apply(Input.LeftDown, 0);
  g.apply(Input.LeftDown, 40);
  expect(g.x).toBe(x - 1);
  g.tick(80);
  expect(g.x).toBe(x - 2);
});

test("last direction wins and releasing it recharges the remaining direction", () => {
  const g = game({ das: 4.8 });
  const x = g.x;
  g.apply(Input.LeftDown, 0);
  g.apply(Input.RightDown, 20);
  g.tick(100);
  expect(g.x).toBe(x + 1);
  g.apply(Input.RightUp, 110);
  g.tick(189.999);
  expect(g.x).toBe(x + 1);
  g.tick(190);
  expect(g.x).toBe(x);
  g.apply(Input.LeftUp, 191);
  g.tick(500);
  expect(g.x).toBe(x);
});

test("charged zero ARR carries across a hard drop", () => {
  const g = game({ das: 4.8, arr: 0 });
  g.apply(Input.LeftDown, 0);
  g.tick(80);
  g.apply(Input.HardDrop, 90);
  g.tick(91);
  expect(g.dealt).toBe(2);
  expect(canPlace(g.board, g.piece, g.rot, g.x - 1, g.y)).toBe(false);
});

test("blocked ARR is charged when the obstacle disappears", () => {
  const g = game({ das: 4.8, arr: 2 });
  g.apply(Input.LeftDown, 0);
  g.tick(300);
  g.apply(Input.HardDrop, 301);
  const x = g.x;
  g.tick(320);
  expect(g.x).toBeLessThan(x);
});

test("soft drop follows Techmino's one-step and two-step press rules", () => {
  const delayed = game({ sddas: 4.8 });
  const immediate = game({ sddas: 0 });
  delayed.apply(Input.SoftDropDown, 0);
  immediate.apply(Input.SoftDropDown, 0);
  expect(delayed.y).toBe(SPAWN_Y + 1);
  expect(immediate.y).toBe(SPAWN_Y + 2);
  delayed.tick(79.999);
  expect(delayed.y).toBe(SPAWN_Y + 1);
});

test("instant soft drop waits for fractional SD DAS and does not lock", () => {
  const g = game({ sddas: 4.8, sdarr: 0 });
  g.apply(Input.SoftDropDown, 0);
  g.tick(79.999);
  expect(g.y).toBe(SPAWN_Y + 1);
  g.tick(80);
  expect(canPlace(g.board, g.piece, g.rot, g.x, g.y + 1)).toBe(false);
  expect(g.dealt).toBe(1);
  expect([...g.board].filter(Boolean)).toHaveLength(0);
});

test("fractional soft-drop ARR adds speed to gravity and stops on release", () => {
  const g = game({ sddas: 0, sdarr: 0.6 }, 1000);
  g.apply(Input.SoftDropDown, 0);
  g.tick(9.9);
  expect(g.y).toBe(SPAWN_Y + 2);
  g.tick(10);
  expect(g.y).toBe(SPAWN_Y + 3);
  g.apply(Input.SoftDropUp, 10);
  g.tick(30);
  expect(g.y).toBe(SPAWN_Y + 3);
});

test("instant soft drop follows each zero-ARR step into a pit", () => {
  const g = game({ das: 0, arr: 0, sddas: 0, sdarr: 0 });
  g.piece = Piece.O;
  g.x = 0;
  g.board.fill(8, (ROWS - 1) * COLS);
  // Pillar at x=3: dropping before each lateral step must stop against it.
  for (let y = ROWS - 5; y < ROWS - 1; y++) g.board[y * COLS + 3] = 8;
  g.apply(Input.SoftDropDown, 0);
  g.apply(Input.RightDown, 0);
  expect(g.x).toBe(1);
  expect(g.y).toBe(ROWS - 3);
  expect(g.dealt).toBe(1);
});

test("pause freezes time and clears held inputs without a resume jump", () => {
  const g = game({ das: 4.8 }, 500);
  g.apply(Input.RightDown, 0);
  g.setPaused(true, 40);
  const x = g.x;
  g.tick(10000);
  g.apply(Input.HardDrop, 10000);
  expect(g.dealt).toBe(1);
  expect(g.y).toBe(SPAWN_Y);
  g.setPaused(false, 10000);
  g.tick(10459);
  expect(g.y).toBe(SPAWN_Y);
  expect(g.x).toBe(x);
  g.tick(10460);
  expect(g.y).toBe(SPAWN_Y + 1);
});

test("movement and soft drop do not depend on rendering frequency", () => {
  for (const arr of [0, 0.6, 2]) {
    const a = game({ das: 4.8, arr, sdarr: 0.6 }, 500);
    const b = game({ das: 4.8, arr, sdarr: 0.6 }, 500);
    for (const g of [a, b]) {
      g.apply(Input.LeftDown, 0);
      g.apply(Input.SoftDropDown, 0);
    }
    for (let t = 1; t <= 300; t++) a.tick(t);
    b.tick(300);
    expect([a.x, a.y, a.dealt]).toEqual([b.x, b.y, b.dealt]);
    expect(a.board).toEqual(b.board);
  }
});

test("invalid handling cannot create endless repeat loops", () => {
  for (const das of [-1, NaN, Infinity, 21]) {
    expect(() => game({ das })).toThrow(RangeError);
  }
  expect(FRAME_MS * 4.8).toBe(80);
});
