import type { TiledImage } from './tiled';

/**
 * A cheap local check for "is there any lettering on this picture at all?", run before the vision
 * model is asked. Webtoon chapters have many pictures with only art (or a blank gutter): skipping
 * those saves a model call each.
 *
 * How: the picture is shrunk to at most 640 px wide and turned grey; pixels much darker or much
 * lighter than their neighbourhood are marks (dark-on-light lettering in bubbles, light-on-dark in
 * captions and on dark plates). Letter-sized marks of one kind are joined into rows (horizontal
 * text) and columns (vertical CJK text). A run of 3+ marks counts as a line of text when
 *   - the marks differ in shape (letters do; screentone dots and hatching are all the same), and
 *   - most of what lies around them is one flat colour (a bubble, a caption box, a plate).
 * The verdict "no text" is given only when there is no such line anywhere: it is meant to be very
 * conservative, a page with text must never be skipped (the user can still force a translation).
 */
export interface TextCheck {
  /** Lines of text found (rows or columns of 3+ letter-like marks on a flat background); the scan stops after the first band with one unless `full`. */
  lines: number;
  /** Letter-like marks in those lines. */
  letters: number;
  /** No line of text anywhere: the picture can be skipped. */
  noText: boolean;
  ms: number;
}

const TARGET_W = 640;
const BAND = 1024;
const OVERLAP = 96;
const RADIUS = 8;
const CONTRAST = 30;

interface Mark {
  x: number;
  y: number;
  w: number;
  h: number;
  area: number;
  dark: boolean;
  label: number;
}

export function checkForText(image: TiledImage, opts: { full?: boolean } = {}): TextCheck {
  const t0 = performance.now();
  const scale = Math.min(1, TARGET_W / image.width);
  const W = Math.max(1, Math.round(image.width * scale));
  const H = Math.max(1, Math.round(image.height * scale));
  let lines = 0;
  let letters = 0;
  for (let top = 0; top < H; top += BAND - OVERLAP) {
    const bh = Math.min(BAND, H - top);
    if (bh < 8) break;
    const canvas = image.backend.createCanvas(W, bh);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingQuality = 'high';
    image.drawRegion(ctx, 0, top / scale, image.width, bh / scale, W, bh);
    const data: Uint8ClampedArray = ctx.getImageData(0, 0, W, bh).data;
    const r = scanBand(data, W, bh, { top: top === 0, bottom: top + bh >= H });
    lines += r.lines;
    letters += r.letters;
    // One line of text is enough for the verdict; `full` counts every band (tests, statistics).
    if (top + bh >= H || (lines && !opts.full)) break;
  }
  return { lines, letters, noText: lines === 0, ms: Math.round(performance.now() - t0) };
}

