import type { MatchEvent, MatchState } from "@42tris/match";
import { createMultiplayerBoard, drawMultiplayerBoard, setGarbage, type MultiplayerBoard } from "./multiplayer-board";
import { MultiplayerSkinResolver } from "./multiplayer-skins";
import { createSkinLoader, type LoadedSkin } from "./skin-loader";

/** Cosmetic metadata keyed by the stable IDs in MatchState.roster. Built-in IDs only. */
export interface MatchReplayAppearance {
  names?: Readonly<Record<string, string>>;
  skinIds?: Readonly<Record<string, string>>;
}

export interface MatchReplayResults {
  round: number;
  roundWinner?: string | null;
  setWinner?: string | null;
  roundReason?: string;
  setReason?: string;
}

export interface MatchReplayPresentation {
  events?: readonly MatchEvent[];
  results?: MatchReplayResults;
  /** Set for every seek (including forward seeks) and restart. Historical effects are suppressed. */
  discontinuity?: boolean;
}

/** Cosmetic lifetime measured only against externally supplied round frames. */
export const MATCH_REPLAY_NOTICE_FRAMES = 60;

export function matchReplayLayout(players: number, availableWidth: number, boardWidth: number) {
  const width = Math.max(0, availableWidth);
  const gap = 24;
  const columns = Math.min(players, players === 2 ? 2 : 4, Math.max(1, Math.floor((width + gap) / (260 + gap))));
  const cardWidth = Math.min(520, Math.max(0, (width - gap * (columns - 1)) / columns));
  return { columns, cardWidth, boardWidth, gap };
}

