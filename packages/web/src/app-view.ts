import type { RoomState } from "@42tris/protocol";

export type AppView = "home" | "solo" | "lobby" | RoomState["phase"];

const titles: Record<AppView, string> = {
  home: "Choose your game",
  solo: "Singleplayer",
  lobby: "Online lobby",
  waiting: "Waiting room",
  preparing: "Preparing match",
  countdown: "Get ready",
  playing: "Online match",
  paused: "Reconnecting",
  roundResult: "Round results",
  setResult: "Set results",
};

export function onlineView(room: RoomState | null, connected = true): AppView {
  if (!connected && room && ["preparing", "countdown", "playing", "roundResult"].includes(room.phase)) return "paused";
  return room?.phase ?? "lobby";
}

export function hasGameView(view: AppView): boolean {
  return view !== "home" && view !== "lobby" && view !== "waiting";
}

export function mountAppView(document: Document) {
  const main = document.querySelector<HTMLElement>("main")!;
  const title = document.querySelector<HTMLElement>("#view-title")!;
  const game = document.querySelector<HTMLElement>("#game-view")!;
  const online = document.querySelector<HTMLElement>("#online")!;
  let current: AppView | undefined;
  return (view: AppView) => {
    if (current === view) return;
    current = view;
    main.setAttribute("data-view", view);
    title.textContent = titles[view];
    game.hidden = !hasGameView(view);
    online.hidden = view === "solo" || view === "home";
    document.querySelector<HTMLElement>("#home-view")!.hidden = view !== "home";
    document.querySelector("#solo-button")!.setAttribute("aria-current", view === "solo" || view === "home" ? "page" : "false");
    document.querySelector("#online-button")!.setAttribute("aria-current", view !== "solo" && view !== "home" ? "page" : "false");
    document.querySelector<HTMLElement>("#pause-button")!.hidden = view !== "solo";
    if (!document.querySelector("dialog[open]")) (view === "home" ? document.querySelector<HTMLElement>("#home-title")! : title).focus({ preventScroll: true });
  };
}

export function initialView(url: string, hasResume: boolean): "home" | "lobby" {
  return new URL(url).searchParams.has("room") || hasResume ? "lobby" : "home";
}