/** Grey values, local means and marks of one band; returns the lines of text in it. */
function scanBand(data: Uint8ClampedArray, w: number, h: number, edge: { top: boolean; bottom: boolean } = { top: true, bottom: true }): { lines: number; letters: number } {
  const n = w * h;
  const grey = new Uint8Array(n);
  for (let p = 0; p < n; p++) grey[p] = (data[p * 4] * 77 + data[p * 4 + 1] * 150 + data[p * 4 + 2] * 29) >> 8;
  // Integral image for the local mean over a (2R+1)² window.
  const iw = w + 1;
  const integral = new Float64Array(iw * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += grey[y * w + x];
      integral[(y + 1) * iw + x + 1] = integral[y * iw + x + 1] + row;
    }
  }
  // 1 = darker than around (dark letters), 2 = lighter than around (light letters).
  const kind = new Uint8Array(n);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - RADIUS);
    const y1 = Math.min(h, y + RADIUS + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - RADIUS);
      const x1 = Math.min(w, x + RADIUS + 1);
      const sum = integral[y1 * iw + x1] - integral[y0 * iw + x1] - integral[y1 * iw + x0] + integral[y0 * iw + x0];
      const mean = sum / ((x1 - x0) * (y1 - y0));
      const g = grey[y * w + x];
      if (g < mean - CONTRAST) kind[y * w + x] = 1;
      else if (g > mean + CONTRAST) kind[y * w + x] = 2;
    }
  }
  // Connected marks of one kind (8-connected).
  const label = new Int32Array(n).fill(-1);
  const marks: Mark[] = [];
  const stack: number[] = [];
  const maxH = Math.max(12, w * 0.12);
  for (let p0 = 0; p0 < n; p0++) {
    const k = kind[p0];
    if (!k || label[p0] >= 0) continue;
    const id = marks.length;
    label[p0] = id;
    stack.push(p0);
    let minX = w, minY = h, maxX = 0, maxY = 0, area = 0;
    while (stack.length) {
      const p = stack.pop()!;
      area++;
      const x = p % w;
      const y = (p - x) / w;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      for (let dy = -1; dy <= 1; dy++) {
        const qy = y + dy;
        if (qy < 0 || qy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const qx = x + dx;
          if (qx < 0 || qx >= w) continue;
          const q = qy * w + qx;
          if (kind[q] === k && label[q] < 0) {
            label[q] = id;
            stack.push(q);
          }
        }
      }
    }
    marks.push({ x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1, area, dark: k === 1, label: id });
  }
  // Letter-sized marks only. A mark cut by the picture's own border is a piece of the art running
  // on past it (speed lines, hatching), not a letter: lettering stands inside the picture.
  const letterLike = marks.filter((m) => {
    const big = Math.max(m.w, m.h);
    if (m.area < 6 || big < 4 || big > maxH) return false;
    if (m.x === 0 || m.x + m.w >= w || (edge.top && m.y === 0) || (edge.bottom && m.y + m.h >= h)) return false;
    if (m.w > m.h * 4 || m.h > m.w * 12) return false;
    const fill = m.area / (m.w * m.h);
    return fill >= 0.08 && fill <= 0.97;
  });
  if (letterLike.length < 3) return { lines: 0, letters: 0 };
  // Neighbours through a coarse grid.
  const cell = 48;
  const gw = Math.ceil(w / cell);
  const grid = new Map<number, number[]>();
  letterLike.forEach((m, i) => {
    const c = Math.floor((m.y + m.h / 2) / cell) * gw + Math.floor((m.x + m.w / 2) / cell);
    let list = grid.get(c);
    if (!list) grid.set(c, (list = []));
    list.push(i);
  });
  const parent = letterLike.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  const near = (a: Mark, b: Mark): boolean => {
    if (a.dark !== b.dark) return false;
    // In a row: centres at about the same height, similar letter heights, a small gap between.
    const hMax = Math.max(a.h, b.h);
    const hMin = Math.min(a.h, b.h);
    const gapX = Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w);
    if (hMax <= hMin * 2.5 && Math.abs(a.y + a.h / 2 - (b.y + b.h / 2)) < hMax * 0.45 && gapX <= hMax * 1.3 && gapX >= -hMax * 0.3) return true;
    // In a column (vertical CJK): centres at about the same x, similar widths, a small gap between.
    const wMax = Math.max(a.w, b.w);
    const wMin = Math.min(a.w, b.w);
    const gapY = Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h);
    return wMax <= wMin * 2.5 && Math.abs(a.x + a.w / 2 - (b.x + b.w / 2)) < wMax * 0.45 && gapY <= wMax * 1.3 && gapY >= -wMax * 0.3;
  };
  const reach = Math.ceil((maxH * 2.5) / cell);
  for (const [c, list] of grid) {
    const cy = Math.floor(c / gw);
    const cx = c % gw;
    for (let dy = 0; dy <= reach; dy++) {
      for (let dx = -reach; dx <= reach; dx++) {
        if (dy === 0 && dx < 0) continue;
        const other = grid.get((cy + dy) * gw + cx + dx);
        if (!other || cx + dx < 0 || cx + dx >= gw) continue;
        for (const i of list) {
          for (const j of other) {
            if (other === list && j <= i) continue;
            if (near(letterLike[i], letterLike[j])) parent[find(i)] = find(j);
          }
        }
      }
    }
  }
  const groups = new Map<number, Mark[]>();
  letterLike.forEach((m, i) => {
    const r = find(i);
    let g = groups.get(r);
    if (!g) groups.set(r, (g = []));
    g.push(m);
  });
  let lines = 0;
  let letters = 0;
  for (const g of groups.values()) {
    if (g.length < 3 || !varied(g) || strokesOnly(g)) continue;
    // On a bubble / caption / plate, or outlined letters straight over the art (sound effects, titles).
    if (!flatAround(g, grey, label, w, h) && !outlinedLine(g, grey, label, w, h)) continue;
    lines++;
    letters += g.length;
  }
  return { lines, letters };
}

/** One row or column of outlined letters (not a whole drawing of enclosed cells). */
function outlinedLine(g: Mark[], grey: Uint8Array, label: Int32Array, w: number, h: number): boolean {
  if (g.length > 30) return false;
  const med = (xs: number[]) => xs.sort((a, b) => a - b)[xs.length >> 1];
  const mh = med(g.map((m) => m.h));
  const mw = med(g.map((m) => m.w));
  const top = Math.min(...g.map((m) => m.y));
  const bottom = Math.max(...g.map((m) => m.y + m.h));
  const left = Math.min(...g.map((m) => m.x));
  const right = Math.max(...g.map((m) => m.x + m.w));
  if (bottom - top > mh * 2.5 && right - left > mw * 2.5) return false;
  return g.filter((m) => outlined(m, grey, label, w, h)).length >= g.length * 0.75;
}

/** Square dilation (Chebyshev radius r) of a local mask, separable. */
function dilate(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const tmp = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r) && !v; k++) v = mask[y * w + k];
      tmp[y * w + x] = v;
    }
  }
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r) && !v; k++) v = tmp[k * w + x];
      out[y * w + x] = v;
    }
  }
  return out;
}

