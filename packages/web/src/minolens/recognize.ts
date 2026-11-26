export type RGBAImage = { width: number; height: number; data: Uint8ClampedArray };
export type Rect = { x: number; y: number; width: number; height: number };

const lumOf = (im: RGBAImage) => {
  const { width: w, height: h, data: d } = im;
  const lum = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) lum[i] = d[i * 4] + d[i * 4 + 1] + d[i * 4 + 2];
  return lum;
};

// cell size from the autocorrelation of edge trains, summed per line so that ui with another phase does not cancel the board
function cellSize(w: number, h: number, lum: Float32Array): number {
  // big screenshots are box shrunk first, this is quadratic in the line length
  const f = Math.floor(Math.max(w, h) / 700);
  if (f > 1) {
    const sw = Math.floor(w / f), sh = Math.floor(h / f), small = new Float32Array(sw * sh);
    for (let y = 0; y < sh * f; y++) for (let x = 0; x < sw * f; x++) small[Math.floor(y / f) * sw + Math.floor(x / f)] += lum[y * w + x] / (f * f);
    return f * cellSize(sw, sh, small);
  }
  const L = Math.floor(Math.max(w, h) / 2);
  const a = new Float64Array(L);
  const g = new Float32Array(Math.max(w, h));
  const line = (n: number, get: (i: number) => number) => {
    let m = 0;
    g[0] = 0;
    for (let i = 1; i < n; i++) {
      const v = Math.abs(get(i) - get(i - 1));
      // binary, so a few strong edges (image borders, ui frames) do not drown the faint grid
      g[i] = v > 20 ? 1 : 0;
      m += g[i];
    }
    if (!m) return;
    m /= n;
    for (let i = 0; i < n; i++) g[i] -= m;
    let r0 = 0;
    for (let i = 0; i < n; i++) r0 += g[i] * g[i];
    r0 /= n;
    for (let l = 1; l < Math.min(L, n); l++) {
      let s = 0;
      for (let i = 0; i + l < n; i++) s += g[i] * g[i + l];
      a[l] += s / (n - l) / r0;
    }
  };
  for (let y = 0; y < h; y++) line(w, (i) => lum[y * w + i]);
  for (let x = 0; x < w; x++) line(h, (i) => lum[i * w + x]);
  const at = (x: number) => {
    const i = Math.floor(x), f = x - i;
    return i + 1 < L ? Math.max(a[i] * (1 - f) + a[i + 1] * f, a[Math.round(x)]) : 0;
  };
  // harmonics against their half offsets, so half periods score lower
  const ps: number[] = [], ss: number[] = [];
  // the board is assumed to span at least an eighth of the image, text and video noise live below that
  for (let p = Math.max(8, Math.max(w, h) / 80); p <= w / 9 && p < L - 1; p += 0.1) {
    let s = 0, k = 1;
    for (; k <= 4 && k * p < L - 1; k++) s += at(k * p) - at(k * p - p / 2);
    ps.push(p);
    ss.push(s / (k - 1));
  }
  // multiples of the cell (and of the board width) score as well, so take the smallest strong peak
  const top = Math.max(...ss);
  const k = ss.findIndex((s, i) => s >= 0.8 * top && s >= (ss[i - 1] ?? -Infinity) && s >= (ss[i + 1] ?? -Infinity));
  return ps[k] ?? 8;
}

const profiles = (im: RGBAImage, lum: Float32Array) => {
  const { width: w, height: h } = im;
  const px = new Float32Array(w), py = new Float32Array(h);
  for (let y = 1; y < h; y++)
    for (let x = 1; x < w; x++) {
      const i = y * w + x, gx = Math.abs(lum[i] - lum[i - 1]), gy = Math.abs(lum[i] - lum[i - w]);
      if (gx > 30) px[x]++;
      if (gy > 30) py[y]++;
    }
  return [px, py];
};

// tolerant to edges blurred over two pixels by scaling
const soft = (prof: Float32Array, x: number) => {
  const i = Math.round(x);
  return prof[i] + 0.5 * ((prof[i - 1] ?? 0) + (prof[i + 1] ?? 0));
};

// edge at x means the boundary between pixel x-1 and x
const combScore = (prof: Float32Array, p: number, o: number) => {
  let s = 0, n = 0;
  for (let x = o; x + p / 2 < prof.length - 1; x += p) {
    s += soft(prof, x) - soft(prof, x + p / 2);
    n++;
  }
  return n ? s / n : -Infinity;
};

