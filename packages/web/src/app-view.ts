import type { RoomState } from "@42tris/protocol";

export const toolPaths = { emoji: "/tetorisueditor", minolens: "/minolens" };
export type ToolView = keyof typeof toolPaths;
export type AppView = "home" | ToolView | "solo" | "lobby" | "sprintReplay" | "matchReplay" | RoomState["phase"];

const titles: Record<AppView, string> = {
  sprintReplay: "Sprint replay",
  matchReplay: "Competitive replay",
  home: "Choose your game",
  emoji: "Tetorisu Editor",
  minolens: "Minolens screenshot import",
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
  return view !== "home" && view !== "emoji" && view !== "minolens" && view !== "lobby" && view !== "waiting" && view !== "matchReplay";
}

export function mountAppView(document: Document) {
  const main = document.querySelector<HTMLElement>("main")!;
  const title = document.querySelector<HTMLElement>("#view-title")!;
  const game = document.querySelector<HTMLElement>("#game-view")!;
  const online = document.querySelector<HTMLElement>("#online")!;
  const soloButton = document.querySelector("#solo-button")!;
  let current: AppView | undefined;
  return (view: AppView) => {
    if (current === view) return;
    const tool = view === "emoji" || view === "minolens";
    if ((current === "emoji" || current === "minolens") && !tool) document.defaultView?.history.replaceState(null, "", "/");
    current = view;
    main.setAttribute("data-view", view);
    if (view === "sprintReplay" || view === "matchReplay") main.setAttribute("data-replay", "");
    else main.removeAttribute("data-replay");
    title.textContent = titles[view];
    document.title = view === "minolens" ? `${titles[view]} | Tetorisu Editor` : "42tris";
    game.hidden = !hasGameView(view);
    const singleplayer = view === "solo" || view === "home" || tool || view === "sprintReplay";
    online.hidden = singleplayer || view === "matchReplay";
    document.querySelector<HTMLElement>("#home-view")!.hidden = view !== "home";
    document.querySelector<HTMLElement>("#emoji-view")!.hidden = view !== "emoji";
    document.querySelector<HTMLElement>("#minolens-view")!.hidden = view !== "minolens";
    soloButton.setAttribute("aria-current", singleplayer ? "page" : "false");
    document.querySelector("#online-button")!.setAttribute("aria-current", singleplayer ? "false" : "page");
    if (!document.querySelector("dialog[open]")) {
      const heading = view === "home" || tool ? `#${view}-title` : "#view-title";
      document.querySelector<HTMLElement>(heading)!.focus({ preventScroll: true });
    }
  };
}

export function initialView(url: string, hasResume: boolean): "home" | "lobby" | ToolView {
  const { pathname, searchParams } = new URL(url);
  for (const view of ["emoji", "minolens"] as const) {
    if (pathname === toolPaths[view] || pathname === toolPaths[view] + "/") return view;
  }
  return searchParams.has("room") || hasResume ? "lobby" : "home";
}
