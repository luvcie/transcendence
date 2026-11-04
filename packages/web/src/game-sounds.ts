import { canPlace, GARBAGE, Input, type InputId } from "@42tris/core";
import type { GameDisplay } from "./game-display";
import { clearClips, type SoundClip, type SoundEvent, type SoundPack } from "./sound-pack";

interface SoundFrame {
  x: number; y: number; rot: number; holdUsed: boolean; held: number | null;
  starting: boolean; topOut: boolean; grounded: boolean; garbage: number;
}

export class GameSounds {
  private identity: unknown;
  private previous?: SoundFrame;
  private lastLock = 0;
  private lastFaults = 0;
  private died = false;
  constructor(private pack: () => SoundPack | undefined, private play: (clips: SoundClip[]) => void) {}
  reset() { this.previous = undefined; this.identity = undefined; this.lastLock = 0; this.lastFaults = 0; this.died = false; }
  event(event: SoundEvent) {
    const url = this.pack()?.[event];
    if (url) this.play([{ url }]);
  }
  observe(game: GameDisplay, identity: unknown, input?: InputId) {
    const current: SoundFrame = {
      x: game.x, y: game.y, rot: game.rot, holdUsed: game.holdUsed, held: game.held,
      starting: game.starting, topOut: game.topOut,
      grounded: !game.starting && !game.topOut && !canPlace(game.board, game.piece, game.rot, game.x, game.y + 1),
      garbage: game.board.reduce((sum, cell) => sum + Number(cell === GARBAGE), 0),
    };
    const pack = this.pack();
    const spawn = () => {
      const url = pack?.spawns?.["_ZLOSIJT"[game.piece]];
      if (url) this.play([{ url }]);
    };
    if (this.identity !== identity || !this.previous) {
      this.identity = identity; this.previous = current; this.lastLock = game.lastClear?.sequence ?? 0;
      this.lastFaults = game.finesse.faults;
      this.died = current.topOut;
      if (current.topOut) return;
      this.event(current.starting ? "ready" : "go");
      if (!current.starting) spawn();
      return;
    }
    const previous = this.previous;
    this.previous = current;
    if (game.paused) return;
    if (previous.starting && !current.starting) { this.event("go"); spawn(); }
    const result = game.lastClear;
    const locked = result !== null && result.sequence > this.lastLock;
    if (locked) {
      this.lastLock = result.sequence;
      this.event(input === Input.HardDrop && pack?.harddrop ? "harddrop" : "lock");
      if (input === Input.HardDrop && pack?.scoring?.HARD_DROP) this.play([{ url: pack.scoring.HARD_DROP }]);
      if (pack) this.play(clearClips(pack, result));
      if (!game.topOut) spawn();
    }
    const held = current.holdUsed && (!previous.holdUsed || previous.held !== current.held);
    if (held) { this.event("hold"); spawn(); }
    if (!locked && !held && !current.starting && !previous.starting && !current.topOut) {
      if (current.rot !== previous.rot) this.event("rotate");
      else if (current.x !== previous.x) this.event("move");
      if (current.grounded && !previous.grounded) this.event("land");
      if (input === Input.SoftDropDown && current.y > previous.y && pack?.scoring?.SOFT_DROP) this.play([{ url: pack.scoring.SOFT_DROP }]);
    }
    if (locked && current.garbage > previous.garbage) this.event("garbage");
    if (game.finesse.faults > this.lastFaults) { this.lastFaults = game.finesse.faults; this.event("fault"); }
    if (current.topOut && !this.died) { this.died = true; this.event("died"); }
  }
}