/**
 * A mark with an outline: the pixels right around it (1–2 px) are mostly of the opposite kind and
 * far from its colour (white letters with a black edge over the art, and the other way round), and
 * what lies past the outline (3–6 px) is not the mark's colour again — a white cell between the
 * strokes of a drawing is "outlined" too, but has white all around.
 */
function outlined(m: Mark, grey: Uint8Array, label: Int32Array, w: number, h: number): boolean {
  const pad = 6;
  const x0 = Math.max(0, m.x - pad);
  const y0 = Math.max(0, m.y - pad);
  const lw = Math.min(w, m.x + m.w + pad) - x0;
  const lh = Math.min(h, m.y + m.h + pad) - y0;
  const own = new Uint8Array(lw * lh);
  let inkSum = 0;
  let ink = 0;
  for (let y = 0; y < lh; y++) {
    for (let x = 0; x < lw; x++) {
      const p = (y + y0) * w + x + x0;
      if (label[p] === m.label) {
        own[y * lw + x] = 1;
        inkSum += grey[p];
        ink++;
      }
    }
  }
  if (!ink) return false;
  const mean = inkSum / ink;
  const near = dilate(own, lw, lh, 2);
  const far = dilate(own, lw, lh, pad);
  let ring = 0;
  let edge = 0;
  let outer = 0;
  let same = 0;
  for (let i = 0; i < own.length; i++) {
    if (own[i]) continue;
    const v = grey[(Math.floor(i / lw) + y0) * w + (i % lw) + x0];
    if (near[i]) {
      ring++;
      if (m.dark ? v - mean >= 80 : mean - v >= 80) edge++;
    } else if (far[i]) {
      outer++;
      if (Math.abs(v - mean) < 30) same++;
    }
  }
  return ring >= 8 && edge / ring >= 0.6 && outer >= 8 && same / outer < 0.5;
}

/**
 * Speed lines, rain, a fence cut by a figure: a run of long thin straight strokes. Letters have
 * both height and width (only I, l, 1, ! are bars, and a line is never made of those alone).
 */
function strokesOnly(g: Mark[]): boolean {
  return g.every((m) => Math.max(m.w, m.h) >= Math.min(m.w, m.h) * 3.5);
}

/** Letters differ in shape; screentone dots, hatching and grids are copies of one mark. */
function varied(g: Mark[]): boolean {
  const cv = (xs: number[]) => {
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const v = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length;
    return mean > 0 ? Math.sqrt(v) / mean : 0;
  };
  return cv(g.map((m) => m.area)) >= 0.06 || cv(g.map((m) => m.w / m.h)) >= 0.1;
}

/** Most pixels around the marks (not the marks themselves) are one flat colour, unlike the marks. */
function flatAround(g: Mark[], grey: Uint8Array, label: Int32Array, w: number, h: number): boolean {
  let x0 = w, y0 = h, x1 = 0, y1 = 0;
  const hs = g.map((m) => m.h).sort((a, b) => a - b);
  const pad = Math.max(2, Math.round(hs[hs.length >> 1] * 0.4));
  for (const m of g) {
    x0 = Math.min(x0, m.x);
    y0 = Math.min(y0, m.y);
    x1 = Math.max(x1, m.x + m.w);
    y1 = Math.max(y1, m.y + m.h);
  }
  x0 = Math.max(0, x0 - pad);
  y0 = Math.max(0, y0 - pad);
  x1 = Math.min(w, x1 + pad);
  y1 = Math.min(h, y1 + pad);
  const members = new Set(g.map((m) => m.label));
  const hist = new Uint32Array(256);
  let total = 0;
  let inkSum = 0;
  let ink = 0;
  const step = (x1 - x0) * (y1 - y0) > 40_000 ? 2 : 1;
  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      const p = y * w + x;
      // Skip the marks and the pixel ring right around them (anti-aliased edges).
      if (members.has(label[p])) {
        inkSum += grey[p];
        ink++;
        continue;
      }
      if ((x > 0 && members.has(label[p - 1])) || (x < w - 1 && members.has(label[p + 1])) || (y > 0 && members.has(label[p - w])) || (y < h - 1 && members.has(label[p + w]))) continue;
      hist[grey[p]]++;
      total++;
    }
  }
  if (total < 20) return false;
  // Share of the surroundings within ±24 grey levels of the most common value.
  let peak = 0;
  for (let v = 1; v < 256; v++) if (hist[v] > hist[peak]) peak = v;
  let near = 0;
  for (let v = Math.max(0, peak - 24); v <= Math.min(255, peak + 24); v++) near += hist[v];
  // …and the marks stand out from it (a light halo next to a dark stroke has the background's colour).
  return near / total >= 0.7 && ink > 0 && Math.abs(inkSum / ink - peak) >= 50;
}
