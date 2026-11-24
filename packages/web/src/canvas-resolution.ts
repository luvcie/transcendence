const sizes = new WeakMap<HTMLCanvasElement, { columns: number; width: number; ratio: number }>();
let observer: ResizeObserver | undefined;
let resolution: MediaQueryList | undefined;
const listeners = new Set<() => void>();
let ratio = 1;

function watchResolution() {
  const next = window.devicePixelRatio || 1;
  if (resolution && ratio === next) return;
  ratio = next;
  document.documentElement.style.setProperty("--device-pixel", `${1 / ratio}px`);
  resolution?.removeEventListener("change", watchResolution);
  resolution = window.matchMedia(`(resolution: ${ratio}dppx)`);
  resolution.addEventListener("change", watchResolution);
  listeners.forEach(redraw => redraw());
}

if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
  watchResolution();
  window.addEventListener("resize", watchResolution);
}

export function onResolutionChange(redraw: () => void) {
  listeners.add(redraw);
}

export function pixelRatio() {
  if (resolution) watchResolution();
  return ratio;
}

export function cellPixels(cssCell: number, ratio: number) {
  return Math.max(1, Math.round(cssCell * ratio));
}

export function fitCanvas(canvas: HTMLCanvasElement, columns: number, rows: number) {
  let cell = 30;
  if (canvas.style) {
    let size = sizes.get(canvas);
    if (!size || size.columns !== columns || size.ratio !== ratio) {
      if (size?.columns !== columns) canvas.style.setProperty("--canvas-columns", String(columns));
      if (!size && typeof ResizeObserver !== "undefined") {
        observer ??= new ResizeObserver(entries => {
          for (const entry of entries) {
            const size = sizes.get(entry.target as HTMLCanvasElement);
            if (size) size.width = entry.contentRect.width;
          }
        });
        observer.observe(canvas);
      }
      size = { columns, width: canvas.getBoundingClientRect().width, ratio };
      sizes.set(canvas, size);
    }
    if (size.width > 0) cell = cellPixels(size.width / columns, ratio);
  }
  if (canvas.width !== columns * cell) canvas.width = columns * cell;
  if (canvas.height !== rows * cell) canvas.height = rows * cell;
  return cell;
}
