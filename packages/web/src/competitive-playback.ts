import { FRAME_MS } from "@42tris/core";
import { MatchPlayback, type MatchReplaySummary } from "@42tris/replay";
import { mountMatchReplay, type MatchReplayAppearance } from "./match-replay-view";
import type { createSkinLoader } from "./skin-loader";

/** Presentation adapter; the app owns the only animation loop. */
export function mountCompetitivePlayback(root: HTMLElement, playback: MatchPlayback, summary: MatchReplaySummary,
  appearance: MatchReplayAppearance, loadSkin?: ReturnType<typeof createSkinLoader>) {
  const view = mountMatchReplay(root, { appearance, loadSkin });
  function render(events = playback.initialEvents, discontinuity = false) {
    const state = playback.state;
    const round = summary.rounds.find(result => result.round === state.round);
    view.render(state, { events, discontinuity, results: {
      round: state.round, roundWinner: round?.winner, setWinner: summary.winner,
      roundReason: round?.reason, setReason: summary.reason,
    } });
  }
  render();
  return {
    get playing() { return playback.playing; },
    get complete() { return playback.complete; },
    get speed() { return playback.speed; },
    get positionMs() { return playback.positionFrames * FRAME_MS; },
    get durationMs() { return playback.durationFrames * FRAME_MS; },
    get positionFrames() { return playback.positionFrames; },
    get durationFrames() { return playback.durationFrames; },
    advance(ms: number) { render(playback.advance(ms)); },
    pause() { playback.pause(); },
    toggle() { if (playback.playing) playback.pause(); else playback.play(); },
    restart() { playback.restart(); render([], true); },
    seek(frame: number) { playback.seek(frame); render([], true); },
    setSpeed(speed: number) { playback.setSpeed(speed); },
    dispose() { playback.pause(); view.dispose(); },
  };
}
