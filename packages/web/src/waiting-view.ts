import type { Session } from "./session";

export function renderOnlineWaiting(document: Document, session: Session): boolean {
  // A lost socket retains its checkpoint. Only absent authoritative match state
  // clears the presentation; disconnects must retain the frozen boards.
  if (session.checkpoint?.state) return false;
  for (const id of ["board", "hold-preview", "next-preview"]) {
    const canvas = document.querySelector<HTMLCanvasElement>(`#${id}`)!;
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    canvas.setAttribute("aria-label", id === "board" ? "Waiting for a match" : "Empty preview");
    if (id === "board") {
      ctx.fillStyle = "#aaa";
      ctx.font = "16px monospace";
      ctx.textAlign = "center";
      ctx.fillText("Waiting for a match", canvas.width / 2, canvas.height / 2);
    }
  }
  document.querySelector<HTMLButtonElement>("#hold-button")!.disabled = true;
  for (const id of ["line-count", "combo-count", "b2b-count", "surge-count", "clear-result", "zen-status"]) {
    const element = document.querySelector(`#${id}`)!;
    element.textContent = "";
    element.removeAttribute("title");
  }
  document.querySelector<HTMLElement>("#zen-status")!.hidden = true;
  return true;
}