// refine the size and find the offsets: grid lines should catch more edges than the lines halfway between
function fitGrid(im: RGBAImage, lum: Float32Array) {
  const p0 = cellSize(im.width, im.height, lum), r = Math.max(0.5, 0.05 * p0);
  const [px, py] = profiles(im, lum);
  let best = { cell: p0, ox: 0, oy: 0, score: -Infinity };
  for (let p = p0 - r; p <= p0 + r; p += 0.05) {
    let bx = -Infinity, ox = 0, by = -Infinity, oy = 0;
    for (let o = 0; o < p; o += 0.5) {
      const sx = combScore(px, p, o), sy = combScore(py, p, o);
      if (sx > bx) [bx, ox] = [sx, o];
      if (sy > by) [by, oy] = [sy, o];
    }
    const s = bx / im.height + by / im.width;
    if (s > best.score) best = { cell: p, ox, oy, score: s };
  }
  return best;
}

// per channel median of the pixels in the cell box [a,b] (fractions of the cell), skipping the inner box [c,d] when given
function sampleCell(im: RGBAImage, x0: number, y0: number, p: number, a: number, b: number, c = 1, d = 0): number[] {
  const ch: number[][] = [[], [], []];
  const left = Math.max(0, x0), width = Math.min(im.width, x0 + p) - left;
  const x1 = Math.round(left + a * width), x2 = Math.round(left + b * width);
  const y1 = Math.max(0, Math.round(y0 + a * p)), y2 = Math.min(im.height, Math.round(y0 + b * p));
  for (let y = y1; y < y2; y++)
    for (let x = x1; x < x2; x++) {
      const fx = (x + 0.5 - left) / width, fy = (y + 0.5 - y0) / p;
      if (fx > c && fx < d && fy > c && fy < d) continue;
      const i = (y * im.width + x) * 4;
      for (let k = 0; k < 3; k++) ch[k].push(im.data[i + k]);
    }
  return ch.map((v) => (v.sort((m, n) => m - n), v[v.length >> 1] ?? 0));
}

export type Recognition = {
  cols: number;
  rows: number;
  cells: Uint8Array;
  bounds: Rect;
  cell: number;
  confidence: Float32Array;
};

const lin = (c: number) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

// oklab lightness, chroma, hue in degrees: its hue keeps I and J apart better than hsv
function oklch([r8, g8, b8]: number[]): [number, number, number] {
  const r = lin(r8), g = lin(g8), b = lin(b8);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, Math.hypot(A, B), ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360];
}

// oklab hue where each piece colour starts, measured on harddrop, four.lol and tetr.io skins
const HUES: [number, number][] = [[36, 2], [76, 3], [117, 4], [154, 5], [242, 6], [307, 7], [353, 1]];

function hueToPiece(h: number): { id: number; margin: number } {
  let k = HUES.length - 1;
  for (let i = 0; i < HUES.length; i++) if (h >= HUES[i][0]) k = i;
  const next = HUES[(k + 1) % HUES.length][0];
  const d = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);
  return { id: HUES[k][1], margin: Math.min(d(h, HUES[k][0]), d(h, next)) };
}

const diff = (a: number[], b: number[]) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
const NEAR = 40;
const MAX_ROWS = 20;
const clamp = (v: number) => Math.min(1, Math.max(0, v));

type Cell = { id: number; conf: number; light: number };
type CellColors = { background: number[]; frames: number[][]; dim: number };

const mode = (cs: number[][]) => {
  let best = cs[0], count = -1;
  for (const c of cs) {
    const n = cs.filter((o) => diff(c, o) <= 20).length;
    if (n > count) [best, count] = [c, n];
  }
  return best;
};