/** A passive view: callers own playback, position, event delivery and appearance overrides. */
export function mountMatchReplay(root: HTMLElement, options: {
  appearance?: MatchReplayAppearance;
  loadSkin?: ReturnType<typeof createSkinLoader>;
  /** A locally loaded override; custom image URLs never enter shared metadata. */
  skinOverride?: (playerId: string) => LoadedSkin | undefined;
} = {}) {
  const document = root.ownerDocument;
  const container = document.createElement("section");
  container.className = "match-replay";
  container.setAttribute("aria-label", "Competitive match replay");
  const summary = document.createElement("p");
  summary.className = "round-summary";
  const grid = document.createElement("div"); grid.className = "match-replay-grid";
  container.append(summary, grid);
  root.append(container);
  const boards = new Map<string, MultiplayerBoard & { queue: HTMLElement; effect: HTMLElement }>();
  let state: MatchState | undefined;
  let appearance = options.appearance ?? {};
  let disposed = false;
  let results: MatchReplayResults | undefined;
  let lastRound = 0;
  let lastFrame = 0;
  const notices = new Map<string, { frame: number; events: MatchEvent[] }>();
  const name = (id: string) => Object.hasOwn(appearance.names ?? {}, id) ? appearance.names![id] : id;
  const skins = new MultiplayerSkinResolver(options.loadSkin ?? createSkinLoader(), redraw);

  function redraw() {
    if (disposed || !state) return;
    state.roster.forEach((id, i) => {
      const skinId = Object.hasOwn(appearance.skinIds ?? {}, id) ? appearance.skinIds![id] : undefined;
      drawMultiplayerBoard(boards.get(id)!, state!.players[i].game, options.skinOverride?.(id) ?? skins.get(skinId), true);
    });
  }

  function resize() {
    if (disposed || !state) return;
    const layout = matchReplayLayout(state.roster.length, Math.max(0, root.getBoundingClientRect().width - 24), state.width);
    grid.setAttribute("style", `grid-template-columns: repeat(${layout.columns}, minmax(0, ${layout.cardWidth}px)); gap: ${layout.gap}px; --replay-board-track: ${layout.boardWidth}fr`);
  }
  const Observer = document.defaultView?.ResizeObserver;
  const observer = Observer ? new Observer(resize) : undefined;
  observer?.observe(root);
  document.defaultView?.addEventListener("resize", resize);

  function resetEffects() {
    notices.clear();
    for (const board of boards.values()) board.effect.textContent = "";
  }

  function eventNotice(event: MatchEvent) {
    switch (event.type) {
      case "send": return { player: event.packet.from, text: `Sent ${event.packet.lines} → ${name(event.packet.to)}` };
      case "queue": return { player: event.packet.to, text: `Incoming ${event.packet.lines} ← ${name(event.packet.from)}` };
      case "insert": return { player: event.player, text: `Garbage received: ${event.holes.length}` };
      case "cancel": return { player: event.player, text: `Cancelled ${event.lines}` };
    }
  }

  function render(snapshot: MatchState, presentation: MatchReplayPresentation = {}) {
    if (disposed) return;
    if (presentation.discontinuity || snapshot.round !== lastRound || snapshot.frame < lastFrame) resetEffects();
    lastRound = snapshot.round; lastFrame = snapshot.frame;
    state = snapshot;
    results = presentation.results;
    for (const [id, board] of boards) if (!state.roster.includes(id)) {
      board.container.remove(); boards.delete(id); notices.delete(id);
    }
    state.roster.forEach((id, i) => {
      let board = boards.get(id);
      if (!board) {
        const shared = createMultiplayerBoard(document);
        const queue = document.createElement("p"); queue.className = "match-replay-queue";
        const effect = document.createElement("p"); effect.className = "match-replay-effect";
        shared.container.append(queue, effect);
        board = { ...shared, queue, effect }; boards.set(id, board);
      }
      grid.append(board.container);
      board.container.setAttribute("data-player-id", id);
      const player = state!.players[i];
      board.label.textContent = `${name(id)} · ${state!.scores[i]} points${player.withdrawn ? " · withdrawn" : player.eliminated ? " · eliminated" : ""}`;
      board.canvas.setAttribute("aria-label", `${name(id)} playfield`);
      board.meter.setAttribute("aria-label", `${name(id)} incoming garbage lines`);
      setGarbage(board.meter, player.garbage.packets.reduce((sum, packet) => sum + packet.lines, 0));
      board.queue.textContent = player.garbage.packets.length
        ? `Pending: ${player.garbage.packets.map(packet => `${packet.lines} from ${name(packet.from)}`).join("; ")}`
        : "No pending garbage";
      board.container.setAttribute("data-withdrawn", String(player.withdrawn));
      board.container.setAttribute("data-eliminated", String(player.eliminated));
    });
    const currentResults = presentation.results?.round === state.round ? presentation.results : undefined;
    const winner = (id: string | null | undefined) => id === null ? " · no winner" : id !== undefined && state!.roster.includes(id) ? ` · ${name(id)} wins` : "";
    const reason = (value: string | undefined) => !value ? "" : ` · ${value === "firstTo"
      ? `first to ${state!.firstTo}` : value === "survivor" ? "last player standing" : value}`;
    const roundResult = state.ended || state.complete
      ? ` · Round complete${winner(currentResults?.roundWinner)}${reason(currentResults?.roundReason)}` : "";
    summary.textContent = `Round ${state.round} · first to ${state.firstTo}${roundResult}${state.complete
      ? ` · Set complete${winner(currentResults?.setWinner)}${reason(currentResults?.setReason)}` : ""}`;
    if (!presentation.discontinuity) {
      const received = new Map<string, MatchEvent[]>();
      for (const event of presentation.events ?? []) {
        if (event.round !== state.round) continue;
        const notice = eventNotice(event);
        if (!notice || !boards.has(notice.player)) continue;
        const events = received.get(notice.player) ?? [];
        events.push(event); received.set(notice.player, events);
      }
      for (const [id, events] of received) notices.set(id, { frame: state.frame, events });
    }
    for (const [id, board] of boards) {
      const notice = notices.get(id);
      if (notice && state.frame - notice.frame >= MATCH_REPLAY_NOTICE_FRAMES) notices.delete(id);
      board.effect.textContent = notices.get(id)?.events.map(event => eventNotice(event)!.text).join(" · ") ?? "";
    }
    redraw();
    resize();
  }

  return {
    render, resize, resetEffects,
    setAppearance(next: MatchReplayAppearance) { appearance = next; if (state) render(state, { results }); },
    dispose() {
      if (disposed) return;
      disposed = true;
      observer?.disconnect();
      document.defaultView?.removeEventListener("resize", resize);
      resetEffects(); boards.clear(); state = undefined; container.remove();
    },
  };
}
