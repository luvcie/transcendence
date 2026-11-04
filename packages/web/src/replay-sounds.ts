import { SprintDriver, type MatchPlayback, type SoloRecord, type SprintReplay } from "@42tris/replay";
import { FRAME_MS, type PieceId } from "@42tris/core";
import { GameSounds } from "./game-sounds";
import { snapshotDisplay } from "./game-display";
import type { SoundClip, SoundPack } from "./sound-pack";
import type { SprintPlayback } from "./sprint-playback";

export interface ReplaySoundOutput {
  pack(): SoundPack | undefined;
  play(clips: SoundClip[]): void;
  stop(): void;
}

function recordAt(record: SoloRecord): number {
  return record.op.type === "handling" ? record.op.observedAtMs : record.op.atMs;
}

class SprintSounds {
  private readonly driver: SprintDriver;
  private readonly sounds: GameSounds;
  private cursor = 0;
  private audible = false;
  private started = false;
  private readonly initialPiece: PieceId;
  constructor(private replay: SprintReplay, output: ReplaySoundOutput, position: number, beginning: boolean) {
    this.driver = new SprintDriver(replay.initial);
    this.sounds = new GameSounds(output.pack, clips => { if (this.audible) output.play(clips); });
    this.driver.apply(replay.records[0]!);
    this.cursor = 1;
    const state = this.driver.state;
    this.initialPiece = state.state.piece;
    this.sounds.observe(snapshotDisplay(state), replay.id);
    if (!beginning || position > 0) this.follow(position, false);
  }
  follow(position: number, audible = true) {
    this.audible = audible;
    const origin = recordAt(this.replay.records[0]!);
    while (this.cursor < this.replay.records.length) {
      const record = this.replay.records[this.cursor];
      if (recordAt(record) - origin > position) break;
      const result = this.driver.apply(record);
      this.cursor++;
      const running = this.driver.modeState.running;
      if (!this.started && running) { this.sounds.event("go"); this.sounds.spawn(this.initialPiece); }
      this.started = running;
      this.sounds.observe(snapshotDisplay(this.driver.state), this.replay.id, record.op.type === "input" ? record.op.input : undefined);
      if (result?.outcome === "complete") this.sounds.event("success");
    }
  }
}

// Forward playback operations unchanged; only their audio side effects are intercepted.
function withAudio<T extends { playing: boolean }, R>(playback: T & { advance(ms: number): R }, position: () => number,
  follow: (events: R, from: number) => void, reset: (action: "seek" | "restart") => void, output: ReplaySoundOutput) {
  let failed = false;
  function audio(action: () => void) {
    if (failed) return;
    try { action(); }
    catch (error) {
      failed = true;
      output.stop();
      console.warn("Replay audio failed:", error);
    }
  }
  return new Proxy(playback, {
    get(target, key) {
      if (key === "advance") return (ms: number) => {
        const from = position();
        const playing = playback.playing;
        const events = playback.advance(ms);
        if (playing) audio(() => follow(events, from));
        return events;
      };
      const value = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        if (["pause", "toggle", "seek", "restart", "setSpeed", "dispose"].includes(String(key))) output.stop();
        const result = Reflect.apply(value, target, args);
        if (key === "seek" || key === "restart") { failed = false; audio(() => reset(key)); }
        return result;
      };
    },
  });
}

export function withSprintReplaySounds(playback: SprintPlayback, output: ReplaySoundOutput): SprintPlayback {
  output.stop();
  let sounds: SprintSounds | undefined;
  let beginning = true;
  return withAudio(playback, () => playback.positionMs, (_events, from) => {
    if (!output.pack()) { sounds = undefined; beginning = false; return; }
    sounds ??= new SprintSounds(playback.replay, output, from, beginning);
    beginning = false;
    sounds.follow(playback.positionMs);
  }, action => { sounds = undefined; beginning = action === "restart"; }, output);
}

export function withMatchReplaySounds(playback: MatchPlayback, player: string, output: ReplaySoundOutput): MatchPlayback {
  output.stop();
  let audible = false;
  const sounds = new GameSounds(output.pack, clips => { if (audible) output.play(clips); });
  function observe() {
    const state = playback.state;
    const owner = state.players[state.roster.indexOf(player)];
    if (owner) sounds.observe(snapshotDisplay(owner.game), `${state.round}:${owner.epoch}`, undefined, false);
  }
  function reset() {
    audible = false;
    sounds.reset();
    observe();
  }
  reset();
  return withAudio(playback, () => playback.positionFrames * FRAME_MS, events => {
    audible = true;
    try {
      observe();
      for (const event of events) {
        if (event.type === "lock" && event.player === player) sounds.lock(event.result);
        if (event.type === "roundEnd" && event.winner === player) sounds.event("success");
      }
    } finally { audible = false; }
  }, reset, output);
}