function classify(im: RGBAImage, ox: number, oy: number, p: number, cols: number, rows: number, colors?: CellColors) {
  const centres: number[][] = [], rings: number[][] = [];
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < cols; i++) {
      const x = ox + i * p, y = oy + j * p;
      centres.push(sampleCell(im, x, y, p, 0.3, 0.7));
      // the ring skips the middle where markers sit and where ghost outlines leave a hole
      rings.push(sampleCell(im, x, y, p, 0.12, 0.88, 0.27, 0.73));
    }
  // empty colour: most common centre colour in the top half, gravity keeps blocks low
  const background = colors?.background ?? mode(centres.slice(0, Math.max(cols, Math.floor(rows / 2) * cols)));
  const cells: Cell[] = centres.map((c, k) => {
    const d = Math.min(diff(c, background), diff(rings[k], background));
    if (d <= NEAR) return { id: 0, conf: clamp(1 - d / (2 * NEAR)), light: 0 };
    // blocks are about uniform, a centre unlike its ring is a ghost outline or a marker
    const spread = diff(c, rings[k]);
    if (spread > 60) return { id: 0, conf: 0.5, light: 0 };
    // text banners can cover the centre without filling the cell vertically
    const x = ox + (k % cols) * p, y = oy + Math.floor(k / cols) * p;
    for (const offset of [y - 0.3 * p, y + 0.3 * p]) {
      const first = Math.max(0, Math.round(offset + 0.3 * p));
      const last = Math.min(im.height, Math.round(offset + 0.7 * p));
      if (first >= last) continue;
      const face = sampleCell(im, x, offset, p, 0.3, 0.7);
      if (diff(face, background) <= NEAR) return { id: 0, conf: 0.5, light: 0 };
    }
    const [light, chroma, hue] = oklch(c);
    if (chroma < 0.04) {
      const contrast = clamp((d - NEAR) / (NEAR / 2 + spread));
      return { id: 8, conf: Math.min(contrast, clamp(1 - chroma / 0.08)), light };
    }
    const sure = clamp((d - NEAR) / NEAR);
    const { id, margin } = hueToPiece(hue);
    return { id, conf: Math.min(sure, clamp(margin * chroma / 0.8), clamp(chroma / 0.08)), light };
  });
  // a frame (like the harddrop wiki one) is one colour along a whole row, or down from the top longer than an I piece
  const frames: number[][] = colors?.frames ?? [];
  if (!colors) {
    const same = (k: number, prev: number) => cells[k].id > 0 && diff(centres[k], centres[prev]) <= 12;
    for (let j = 0; j < rows; j++)
      for (let i = 1, n = 1; i < cols; i++) if ((n = same(j * cols + i, j * cols + i - 1) ? n + 1 : 1) === 10) frames.push(centres[j * cols + i]);
    for (let i = 0; i < cols && rows > 5; i++) {
      let j = 1;
      while (j < rows && cells[i].id > 0 && same(j * cols + i, (j - 1) * cols + i)) j++;
      if (j > 5) frames.push(centres[i]);
    }
  }
  cells.forEach((c, k) => {
    if (c.id > 0 && frames.some((f) => diff(centres[k], f) <= 12)) [c.id, c.conf] = [0, 0.5];
  });
  // glow and afterimages are saturated but much darker than real blocks
  let dim = colors?.dim;
  if (dim === undefined) {
    const lights = cells.filter((c) => c.id > 0 && c.id < 8).map((c) => c.light).sort((a, b) => a - b);
    dim = 0.6 * (lights[lights.length >> 1] ?? 0);
  }
  for (const c of cells) if (c.id > 0 && c.id < 8 && c.light < dim) [c.id, c.conf] = [0, 0.5];
  return { cells, colors: { background, frames, dim } };
}

const result = (cells: Cell[], p: number, bounds: Rect): Recognition => ({
  cols: 10,
  rows: cells.length / 10,
  cells: Uint8Array.from(cells, (c) => c.id),
  confidence: Float32Array.from(cells, (c) => c.conf),
  bounds,
  cell: p,
});

const noBoard = () => result([], 0, { x: 0, y: 0, width: 0, height: 0 });

function gridLines(lum: Float32Array, width: number, x: number, y: number, p: number, walls = false) {
  const offset = Math.floor(y + p / 2) * width;
  if (offset < 0 || offset >= lum.length) return 0;
  const edge = (x: number) => {
    const i = Math.round(x);
    let peak = 0;
    for (let j = Math.max(1, i - 2); j <= Math.min(width - 1, i + 2); j++) {
      peak = Math.max(peak, Math.abs(lum[offset + j] - lum[offset + j - 1]));
    }
    return peak;
  };
  let lines = 0;
  for (let i = 1; i < 10; i++) if (edge(x + i * p) - edge(x + (i - 0.5) * p) > 10) lines++;
  if (walls) {
    if (edge(x) - edge(x + 0.5 * p) > 10) lines++;
    if (edge(x + 10 * p) - edge(x + 9.5 * p) > 10) lines++;
  }
  return lines;
}

export function recognizeBoard(im: RGBAImage, { bounds }: { bounds?: Rect } = {}): Recognition {
  if (!bounds) return fitBoard(im)?.board ?? noBoard();
  const x = Math.max(0, Math.round(bounds.x));
  const y = Math.max(0, Math.round(bounds.y));
  const width = Math.min(im.width, Math.round(bounds.x + bounds.width)) - x;
  const height = Math.min(im.height, Math.round(bounds.y + bounds.height)) - y;
  if (!(width > 0 && height > 0)) return noBoard();

  const data = new Uint8ClampedArray(width * height * 4);
  for (let row = 0; row < height; row++) {
    const start = ((y + row) * im.width + x) * 4;
    data.set(im.data.subarray(start, start + width * 4), row * width * 4);
  }
  const cropped = { width, height, data };
  const colors = fitBoard(im)?.colors;
  const fitted = fitBoard(cropped, { crop: true, colors })?.board;
  if (fitted) {
    return { ...fitted, bounds: { ...fitted.bounds, x: fitted.bounds.x + x, y: fitted.bounds.y + y } };
  }

  const p = width / 10, rows = Math.round(height / p);
  if (rows < 1 || rows > MAX_ROWS) return noBoard();
  // a literal crop still needs evidence of a cell edge in each direction
  const [px, py] = profiles(cropped, lumOf(cropped));
  if (combScore(px, p, 0) * 10 < p - 1 || (rows > 1 && combScore(py, p, 0) * rows < p - 1)) return noBoard();
  const { cells } = classify(cropped, 0, 0, p, 10, rows, colors);
  if (!cells.some(c => c.id > 0 && c.conf > 0.5)) return noBoard();
  return result(cells, p, { x, y, width, height: rows * p });
}

