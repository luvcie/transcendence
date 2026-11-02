import type { Session } from "./session";

export function mountGuestName(root: HTMLElement, getSession: () => Session | undefined) {
  const button = root.querySelector<HTMLButtonElement>("[data-edit-name]")!;
  const label = root.querySelector<HTMLElement>("[data-current-name]")!;
  const form = root.querySelector<HTMLFormElement>("[data-edit-form]")!;
  const input = form.elements.namedItem("name") as HTMLInputElement;
  function finish() {
    form.hidden = true;
    button.hidden = false;
    button.focus();
  }
  button.addEventListener("click", () => {
    const session = getSession();
    if (!session?.connected) return;
    input.value = session.room?.players.find(p => p.playerId === session.playerId)?.name ?? session.name;
    button.hidden = true;
    form.hidden = false;
    input.focus();
    input.select();
  });
  form.addEventListener("keydown", event => {
    event.stopPropagation();
    if (event.key === "Escape") { event.preventDefault(); finish(); }
  });
  form.addEventListener("keyup", event => event.stopPropagation());
  form.addEventListener("submit", event => {
    event.preventDefault();
    const session = getSession();
    if (!session?.connected) return;
    session.rename(input.value);
    finish();
  });
  return { update() {
    const session = getSession();
    const player = session?.room?.players.find(p => p.playerId === session.playerId);
    root.hidden = session?.room?.phase !== "waiting" || !player;
    button.disabled = !session?.connected;
    if (player && label.textContent !== player.name) label.textContent = player.name;
    if ((root.hidden || !session?.connected) && !form.hidden) { form.hidden = true; button.hidden = false; }
  } };
}
