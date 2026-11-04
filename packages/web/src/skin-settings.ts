import type { PieceId } from "@42tris/core";
import { BUILTIN_SKINS, customSkin, SKIN_DATABASE, TETRIO_SKIN_DATABASE, type SkinDef } from "./skin-catalog";
import { SkinState } from "./skin-state";
import { drawPiecePreview } from "./tile-renderer";
import { resolveSkin } from "./skin-preferences";
import { createSettingsGroup, setupSettingsSearch } from "./settings-search";

export function setupSkins(state: SkinState) {
  const panel = document.querySelector<HTMLElement>("#settings-skins")!;
  const list = document.querySelector<HTMLElement>("#skin-list")!;
  const filter = setupSettingsSearch(document.querySelector<HTMLInputElement>("#skin-search")!, list,
    document.querySelector<HTMLElement>("#skin-empty")!);
  const note = document.querySelector<HTMLElement>("#skin-note")!;
  const form = document.querySelector<HTMLFormElement>("#skin-form")!;
  const input = document.querySelector<HTMLInputElement>("#custom-skin")!;
  const add = form.querySelector<HTMLButtonElement>("button")!;
  let visible = false;
  let generation = 0;
  const previews = new Map<Element, (visible: boolean) => void>();
  const observer = typeof IntersectionObserver === "undefined" ? undefined : new IntersectionObserver(entries => {
    for (const entry of entries) previews.get(entry.target)?.(entry.isIntersecting);
  }, { root: document.querySelector("#settings-dialog"), rootMargin: "100px" });

  function refreshSelection() {
    document.querySelector("#skin-selected")!.textContent = `Selected: ${resolveSkin(state.preferences).label}`;
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
  document.querySelector("#skin-credit")!.append("Artwork and skin links from the ",
    link(SKIN_DATABASE, "jstris customization database"), " and the ", link(TETRIO_SKIN_DATABASE, "TETR.IO+ database"), ".", document.createElement("br"),
    "42tris ships no skin assets other than its own originals, community skins are loaded live from external links.");

  function option(def: SkinDef, index?: number) {
    const item = document.createElement("article");
    item.className = "skin-option";
    item.dataset.search = [def.id, def.label, def.credit, def.url].join(" ");
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
    const current = generation;
    let onScreen = false, started = false, frame = 0, revision = 0;
    let previewSkin: Awaited<ReturnType<typeof state.load>>;
    const animate = () => {
      if (current !== generation || !onScreen) return;
      paint(previewSkin);
      if (previewSkin?.animation) frame = requestAnimationFrame(animate);
    };
    const load = () => {
      const request = ++revision;
      paint();
      status.textContent = def.url ? "Loading preview…" : "Made with code.";
      void state.load(def).then(skin => {
        if (current !== generation || request !== revision) return;
        if (skin?.animation) { previewSkin = skin; animate(); }
        else paint(skin);
        status.textContent = def.url ? "" : "Made with code.";
      }).catch((error: Error) => {
        if (current === generation && request === revision) status.textContent = `${error.message} Preview uses Classic colors.`;
      });
    };
    item.append(head, row, status);
    if (def.source) {
      const source = document.createElement("p"); source.className = "hint";
      if (def.credit) source.append(`Art by ${def.credit}. `);
      source.append(link(def.source, "Source")); item.append(source);
    }
    const show = (show: boolean) => {
      onScreen = show;
      cancelAnimationFrame(frame);
      if (!show) { revision++; previewSkin = undefined; started = false; return; }
      if (!started) { started = true; load(); }
      else if (previewSkin) animate();
    };
    if (observer) { previews.set(item, show); observer.observe(item); }
    else show(true);
    return item;
  }
  function render() {
    generation++;
    observer?.disconnect(); previews.forEach(show => show(false)); previews.clear(); list.replaceChildren();
    const groups: [string, readonly SkinDef[]][] = [
      ["42tris", BUILTIN_SKINS.filter(def => !def.url)],
      ["Jstris community", BUILTIN_SKINS.filter(def => def.url && !def.url.startsWith(TETRIO_SKIN_DATABASE))],
      ["TETR.IO+ database", BUILTIN_SKINS.filter(def => def.url?.startsWith(TETRIO_SKIN_DATABASE))],
      ["Custom skins", state.preferences.customs.map(customSkin)],
    ];
    for (const [label, defs] of groups) {
      if (!defs.length) continue;
      const options = createSettingsGroup(list, label, defs.some(def => def.id === state.preferences.active));
      defs.forEach((def, index) => options.append(option(def, def.id.startsWith("custom:") ? index : undefined)));
    }
    filter();
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
      generation++; observer?.disconnect(); previews.forEach(show => show(false)); previews.clear();
      state.cancelPendingAdd();
    }
    panel.hidden = !open;
  };
}

export function setupSettingsTabs(cancelCapture: () => void, showSkins: (open: boolean) => void, showSounds: (open: boolean) => void) {
  const dialog = document.querySelector<HTMLDialogElement>("#settings-dialog")!;
  const tabs = [...dialog.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  const general = document.querySelector<HTMLElement>("#settings-general")!;
  function activate(index: number) {
    cancelCapture();
    tabs.forEach((tab, i) => { tab.setAttribute("aria-selected", String(i === index)); tab.tabIndex = i === index ? 0 : -1; });
    general.hidden = index !== 0;
    showSkins(index === 1);
    showSounds(index === 2);
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => activate(index));
    tab.addEventListener("keydown", event => {
      let next: number;
      if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
      else if (event.key === "ArrowLeft") next = (index + tabs.length - 1) % tabs.length;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = tabs.length - 1;
      else return;
      event.preventDefault(); activate(next); tabs[next].focus();
    });
  });
  dialog.addEventListener("close", () => activate(0));
}