function fitBoard(im: RGBAImage, { crop = false, colors }: { crop?: boolean; colors?: CellColors } = {}) {
  const lum = lumOf(im);
  const g = fitGrid(im, lum);
  const p = g.cell;
  const span = 10 * p;
  const centre = (im.width - span) / 2;
  const maxClip = 0.75 * p;
  const minVisible = Math.abs(im.width - span) <= maxClip ? p - maxClip : p / 2;
  const i0 = Math.ceil((minVisible - g.ox) / p - 1);
  const j0 = Math.ceil(-g.oy / p - 0.5);
  const nx = Math.floor((im.width - g.ox - minVisible) / p) - i0 + 1;
  const ny = Math.floor((im.height - g.oy) / p - 0.5) - j0 + 1;
  const ox = g.ox + i0 * p, oy = g.oy + j0 * p;
  if (nx < 1 || ny < 1 || (crop && (nx < 10 || g.score <= 0))) return;
  const classified = classify(im, ox, oy, p, nx, ny, colors);
  const { cells } = classified;
  const filled = (i: number, j: number) => i >= 0 && i < nx && cells[j * nx + i].id > 0;

  // the board is the 10 column window holding the most blocks, ties go to the most centred
  let c0 = 0, best = -1;
  for (let c = Math.min(0, nx - 10); c <= Math.max(0, nx - 10); c++) {
    let n = 0;
    for (let j = 0; j < ny; j++) for (let i = c; i < c + 10; i++) if (filled(i, j)) n++;
    const off = Math.abs(ox + c * p - centre);
    if (n > best || (n === best && off < Math.abs(ox + c0 * p - centre))) [c0, best] = [c, n];
  }
  let floor = ny - 1;
  if (!crop && nx > 10 && ny >= MAX_ROWS) {
    const initial = c0;
    let strongest = 9 * MAX_ROWS;
    for (let c = 0; c <= nx - 10; c++) {
      const x = ox + c * p;
      if (x < 0 || x + span > im.width) continue;
      const lines = Array.from({ length: ny }, (_, j) =>
        gridLines(lum, im.width, x, oy + j * p, p, true));
      let sum = 0;
      for (let j = 0; j < ny; j++) {
        sum += lines[j] - (lines[j - MAX_ROWS] ?? 0);
        if (j >= MAX_ROWS - 1 && (sum > strongest || (sum === strongest && Math.abs(c - initial) < Math.abs(c0 - initial)))) {
          strongest = sum;
          c0 = c;
          floor = j;
        }
      }
    }
  }
  const rowFilled = (j: number) => {
    for (let i = c0; i < c0 + 10; i++) if (filled(i, j)) return true;
    return false;
  };
  let bottom = floor;
  while (bottom > 0 && !rowFilled(bottom)) bottom--;
  if (crop && !rowFilled(bottom)) return;
  // the visible playfield has at most 20 rows; a gap also separates spawn previews
  let top = bottom;
  const first = Math.max(0, bottom - MAX_ROWS + 1);
  for (let j = bottom, gap = 0; j >= first && gap < 3; j--) {
    if (rowFilled(j)) [top, gap] = [j, 0];
    else gap++;
  }
  if (crop) {
    // distinguish empty playfield rows from margins in a loose selection
    const gridRow = (j: number) => gridLines(lum, im.width, ox + c0 * p, oy + j * p, p) >= 5;
    while (bottom + 1 < ny && bottom - top + 1 < MAX_ROWS && gridRow(bottom + 1)) bottom++;
    while (top > 0 && bottom - top + 1 < MAX_ROWS && !rowFilled(top - 1) && gridRow(top - 1)) top--;
  }
  const out: Cell[] = [];
  for (let j = top; j <= bottom; j++)
    for (let i = c0; i < c0 + 10; i++) out.push(i >= 0 && i < nx ? cells[j * nx + i] : { id: 0, conf: 0, light: 0 });
  const board = result(out, p, { x: ox + c0 * p, y: oy + top * p, width: 10 * p, height: (bottom - top + 1) * p });
  return { board, colors: best > 0 ? classified.colors : undefined };
}
