import type { PieceId } from "@42tris/core";
import { BUILTIN_SKINS, customSkin, SKIN_DATABASE, type SkinDef } from "./skin-catalog";
import { SkinState } from "./skin-state";
import { drawPiecePreview } from "./tile-renderer";

export function setupSkins(state: SkinState) {
  const panel = document.querySelector<HTMLElement>("#settings-skins")!;
  const list = document.querySelector<HTMLElement>("#skin-list")!;
  const note = document.querySelector<HTMLElement>("#skin-note")!;
  const form = document.querySelector<HTMLFormElement>("#skin-form")!;
  const input = document.querySelector<HTMLInputElement>("#custom-skin")!;
  const add = form.querySelector<HTMLButtonElement>("button")!;
  let visible = false;
  let generation = 0;
  const previews = new Map<Element, () => void>();
  const observer = typeof IntersectionObserver === "undefined" ? undefined : new IntersectionObserver(entries => {
    for (const entry of entries) if (entry.isIntersecting) {
      previews.get(entry.target)?.();
      previews.delete(entry.target);
      observer!.unobserve(entry.target);
    }
  }, { root: document.querySelector("#settings-dialog"), rootMargin: "100px" });

  function refreshSelection() {
    for (const button of list.querySelectorAll<HTMLButtonElement>("button[data-skin]")) {
      const selected = button.dataset.skin === state.preferences.active;
      button.setAttribute("aria-pressed", String(selected));
      button.textContent = selected ? "Selected (retry)" : "Use";
    }
    note.textContent = state.message;
  }
  function link(url: string, text: string) {
    const anchor = document.createElement("a");
    anchor.href = url; anchor.textContent = text; anchor.target = "_blank"; anchor.rel = "noreferrer";
    return anchor;
  }
  document.querySelector("#skin-credit")!.append("Catalog ported from memominolab. Artwork and skin links from the ",
    link(SKIN_DATABASE, "jstris customization database"), ". Classic uses 42tris colors.");

  function option(def: SkinDef, index?: number) {
    const item = document.createElement("article");
    item.className = "skin-option";
    const head = document.createElement("div");
    head.className = "skin-head";
    const title = document.createElement("h3");
    title.textContent = def.label;
    const use = document.createElement("button");
    use.type = "button"; use.dataset.skin = def.id;
    use.setAttribute("aria-label", `Use ${def.label}`);
    use.addEventListener("click", () => {
      const pending = state.select(def.id);
      refreshSelection();
      void pending.then(refreshSelection);
    });
    head.append(title, use);
    if (index !== undefined) {
      const remove = document.createElement("button");
      remove.type = "button"; remove.textContent = "Remove";
      remove.setAttribute("aria-label", `Remove ${def.label}`);
      remove.addEventListener("click", () => {
        const pending = state.remove(index);
        render();
        input.focus();
        void pending.then(refreshSelection);
      });
      head.append(remove);
    }
    const row = document.createElement("div");
    row.className = "skin-preview";
    row.setAttribute("aria-hidden", "true");
    const canvases: HTMLCanvasElement[] = [];
    for (let piece = 1; piece <= 7; piece++) {
      const canvas = document.createElement("canvas");
      canvas.width = 72; canvas.height = 72;
      canvases.push(canvas); row.append(canvas);
    }
    const status = document.createElement("p");
    status.className = "hint";
    const paint = (skin?: Awaited<ReturnType<typeof state.load>>) => {
      canvases.forEach((canvas, i) => {
        const ctx = canvas.getContext("2d")!;
        ctx.clearRect(0, 0, 72, 72);
        drawPiecePreview(ctx, (i + 1) as PieceId, 16, 72, 72, 0, skin);
      });
    };
    paint();
    const current = generation;
    const load = () => {
      status.textContent = def.url ? "Loading preview…" : "Made with code.";
      void state.load(def).then(skin => {
        if (current !== generation) return;
        paint(skin); status.textContent = def.url ? "" : "Made with code.";
      }).catch((error: Error) => {
        if (current === generation) status.textContent = `${error.message} Preview uses Classic colors.`;
      });
    };
    item.append(head, row, status);
    if (def.source) {
      const source = document.createElement("p"); source.className = "hint";
      if (def.credit) source.append(`Art by ${def.credit}. `);
      source.append(link(def.source, "Source image")); item.append(source);
    }
    list.append(item);
    if (observer) { previews.set(item, load); observer.observe(item); }
    else load();
  }
  function render() {
    generation++;
    observer?.disconnect(); previews.clear(); list.replaceChildren();
    for (const def of BUILTIN_SKINS) option(def);
    state.preferences.customs.forEach((url, i) => option(customSkin(url, i), i));
    refreshSelection();
  }
  form.addEventListener("submit", event => {
    event.preventDefault();
    if (add.disabled) return;
    add.disabled = true;
    note.textContent = "Checking image…";
    void state.add(input.value).then(added => {
      add.disabled = false;
      if (added) { input.value = ""; if (visible) render(); }
      refreshSelection();
    });
  });
  return (open: boolean) => {
    visible = open;
    if (open) render();
    else {
      generation++; observer?.disconnect(); previews.clear();
      state.cancelPendingAdd();
    }
    panel.hidden = !open;
  };
}

export function setupSettingsTabs(cancelCapture: () => void, showSkins: (open: boolean) => void) {
  const dialog = document.querySelector<HTMLDialogElement>("#settings-dialog")!;
  const tabs = [...dialog.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  const general = document.querySelector<HTMLElement>("#settings-general")!;
  function activate(index: number) {
    cancelCapture();
    tabs.forEach((tab, i) => { tab.setAttribute("aria-selected", String(i === index)); tab.tabIndex = i === index ? 0 : -1; });
    general.hidden = index !== 0;
    showSkins(index === 1);
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => activate(index));
    tab.addEventListener("keydown", event => {
      let next: number;
      if (event.key === "ArrowRight" || event.key === "ArrowLeft") next = 1 - index;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = 1;
      else return;
      event.preventDefault(); activate(next); tabs[next].focus();
    });
  });
  dialog.addEventListener("close", () => activate(0));
}
