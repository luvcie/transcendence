import type { requestCompetitiveReplay } from "./replay-request";
import { finesseAccuracy, FRAME_MS, INITIAL_FINESSE, type Handling } from "@42tris/core";
import { createClient } from "@42tris/protocol/client";
import type { RoomOptions, ServerMessage } from "@42tris/protocol";
import { Session } from "./session";
import type { SessionDiagnostics } from "./session-diagnostics";
import { createMultiplayerBoard, drawMultiplayerBoard, setGarbage, type MultiplayerBoard } from "./multiplayer-board";
import type { SkinState } from "./skin-state";
import { onlineView, type AppView } from "./app-view";
import { formatTime } from "./singleplayer";
import { MultiplayerSkinResolver, playerSkinAssignments, type MultiplayerSkinMode } from "./multiplayer-skins";

export function mountOnline(root: HTMLElement, options: {
  clearKeys(): void; handling(): Handling; local(): void; skins: SkinState;
  replay?(replay: Awaited<ReturnType<typeof requestCompetitiveReplay>>): void;
  skin?(): string; skinMode(): MultiplayerSkinMode;
  session?: Session; invite?: string | null; view?(view: AppView): void; diagnostics?: SessionDiagnostics;
  inputLeadMs?: number;
}) {
  const document = root.ownerDocument;
  const location = document.location;
  const storage = (kind: "localStorage" | "sessionStorage") => ({
    getItem: (key: string) => window[kind].getItem(key),
    setItem: (key: string, value: string) => window[kind].setItem(key, value),
    removeItem: (key: string) => window[kind].removeItem(key),
  });
  const session = options.session ?? new Session({ now: () => performance.now(), storage: storage("sessionStorage"), profile: storage("localStorage"),
    clearKeys: options.clearKeys, skin: options.skin, diagnostics: options.diagnostics, inputLeadMs: options.inputLeadMs,
    connect(callbacks) {
      const socket = createClient(location.origin).ws.subscribe();
      const diagnostics = options.diagnostics;
      const record = diagnostics
        ? (event: MessageEvent) => diagnostics.receivedMessage(performance.now(), event.data) : undefined;
      const detach = () => { if (record) socket.ws.removeEventListener("message", record); };
      socket.on("open", callbacks.open);
      socket.on("close", () => { detach(); callbacks.close(); });
      socket.subscribe(({ data }) => callbacks.message(data as ServerMessage));
      // Eden exposes ws publicly. Its parsed-event rawData type is not populated
      // by the installed runtime, so read the native event after Session handles it.
      if (record) socket.ws.addEventListener("message", record);
      return { send: command => socket.send(command), close: () => { detach(); socket.close(); } };
    },
  });
  root.innerHTML = `<p data-status class="connection-status" role="status"></p><p data-notification class="online-notification" role="status" hidden></p>
    <div class="connection-actions"><button data-retry>Retry connection</button><button data-guest hidden>Join as another guest</button></div>
    <section data-room hidden aria-label="Current room">
      <div class="room-bar">
        <div class="room-identity"><h2 data-code></h2><p data-phase role="status"></p><span data-round-time></span></div>
        <div class="actions"><button data-copy>Copy invite</button><button data-details>Room details</button>
          <button data-reset hidden>Reset my board</button><button data-attacks hidden>Toggle attacks</button>
          <button data-ready class="primary">Ready</button><button data-leave>Leave room</button></div>
      </div>
      <div data-round-summary class="round-summary" hidden><p data-result role="status"></p><ul data-scores aria-label="Set scores"></ul><button data-watch-replay hidden>Watch replay</button><p data-replay-status class="hint" role="status" hidden></p></div>
    </section>
    <div data-management-home>
      <div data-management class="online-workspace">
        <section data-entry class="online-panel">
          <h2>Play with friends</h2>
          <form data-name><label class="input-label">Guest name <input name="name" maxlength="24" required autocomplete="nickname"></label><button>Save name</button></form>
          <form data-join><label class="input-label">Room code <input name="code" maxlength="6" pattern="[A-HJ-NP-Z2-9a-hj-np-z]{6}" required autocomplete="off" spellcheck="false" placeholder="ABC234"></label><button class="primary">Join room</button></form>
          <p class="hint">Enter a friend's room code or create your own room.</p>
        </section>
        <section data-roster-panel class="online-panel" hidden><h2>Players <span data-player-count></span></h2><ul data-roster></ul><p data-waiting-hint class="hint"></p></section>
        <section class="online-panel">
          <h2 data-options-title>Create a room</h2><p data-settings hidden></p>
          <form data-options>
            <div class="option-fields"><label class="input-label">First to <input name="firstTo" type="number" min="1" max="100" value="1" required></label>
              <label class="input-label">Max players <input name="maxPlayers" type="number" min="2" max="8" value="4" required></label>
              <label class="input-label">Board width <select name="width">${[12, 11, 10, 9, 8, 7, 6, 5, 4].map(width => `<option value="${width}"${width === 10 ? " selected" : ""}>${width} wide</option>`).join("")}</select></label></div>
            <div class="option-toggles"><label><input name="practice" type="checkbox"> Practice (no scoring)</label>
              <label><input name="attacks" type="checkbox" checked disabled> Attacks enabled</label></div>
            <button data-create class="primary">Create room</button><button data-configure hidden>Save room settings</button>
          </form>
        </section>
      </div>
    </div>
    <dialog data-room-dialog aria-labelledby="room-details-title"><div class="dialog-heading"><h2 id="room-details-title">Room details</h2><button data-close-details autofocus>Back</button></div></dialog>`;
  const element = <T extends HTMLElement = HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
  const stageElement = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
  const text = (selector: string, value: string) => {
    const node = element(selector);
    if (node.textContent !== value) node.textContent = value;
  };
  const lifetime = new AbortController();
  function click(selector: string, callback: () => void) {
    element(selector).addEventListener("click", callback, { signal: lifetime.signal });
  }
  let replayRequest: AbortController | undefined;
  let replayMatch: string | null = null;
  click("[data-watch-replay]", () => { void watchReplay(); });
  function cancelReplay() {
    replayRequest?.abort(); replayRequest = undefined;
    element<HTMLButtonElement>("[data-watch-replay]").disabled = false;
    text("[data-watch-replay]", "Watch replay");
  }
  async function watchReplay() {
    if (replayRequest || !replayEligible()) return;
    const matchId = session.room!.matchId;
    const request = new AbortController();
    replayRequest = request;
    const button = element<HTMLButtonElement>("[data-watch-replay]");
    button.disabled = true;
    element("[data-replay-status]").hidden = true;
    button.textContent = "Opening replay…";
    try {
      const replay = await session.replay(request.signal);
      if (!request.signal.aborted && replayEligible() && session.room?.matchId === matchId) {
        session.release(); options.clearKeys(); options.replay?.(replay);
      }
    } catch (error) {
      if (!request.signal.aborted) {
        text("[data-replay-status]", error instanceof Error ? `Cannot open replay. ${error.message}` : "Cannot retrieve replay. Try again.");
        element("[data-replay-status]").hidden = false;
      }
    } finally {
      if (replayRequest === request) {
        replayRequest = undefined;
        button.disabled = false;
        button.textContent = "Watch replay";
      }
    }
  }
  function replayEligible() {
    return !!options.replay && session.room?.options.mode === "competitive" && session.room.phase === "setResult"
      && session.checkpoint?.matchId === session.room.matchId
      && !!session.checkpoint?.state?.complete && session.checkpoint.state.roster.includes(session.playerId);
  }
  const name = element<HTMLFormElement>("[data-name]");
  const nameInput = name.elements.namedItem("name") as HTMLInputElement;
  nameInput.value = session.name;
  name.addEventListener("submit", e => { e.preventDefault(); session.rename(nameInput.value); nameInput.value = session.name; }, { signal: lifetime.signal });
  const join = element<HTMLFormElement>("[data-join]");
  const code = join.elements.namedItem("code") as HTMLInputElement;
  code.value = new URL(location.href).searchParams.get("room")?.toUpperCase() ?? "";
  join.addEventListener("submit", e => { e.preventDefault(); session.send({ type: "join", code: code.value.trim().toUpperCase() }); }, { signal: lifetime.signal });
  const form = element<HTMLFormElement>("[data-options]");
  const field = (key: string) => form.elements.namedItem(key) as HTMLInputElement;
  field("practice").addEventListener("change", () => {
    field("firstTo").disabled = field("practice").checked;
    field("attacks").disabled = !field("practice").checked;
    if (!field("practice").checked) field("attacks").checked = true;
  }, { signal: lifetime.signal });
  form.addEventListener("submit", e => {
    e.preventDefault();
    const firstTo = field("practice").checked ? 3 : Number(field("firstTo").value);
    const roomOptions: RoomOptions = { firstTo, maxPlayers: Number(field("maxPlayers").value), width: Number(field("width").value),
      mode: field("practice").checked ? "practice" : "competitive", attacksEnabled: field("attacks").checked };
    if (session.room) session.send({ type: "configure", options: roomOptions });
    else session.send({ type: "create", requestId: crypto.randomUUID(), options: roomOptions });
  }, { signal: lifetime.signal });
  click("[data-retry]", () => session.retry());
  click("[data-guest]", () => session.anotherGuest());
  const leave = (local = false) => {
    if (session.room && ["playing", "paused", "countdown", "preparing", "roundResult"].includes(session.room.phase)
      && !confirm(session.room.options.mode === "competitive" ? "Leave this set? This counts as a forfeit." : "Leave this practice session?")) return;
    session.release();
    if (session.room) {
      if (!session.connected) { session.status = "Reconnect before leaving your reserved seat."; return; }
      returnLocal = local;
      session.send({ type: "leave" });
      return;
    }
    if (local) options.local();
  };
  click("[data-leave]", () => leave());
  click("[data-ready]", () => session.send({ type: "ready", ready: !session.room?.players.find(p => p.playerId === session.playerId)?.ready, handling: options.handling() }));
  const focusGame = () => stageElement("#game-view").focus({ preventScroll: true });
  click("[data-reset]", () => { session.practice("practiceReset"); focusGame(); });
  click("[data-attacks]", () => { session.send({ type: "toggleAttacks", enabled: !session.room?.options.attacksEnabled }); focusGame(); });
  let notificationUntil = 0;
  click("[data-copy]", async () => {
    const url = new URL(location.href);
    url.searchParams.set("room", session.room!.code);
    url.searchParams.delete("lead");
    if (!stageElement("#game-view").hidden) focusGame();
    if (!navigator.clipboard) { session.status = `Copy this invite: ${url.href}`; return; }
    try {
      await navigator.clipboard.writeText(url.href);
      text("[data-notification]", "Invite copied");
      element("[data-notification]").hidden = false;
      notificationUntil = performance.now() + 3000;
    } catch { session.status = `Copy this invite: ${url.href}`; }
  });
  const roomDialog = element<HTMLDialogElement>("[data-room-dialog]");
  const management = element("[data-management]");
  const managementHome = element("[data-management-home]");
  function closeDetails() {
    const wasOpen = roomDialog.open;
    roomDialog.close();
    if (management.parentElement !== managementHome) managementHome.append(management);
    if (wasOpen) focusGame();
  }
  click("[data-details]", () => {
    session.release();
    options.clearKeys();
    roomDialog.append(management);
    roomDialog.showModal();
  });
  click("[data-close-details]", closeDetails);
  roomDialog.addEventListener("cancel", e => { e.preventDefault(); closeDetails(); }, { signal: lifetime.signal });
  let rosterKey = "";
  let optionsKey = "";
  let lastCheckpoint = -1;
  let lastSkin = options.skins.loaded;
  let lastSkinSource = "";
  let lastSkinsRevision = -1;
  let skinsRevision = 0;
  const remoteSkins = new MultiplayerSkinResolver(options.skins.load, () => { skinsRevision++; });
  let returnLocal = false;
  let previousView: AppView | undefined;
  const boards = new Map<string, MultiplayerBoard>();
  function clearMatch() {
    if (boards.size) { boards.clear(); stageElement("[data-opponents]").replaceChildren(); }
    text("[data-result]", "");
    const meter = stageElement("[data-local-meter]");
    setGarbage(meter, 0);
    meter.hidden = true;
    stageElement("main").classList.remove("match-active");
  }
  function update() {
    session.tick();
    if (returnLocal && !session.room) { options.local(); return; }
    text("[data-status]", [session.notice, session.status].filter(Boolean).join(" "));
    element("[data-status]").hidden = !!session.room && session.connected && !session.notice && session.status.startsWith("Connected as ");
    if (notificationUntil && performance.now() >= notificationUntil) {
      element("[data-notification]").hidden = true;
      notificationUntil = 0;
    }
    element("[data-guest]").hidden = !session.duplicate;
    element("[data-retry]").hidden = session.connected;
    for (const selector of ["[data-create]", "[data-configure]"]) element<HTMLButtonElement>(selector).disabled = !session.connected;
    join.querySelector("button")!.disabled = !session.connected;
    const room = session.room;
    element("[data-watch-replay]").hidden = !replayEligible();
    if (room?.matchId !== replayMatch || !replayEligible()) {
      cancelReplay();
      element("[data-replay-status]").hidden = true;
      replayMatch = room?.matchId ?? null;
    }
    const view = onlineView(room, session.connected);
    if (previousView !== view) {
      closeDetails();
      previousView = view;
      options.view?.(view);
    }
    const waiting = !room || room.phase === "waiting";
    managementHome.hidden = !waiting;
    element("[data-room]").hidden = !room;
    element("[data-entry]").hidden = !!room;
    element("[data-roster-panel]").hidden = !room;
    element("[data-settings]").hidden = !room;
    element("[data-details]").hidden = waiting;
    element("[data-round-summary]").hidden = !room || !["roundResult", "setResult"].includes(room.phase);
    text("[data-options-title]", room ? "Room settings" : "Create a room");
    element("[data-create]").hidden = !!room;
    element("[data-configure]").hidden = !room;
    form.hidden = !!room && (room.ownerId !== session.playerId || !["waiting", "setResult"].includes(room.phase));
    if (!room) {
      clearMatch();
      return;
    }
    text("[data-code]", `Room ${room.code}`);
    const cp = session.checkpoint;
    const phaseLabels = {
      waiting: "Ready up to start", preparing: "Preparing all boards…", countdown: "Starting in",
      playing: room.options.mode === "practice" ? "Practice · no scoring" : `Round ${session.checkpoint?.state?.round ?? 1} · first to ${room.options.firstTo}`,
      paused: "Match paused · waiting for reconnection", roundResult: "Next round in", setResult: "Ready up for a rematch",
    };
    let phase = phaseLabels[room.phase];
    const roundTime = room.phase === "playing" && room.options.mode === "competitive" && cp?.room.phase === "playing" && cp.state
      ? `Round time ${formatTime(cp.state.frame * FRAME_MS)}` : "";
    text("[data-round-time]", roundTime);
    if ((room.phase === "countdown" || room.phase === "roundResult") && room.startsAt !== null) phase += ` ${Math.max(1, Math.ceil((room.startsAt - session.serverNow()) / 1000))}…`;
    const missing = room.players.filter(p => !p.connected && p.deadline !== null);
    if (missing.length) phase += ` · Waiting for ${missing.map(p => `${p.name}: ${Math.max(0, Math.ceil((p.deadline! - session.serverNow()) / 1000))}s`).join(", ")}`;
    if (!session.connected) phase += " · Connection lost; boards frozen";
    text("[data-phase]", phase);
    text("[data-settings]", `${room.options.width} wide · ${room.options.mode} · ${room.options.mode === "practice" ? "No scoring" : `First to ${room.options.firstTo}`} · ${room.players.length}/${room.options.maxPlayers} players · Attacks ${room.options.attacksEnabled ? "on" : "off"}`);
    text("[data-player-count]", `${room.players.length}/${room.options.maxPlayers}`);
    text("[data-waiting-hint]", room.players.length < 2 ? "Invite at least one more player, then ready up."
      : room.players.every(p => p.connected && p.ready) ? "Everyone is ready. Preparing the match…" : "The match starts when every connected player is ready.");
    const key = JSON.stringify(room.players) + room.ownerId + session.playerId;
    if (key !== rosterKey) {
      rosterKey = key;
      element("[data-roster]").replaceChildren(...room.players.map(p => {
        const li = document.createElement("li");
        const name = document.createElement("span");
        name.className = "player-name";
        name.textContent = `${p.name}${p.playerId === session.playerId ? " (you)" : ""}${p.playerId === room.ownerId ? " · host" : ""}`;
        const status = document.createElement("span");
        status.className = "player-state";
        status.textContent = !p.connected ? "Disconnected" : p.withdrawn ? "Withdrawn" : p.ready ? "Ready" : "Not ready";
        status.setAttribute("data-ready", String(p.connected && p.ready));
        li.append(name, status);
        return li;
      }));
    }
    const settingsKey = room.code + JSON.stringify(room.options);
    if (settingsKey !== optionsKey) {
      optionsKey = settingsKey;
      field("width").value = String(room.options.width);
      field("firstTo").value = String(room.options.firstTo);
      field("maxPlayers").value = String(room.options.maxPlayers);
      field("practice").checked = room.options.mode === "practice";
      field("attacks").checked = room.options.attacksEnabled;
      field("firstTo").disabled = field("practice").checked;
      field("attacks").disabled = !field("practice").checked;
    }
    const ready = element<HTMLButtonElement>("[data-ready]");
    ready.hidden = !["waiting", "setResult"].includes(room.phase);
    ready.disabled = !session.connected || !!room.players.find(p => p.playerId === session.playerId)?.withdrawn;
    text("[data-ready]", room.players.find(p => p.playerId === session.playerId)?.ready ? "Unready" : room.phase === "setResult" ? "Ready for rematch" : "Ready");
    element("[data-reset]").hidden = room.options.mode !== "practice" || room.phase !== "playing";
    element("[data-attacks]").hidden = room.options.mode !== "practice" || room.phase !== "playing" || room.ownerId !== session.playerId;
    for (const selector of ["[data-reset]", "[data-attacks]", "[data-leave]"]) element<HTMLButtonElement>(selector).disabled = !session.connected;
    if (!cp) { clearMatch(); return; }
    const mode = options.skinMode();
    const skinSource = `${mode}|${room.revision}|${room.players.map(player => `${player.playerId}:${player.skin ?? ""}`).join(",")}`;
    const redraw = cp.serverSequence !== lastCheckpoint || options.skins.loaded !== lastSkin
      || skinSource !== lastSkinSource || skinsRevision !== lastSkinsRevision;
    lastCheckpoint = cp.serverSequence;
    lastSkin = options.skins.loaded;
    lastSkinSource = skinSource;
    lastSkinsRevision = skinsRevision;
    const state = cp.state;
    if (!state) { clearMatch(); return; }
    const main = stageElement("main");
    main.classList.add("match-active");
    main.setAttribute("data-layout", state.roster.length === 2 ? "duel" : "group");
    stageElement("[data-opponents]").setAttribute("style", `--opponent-columns: ${Math.min(4, state.roster.length - 1)}`);
    const localMeter = stageElement("[data-local-meter]");
    localMeter.hidden = false;
    const owner = state.players[state.roster.indexOf(session.playerId)];
    const garbage = owner?.garbage.packets.reduce((n, p) => n + p.lines, 0) ?? 0;
    setGarbage(localMeter, garbage);
    const result = [...cp.events].reverse().find(({ event }) => event.round === state.round && (event.type === "setEnd" || event.type === "roundEnd"))?.event;
    const playerName = (id: string) => room.players.find(p => p.playerId === id)?.name ?? id;
    let resultText = ["roundResult", "setResult"].includes(room.phase)
      ? result && (result.type === "setEnd" || result.type === "roundEnd")
        ? `${result.type === "setEnd" ? "Set" : "Round"}: ${result.winner ? `${playerName(result.winner)} wins` : result.reason === "aborted" ? "aborted; no winner" : "draw"} · ${result.reason === "firstTo" ? `first to ${room.options.firstTo}` : result.reason === "survivor" ? "last player standing" : result.reason}`
        : `${room.phase === "setResult" ? "Set" : "Round"} finished.` : "";
    const durations = room.phase === "roundResult" ? cp.roundDurations.filter(round => round.round === state.round)
      : room.phase === "setResult" ? cp.roundDurations : [];
    if (durations.length) resultText += ` · ${durations.map(round => `Round ${round.round}: ${formatTime(round.durationMs)}`).join(" · ")}`;
    text("[data-result]", resultText);
    const scores = state.roster.map((id, i) => {
      const finesse = state.players[i].game.lastResult?.finesse ?? INITIAL_FINESSE;
      const pieces = state.players[i].game.lastResult?.stats.pieces ?? 0;
      const accuracy = finesseAccuracy(finesse);
      return `${playerName(id)}${id === session.playerId ? " (you)" : ""}: ${state.scores[i]} · Finesse ${accuracy === null ? "—" : `${accuracy.toFixed(1)}%`} · ${finesse.faults} ${finesse.faults === 1 ? "fault" : "faults"} · ${pieces} ${pieces === 1 ? "piece" : "pieces"} placed${room.players.find(p => p.playerId === id)?.ready ? " · Ready" : ""}`;
    });
    const scoreKey = JSON.stringify(scores);
    if (element("[data-scores]").getAttribute("data-score-key") !== scoreKey) {
      element("[data-scores]").setAttribute("data-score-key", scoreKey);
      element("[data-scores]").replaceChildren(...scores.map(score => {
        const li = document.createElement("li"); li.textContent = score; return li;
      }));
    }
    for (const [id, board] of boards) if (!state.roster.includes(id)) { board.container.remove(); boards.delete(id); }
    const boardSkins = redraw ? playerSkinAssignments(state.roster, room.players, session.playerId,
      options.skins.loaded, mode, skin => remoteSkins.get(skin)) : undefined;
    state.roster.forEach((id, index) => {
      if (id === session.playerId) return;
      let board = boards.get(id);
      if (!board) {
        board = createMultiplayerBoard(document);
        stageElement("[data-opponents]").append(board.container);
        boards.set(id, board);
      }
      const p = state.players[index];
      const connected = room.players.find(p => p.playerId === id)?.connected;
      const label = `${playerName(id)} · ${state.scores[index]} points${p.eliminated ? " · eliminated" : ""}${p.withdrawn ? " · withdrawn" : ""}${connected ? "" : " · disconnected"}`;
      if (board.label.title !== label) {
        board.label.title = label;
        if (state.roster.length === 2) board.label.textContent = label;
        else {
          const name = document.createElement("span"); name.className = "opponent-name"; name.textContent = playerName(id);
          const score = document.createElement("span"); score.className = "opponent-score";
          score.textContent = `${state.scores[index]} pts${p.withdrawn ? " · left" : p.eliminated ? " · out" : ""}${connected ? "" : " · offline"}`;
          board.label.replaceChildren(name, score);
        }
      }
      board.meter.setAttribute("aria-label", `${playerName(id)} incoming garbage lines`);
      setGarbage(board.meter, p.garbage.packets.reduce((n, packet) => n + packet.lines, 0));
      if (redraw) {
        const skin = boardSkins!.get(id);
        drawMultiplayerBoard(board, p.game, skin);
      }
    });
  }
  if (options.invite !== undefined && options.invite !== null) session.joinInvite(options.invite);
  session.start();
  return { session, update, cancelReplay, local: () => leave(true), closeDetails,
    get detailsOpen() { return roomDialog.open; },
    destroy() { replayRequest?.abort(); closeDetails(); session.stop(); lifetime.abort(); clearMatch(); root.replaceChildren(); },
  };
}
