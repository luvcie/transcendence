import type { Handling } from "@42tris/core";
import { createClient } from "@42tris/protocol/client";
import type { RoomOptions, ServerMessage } from "@42tris/protocol";
import { Session } from "./session";
import { drawSnapshot } from "./board-view";
import { drawPiecePreview } from "./tile-renderer";
import type { PieceId } from "@42tris/core";
import type { SkinState } from "./skin-state";

export function mountOnline(root: HTMLElement, options: {
  clearKeys(): void; handling(): Handling; local(): void; skins: SkinState;
  session?: Session;
}) {
  const document = root.ownerDocument;
  const location = document.location;
  const storage = (kind: "localStorage" | "sessionStorage") => ({
    getItem: (key: string) => window[kind].getItem(key),
    setItem: (key: string, value: string) => window[kind].setItem(key, value),
    removeItem: (key: string) => window[kind].removeItem(key),
  });
  const session = options.session ?? new Session({ now: () => performance.now(), storage: storage("sessionStorage"), profile: storage("localStorage"),
    clearKeys: options.clearKeys,
    connect(callbacks) {
      const socket = createClient(location.origin).ws.subscribe();
      socket.on("open", callbacks.open);
      socket.on("close", callbacks.close);
      socket.subscribe(({ data }) => callbacks.message(data as ServerMessage));
      return { send: command => socket.send(command), close: () => socket.close() };
    },
  });
  root.innerHTML = `<h2>Online play</h2>
    <p data-status role="status"></p>
    <form data-name><label>Guest name <input name="name" maxlength="24" required></label><button>Save name</button></form>
    <div class="actions"><button data-retry>Retry connection</button><button data-guest hidden>Join as another guest</button><button data-local>Local practice</button></div>
    <div data-entry>
      <form data-join><label>Room code <input name="code" maxlength="6" pattern="[A-HJ-NP-Z2-9a-hj-np-z]{6}" required></label><button>Join room</button></form>
      <form data-options>
        <label>First to <input name="firstTo" type="number" min="1" max="100" value="3" required></label>
        <label>Players <input name="maxPlayers" type="number" min="2" max="8" value="4" required></label>
        <label><input name="practice" type="checkbox"> Practice (no scoring)</label>
        <label><input name="attacks" type="checkbox" checked disabled> Attacks enabled</label>
        <button data-create>Create room</button><button data-configure hidden>Save room settings</button>
      </form>
    </div>
    <section data-room hidden><h2 data-code></h2><button data-copy>Copy invite</button>
      <p data-phase></p><p data-settings></p><ul data-roster></ul>
      <p data-result role="status"></p>
      <div class="actions"><button data-ready>Ready</button><button data-leave>Leave room</button>
      <button data-reset hidden>Reset my practice board</button><button data-attacks hidden>Toggle attacks</button></div>
      <p class="hint">Handling is fixed for the active set. Settings changes apply to your next set. Escape opens the menu; online play keeps running.</p>
    </section>`;
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
    const roomOptions: RoomOptions = { firstTo, maxPlayers: Number(field("maxPlayers").value),
      mode: field("practice").checked ? "practice" : "competitive", attacksEnabled: field("attacks").checked };
    if (session.room) session.send({ type: "configure", options: roomOptions });
    else session.send({ type: "create", requestId: crypto.randomUUID(), options: roomOptions });
  }, { signal: lifetime.signal });
  click("[data-retry]", () => session.retry());
  click("[data-guest]", () => session.anotherGuest());
  const leave = (local = false) => {
    if (session.room && ["playing", "paused", "countdown", "preparing"].includes(session.room.phase)
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
  click("[data-local]", () => leave(true));
  click("[data-leave]", () => leave());
  click("[data-ready]", () => session.send({ type: "ready", ready: !session.room?.players.find(p => p.playerId === session.playerId)?.ready, handling: options.handling() }));
  click("[data-reset]", () => session.practice("practiceReset"));
  click("[data-attacks]", () => session.send({ type: "toggleAttacks", enabled: !session.room?.options.attacksEnabled }));
  click("[data-copy]", () => {
    const url = new URL(location.href);
    url.searchParams.set("room", session.room!.code);
    if (!navigator.clipboard) { session.status = `Copy this invite: ${url.href}`; return; }
    void navigator.clipboard.writeText(url.href).then(() => { session.status = "Invite copied. Open it in another window and click Join room."; },
      () => { session.status = `Copy this invite: ${url.href}`; });
  });
  let rosterKey = "";
  let optionsKey = "";
  let lastCheckpoint = -1;
  let lastSkin = options.skins.loaded;
  let returnLocal = false;
  const boards = new Map<string, { container: HTMLElement; canvas: HTMLCanvasElement; label: HTMLElement; meter: HTMLElement; hold: HTMLCanvasElement; next: HTMLCanvasElement }>();
  function setGarbage(meter: HTMLElement, lines: number) {
    meter.setAttribute("aria-valuemax", String(Math.max(40, lines)));
    meter.setAttribute("aria-valuenow", String(lines));
    meter.setAttribute("aria-valuetext", `${lines} incoming garbage lines`);
    meter.setAttribute("style", `--garbage: ${Math.min(lines / 40, 1) * 100}%`);
  }
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
    element("[data-guest]").hidden = !session.duplicate;
    element("[data-retry]").hidden = session.connected;
    for (const selector of ["[data-create]", "[data-configure]"]) element<HTMLButtonElement>(selector).disabled = !session.connected;
    join.querySelector("button")!.disabled = !session.connected;
    const room = session.room;
    element("[data-room]").hidden = !room;
    join.hidden = !!room;
    element("[data-create]").hidden = !!room;
    element("[data-configure]").hidden = !room;
    form.hidden = !!room && (room.ownerId !== session.playerId || !["waiting", "setResult"].includes(room.phase));
    if (!room) {
      clearMatch();
      return;
    }
    text("[data-code]", `Room ${room.code}`);
    let phase = room.phase as string;
    if (room.phase === "countdown" && room.startsAt !== null) phase += ` · ${Math.max(0, Math.ceil((room.startsAt - session.serverNow()) / 1000))}`;
    const missing = room.players.filter(p => !p.connected && p.deadline !== null);
    if (missing.length) phase += ` · Waiting for ${missing.map(p => `${p.name}: ${Math.max(0, Math.ceil((p.deadline! - session.serverNow()) / 1000))}s`).join(", ")}`;
    if (!session.connected) phase += " · Connection lost; boards frozen";
    text("[data-phase]", phase);
    text("[data-settings]", `${room.options.mode} · ${room.options.mode === "practice" ? "No scoring" : `First to ${room.options.firstTo}`} · ${room.players.length}/${room.options.maxPlayers} players · Attacks ${room.options.attacksEnabled ? "on" : "off"}`);
    const key = JSON.stringify(room.players) + room.ownerId + session.playerId;
    if (key !== rosterKey) {
      rosterKey = key;
      element("[data-roster]").replaceChildren(...room.players.map(p => {
        const li = document.createElement("li");
        li.textContent = `${p.name}${p.playerId === session.playerId ? " (you)" : ""}${p.playerId === room.ownerId ? " · creator" : ""} · ${p.connected ? "connected" : "disconnected"} · ${p.withdrawn ? "withdrawn" : p.ready ? "ready" : "not ready"}`;
        return li;
      }));
    }
    const settingsKey = room.code + JSON.stringify(room.options);
    if (settingsKey !== optionsKey) {
      optionsKey = settingsKey;
      field("firstTo").value = String(room.options.firstTo);
      field("maxPlayers").value = String(room.options.maxPlayers);
      field("practice").checked = room.options.mode === "practice";
      field("attacks").checked = room.options.attacksEnabled;
      field("firstTo").disabled = field("practice").checked;
      field("attacks").disabled = !field("practice").checked;
    }
    const ready = element<HTMLButtonElement>("[data-ready]");
    ready.hidden = !["waiting", "roundResult", "setResult"].includes(room.phase);
    ready.disabled = !session.connected || !!room.players.find(p => p.playerId === session.playerId)?.withdrawn;
    text("[data-ready]", room.players.find(p => p.playerId === session.playerId)?.ready ? "Unready" : room.phase === "roundResult" ? "Ready for next round" : room.phase === "setResult" ? "Ready for rematch" : "Ready");
    element("[data-reset]").hidden = room.options.mode !== "practice" || room.phase !== "playing";
    element("[data-attacks]").hidden = room.options.mode !== "practice" || room.phase !== "playing" || room.ownerId !== session.playerId;
    const cp = session.checkpoint;
    if (!cp) return;
    const redraw = cp.serverSequence !== lastCheckpoint || options.skins.loaded !== lastSkin;
    lastCheckpoint = cp.serverSequence;
    lastSkin = options.skins.loaded;
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
    text("[data-result]", ["roundResult", "setResult"].includes(room.phase)
      ? result && (result.type === "setEnd" || result.type === "roundEnd")
        ? `${result.type === "setEnd" ? "Set" : "Round"}: ${result.winner ? `${playerName(result.winner)} wins` : result.reason === "aborted" ? "aborted; no winner" : "draw"} · ${result.reason}`
        : `${room.phase === "setResult" ? "Set" : "Round"} finished. Scores: ${state.roster.map((id, i) => `${playerName(id)} ${state.scores[i]}`).join(" · ")}` : "");
    for (const [id, board] of boards) if (!state.roster.includes(id)) { board.container.remove(); boards.delete(id); }
    state.roster.forEach((id, index) => {
      if (id === session.playerId) return;
      let board = boards.get(id);
      if (!board) {
        const container = document.createElement("section");
        container.className = "opponent";
        const label = document.createElement("p");
        label.className = "opponent-label";
        const field = document.createElement("div");
        field.className = "opponent-field";
        const preview = (title: string, height: number) => {
          const panel = document.createElement("aside");
          panel.className = "preview-panel";
          const heading = document.createElement("p"); heading.textContent = title;
          const canvas = document.createElement("canvas"); canvas.width = 150; canvas.height = height;
          panel.append(heading, canvas);
          return { panel, canvas };
        };
        const hold = preview("Hold", 90);
        const next = preview("Next", 450);
        const frame = document.createElement("div"); frame.className = "board-frame";
        const meter = document.createElement("div"); meter.className = "garbage-meter";
        meter.setAttribute("role", "meter"); meter.setAttribute("aria-valuemin", "0"); meter.setAttribute("aria-valuemax", "40");
        const fill = document.createElement("div"); fill.className = "garbage-fill"; meter.append(fill);
        const canvas = document.createElement("canvas");
        canvas.width = 300; canvas.height = 600;
        frame.append(meter, canvas);
        field.append(hold.panel, frame, next.panel);
        container.append(field, label);
        stageElement("[data-opponents]").append(container);
        board = { container, canvas, label, meter, hold: hold.canvas, next: next.canvas }; boards.set(id, board);
      }
      const p = state.players[index];
      board.label.textContent = `${playerName(id)} · ${state.scores[index]} points${p.eliminated ? " · eliminated" : ""}${p.withdrawn ? " · withdrawn" : ""}${room.players.find(p => p.playerId === id)?.connected ? "" : " · disconnected"}`;
      board.meter.setAttribute("aria-label", `${playerName(id)} incoming garbage lines`);
      setGarbage(board.meter, p.garbage.packets.reduce((n, packet) => n + packet.lines, 0));
      if (redraw) {
        drawSnapshot(board.canvas.getContext("2d")!, p.game, options.skins.loaded);
        const hold = board.hold.getContext("2d")!;
        const next = board.next.getContext("2d")!;
        hold.clearRect(0, 0, board.hold.width, board.hold.height);
        next.clearRect(0, 0, board.next.width, board.next.height);
        if (p.game.state.held !== null) drawPiecePreview(hold, p.game.state.held, 30, 150, 90, 0, options.skins.loaded);
        p.game.previews.forEach((piece, i) => drawPiecePreview(next, piece as PieceId, 30, 150, 90, i * 90, options.skins.loaded));
      }
    });
  }
  session.start();
  return { session, update, destroy() { session.stop(); lifetime.abort(); clearMatch(); root.replaceChildren(); } };
}
