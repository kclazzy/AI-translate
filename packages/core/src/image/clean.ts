import type { Box, BubbleInfo, BubbleRows } from '../types';
import type { PixelData } from './backend';
import { boxArea, clampBox, expandBox, type TiledImage } from './tiled';

type RGB = [number, number, number];

export function luminance(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

function colorDist(d: Uint8ClampedArray, i: number, c: RGB): number {
  const dr = d[i] - c[0];
  const dg = d[i + 1] - c[1];
  const db = d[i + 2] - c[2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

export function toHex(c: RGB): string {
  return '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/** Colour statistics of a band of pixels just outside a rectangle. */
export function ringStats(img: PixelData, inner: Box, bandFrom = 2, bandTo = 7): { color: RGB; std: number; samples: number } {
  const [x, y, w, h] = inner;
  const rs: number[] = [], gs: number[] = [], bs: number[] = [], ls: number[] = [];
  const push = (px: number, py: number) => {
    if (px < 0 || py < 0 || px >= img.width || py >= img.height) return;
    const i = (py * img.width + px) * 4;
    rs.push(img.data[i]);
    gs.push(img.data[i + 1]);
    bs.push(img.data[i + 2]);
    ls.push(luminance(img.data[i], img.data[i + 1], img.data[i + 2]));
  };
  for (let d = bandFrom; d <= bandTo; d++) {
    const step = Math.max(1, Math.floor((w + h) / 120));
    for (let px = x - d; px <= x + w + d; px += step) {
      push(px, y - d);
      push(px, y + h + d);
    }
    for (let py = y - d; py <= y + h + d; py += step) {
      push(x - d, py);
      push(x + w + d, py);
    }
  }
  const color: RGB = [median(rs), median(gs), median(bs)];
  const mean = ls.reduce((a, b) => a + b, 0) / Math.max(1, ls.length);
  const std = Math.sqrt(ls.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, ls.length));
  return { color, std, samples: ls.length };
}

/** Pixels inside `rect` that differ from the background colour by more than `threshold`. */
export function textMask(img: PixelData, rect: Box, bg: RGB, threshold: number): Uint8Array {
  const mask = new Uint8Array(img.width * img.height);
  const [x0, y0, w, h] = clampBox(rect, img.width, img.height);
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const p = y * img.width + x;
      if (colorDist(img.data, p * 4, bg) > threshold) mask[p] = 1;
    }
  }
  return mask;
}

export function dilate(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  if (radius <= 0) return mask;
  // Separable box dilation: horizontal then vertical.
  const tmp = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) {
    let run = -1;
    for (let x = 0; x < width; x++) if (mask[y * width + x]) run = x;
    // forward/backward passes
    let last = -Infinity;
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x]) last = x;
      if (x - last <= radius) tmp[y * width + x] = 1;
    }
    last = Infinity;
    for (let x = width - 1; x >= 0; x--) {
      if (mask[y * width + x]) last = x;
      if (last - x <= radius) tmp[y * width + x] = 1;
    }
    void run;
  }
  const out = new Uint8Array(mask.length);
  for (let x = 0; x < width; x++) {
    let last = -Infinity;
    for (let y = 0; y < height; y++) {
      if (tmp[y * width + x]) last = y;
      if (y - last <= radius) out[y * width + x] = 1;
    }
    last = Infinity;
    for (let y = height - 1; y >= 0; y--) {
      if (tmp[y * width + x]) last = y;
      if (last - y <= radius) out[y * width + x] = 1;
    }
  }
  return out;
}

export function countMask(mask: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < mask.length; i++) n += mask[i];
  return n;
}

/**
 * Lettering that falls into groups with a wide empty band between them (more than two letter
 * heights): two speeches inside one shape. Returns each group's box, or null for one group.
 */
export function letterGroups(mask: Uint8Array, width: number, height: number, letterHeight?: number): Box[] | null {
  const b = maskBounds(mask, width, height);
  if (!b || !letterHeight || letterHeight < 4) return null;
  const rows: boolean[] = [];
  for (let y = b[1]; y < b[1] + b[3]; y++) {
    let any = false;
    for (let x = b[0]; x < b[0] + b[2] && !any; x++) if (mask[y * width + x]) any = true;
    rows.push(any);
  }
  const minGap = letterHeight * 2.2;
  const bands: [number, number][] = [];
  let start = -1;
  let lastInk = -1;
  for (let i = 0; i < rows.length; i++) {
    if (!rows[i]) continue;
    if (start < 0) start = i;
    else if (i - lastInk - 1 > minGap) {
      bands.push([start, lastInk]);
      start = i;
    }
    lastInk = i;
  }
  if (start >= 0) bands.push([start, lastInk]);
  if (bands.length < 2) return null;
  const out: Box[] = [];
  for (const [a, z] of bands) {
    let minX = width, maxX = -1;
    for (let y = b[1] + a; y <= b[1] + z; y++) for (let x = b[0]; x < b[0] + b[2]; x++) if (mask[y * width + x]) { if (x < minX) minX = x; if (x > maxX) maxX = x; }
    // A stray mark is not a speech.
    if (z - a + 1 >= letterHeight * 0.8 && maxX - minX >= letterHeight * 2) out.push([minX, b[1] + a, maxX - minX + 1, z - a + 1]);
  }
  return out.length >= 2 ? out : null;
}

export function maskBounds(mask: Uint8Array, width: number, height: number): Box | null {
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x]) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return maxX < 0 ? null : [minX, minY, maxX - minX + 1, maxY - minY + 1];
}

export function fillMask(img: PixelData, mask: Uint8Array, color: RGB): void {
  for (let p = 0; p < mask.length; p++) {
    if (!mask[p]) continue;
    const i = p * 4;
    img.data[i] = color[0];
    img.data[i + 1] = color[1];
    img.data[i + 2] = color[2];
    img.data[i + 3] = 255;
  }
}

/**
 * Simple diffusion inpainting for textured backgrounds: masked pixels are
 * repeatedly replaced by the average of their neighbours. The engine offers
 * OpenCV / LaMa for higher quality.
 */
export function diffuseInpaint(img: PixelData, mask: Uint8Array, iterations = 60): void {
  const { width, height, data } = img;
  const idx: number[] = [];
  for (let p = 0; p < mask.length; p++) if (mask[p]) idx.push(p);
  if (!idx.length) return;
  // Start from the nearest unmasked pixels in all four directions, weighted by distance
  // (row-only starts leave horizontal streaks on large areas).
  const left = new Int32Array(width * height).fill(-1);
  const right = new Int32Array(width * height).fill(-1);
  const up = new Int32Array(width * height).fill(-1);
  const down = new Int32Array(width * height).fill(-1);
  for (let y = 0; y < height; y++) {
    let last = -1;
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      if (!mask[p]) last = p;
      else left[p] = last;
    }
    last = -1;
    for (let x = width - 1; x >= 0; x--) {
      const p = y * width + x;
      if (!mask[p]) last = p;
      else right[p] = last;
    }
  }
  for (let x = 0; x < width; x++) {
    let last = -1;
    for (let y = 0; y < height; y++) {
      const p = y * width + x;
      if (!mask[p]) last = p;
      else up[p] = last;
    }
    last = -1;
    for (let y = height - 1; y >= 0; y--) {
      const p = y * width + x;
      if (!mask[p]) last = p;
      else down[p] = last;
    }
  }
  for (const p of idx) {
    let sr = 0, sg = 0, sb = 0, sw = 0;
    const x = p % width;
    const y = (p - x) / width;
    for (const q of [left[p], right[p], up[p], down[p]]) {
      if (q < 0) continue;
      const qx = q % width;
      const qy = (q - qx) / width;
      const wgt = 1 / (Math.abs(qx - x) + Math.abs(qy - y));
      sr += data[q * 4] * wgt;
      sg += data[q * 4 + 1] * wgt;
      sb += data[q * 4 + 2] * wgt;
      sw += wgt;
    }
    if (sw) {
      data[p * 4] = sr / sw;
      data[p * 4 + 1] = sg / sw;
      data[p * 4 + 2] = sb / sw;
      data[p * 4 + 3] = 255;
    }
  }
  for (let it = 0; it < iterations; it++) {
    for (const p of idx) {
      const x = p % width;
      const y = (p - x) / width;
      let sr = 0, sg = 0, sb = 0, n = 0;
      const add = (q: number) => {
        sr += data[q * 4];
        sg += data[q * 4 + 1];
        sb += data[q * 4 + 2];
        n++;
      };
      if (x > 0) add(p - 1);
      if (x < width - 1) add(p + 1);
      if (y > 0) add(p - width);
      if (y < height - 1) add(p + width);
      if (n) {
        data[p * 4] = sr / n;
        data[p * 4 + 1] = sg / n;
        data[p * 4 + 2] = sb / n;
        data[p * 4 + 3] = 255;
      }
    }
  }
}

export interface FloodResult {
  mask: Uint8Array;
  area: number;
  box: Box;
  touchesEdge: boolean;
}

/**
 * Flood the bubble interior: start from background-coloured pixels inside the
 * text box (text pixels count as passable) and spread through pixels close
 * to the bubble colour. The dark outline stops it.
 */
export function floodBubble(img: PixelData, seed: Box, bg: RGB, tol: number, passable?: Uint8Array): FloodResult {
  const { width, height, data } = img;
  const mask = new Uint8Array(width * height);
  const stack: number[] = [];
  const [sx, sy, sw, sh] = clampBox(seed, width, height);
  for (let y = sy; y < sy + sh; y++) {
    for (let x = sx; x < sx + sw; x++) {
      const p = y * width + x;
      if (colorDist(data, p * 4, bg) <= tol || passable?.[p]) {
        mask[p] = 1;
        stack.push(p);
      }
    }
  }
  let area = stack.length;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  let touchesEdge = false;
  while (stack.length) {
    const p = stack.pop()!;
    const x = p % width;
    const y = (p - x) / width;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (x === 0 || y === 0 || x === width - 1 || y === height - 1) touchesEdge = true;
    const visit = (q: number) => {
      if (mask[q]) return;
      if (colorDist(data, q * 4, bg) <= tol || passable?.[q]) {
        mask[q] = 1;
        area++;
        stack.push(q);
      }
    };
    if (x > 0) visit(p - 1);
    if (x < width - 1) visit(p + 1);
    if (y > 0) visit(p - width);
    if (y < height - 1) visit(p + width);
  }
  return { mask, area, box: maxX < 0 ? [0, 0, 0, 0] : [minX, minY, maxX - minX + 1, maxY - minY + 1], touchesEdge };
}

/** Pixels not in `region` that are fully enclosed by it (the glyphs inside a bubble). */
export function enclosedHoles(region: Uint8Array, width: number, height: number, within: Box): Uint8Array {
  const [bx, by, bw, bh] = within;
  const outside = new Uint8Array(width * height);
  const stack: number[] = [];
  const seed = (x: number, y: number) => {
    const p = y * width + x;
    if (!region[p] && !outside[p]) {
      outside[p] = 1;
      stack.push(p);
    }
  };
  for (let x = bx; x < bx + bw; x++) {
    seed(x, by);
    seed(x, by + bh - 1);
  }
  for (let y = by; y < by + bh; y++) {
    seed(bx, y);
    seed(bx + bw - 1, y);
  }
  while (stack.length) {
    const p = stack.pop()!;
    const x = p % width;
    const y = (p - x) / width;
    const visit = (q: number, qx: number, qy: number) => {
      if (qx < bx || qy < by || qx >= bx + bw || qy >= by + bh) return;
      if (!region[q] && !outside[q]) {
        outside[q] = 1;
        stack.push(q);
      }
    };
    visit(p - 1, x - 1, y);
    visit(p + 1, x + 1, y);
    visit(p - width, x, y - 1);
    visit(p + width, x, y + 1);
  }
  const holes = new Uint8Array(width * height);
  for (let y = by; y < by + bh; y++) {
    for (let x = bx; x < bx + bw; x++) {
      const p = y * width + x;
      if (!region[p] && !outside[p]) holes[p] = 1;
    }
  }
  return holes;
}

export interface CleanResult {
  bubble: BubbleInfo | null;
  /** Tight box around the text pixels that were found. */
  textBox: Box | null;
  method: 'fill' | 'diffuse' | 'plate' | 'none';
  /** The bubble outline closes around the text (several blocks in it share one bubble). */
  closed: boolean;
  /** How the original lettering looks, so the translation can match it. */
  lettering?: Lettering;
  /** Text over artwork that was smudged away (page coordinates and a mask of that box). */
  artMask?: { box: Box; mask: Uint8Array };
  /** Lettering in separate groups far apart (two speeches in joined bubbles), top to bottom. */
  textGroups?: Box[];
}

export interface Lettering {
  /** Fill colour of the letters. */
  color: string;
  /** Average stroke thickness, px. */
  stroke: number;
  /** Median letter height, px. */
  letterHeight: number;
  /** Share of letter pixels close to `color` (low for outlined lettering: fill + outline). */
  colorShare: number;
  /** Outlined lettering: fill colour inside the strokes and the outline colour around them. */
  fill?: string;
  outline?: string;
  /** How the lines are aligned (needs at least two lines). */
  align?: 'left' | 'center' | 'right';
}

export interface CleanOptions {
  /** Only analyse (find bubble/safe area) without erasing. */
  analyzeOnly?: boolean;
  /** Sound effect over artwork: erase only clear letter pixels, never smear a whole box. */
  sfx?: boolean;
  /** How far past the letters to erase, px (default 3 over artwork, 2 in bubbles). */
  expand?: number;
}

/** Colour, stroke thickness and letter height of the lettering in `mask` (before erasing). */
export function measureLettering(img: PixelData, mask: Uint8Array, rect: Box, bg?: RGB): Lettering | undefined {
  const [x0, y0, w, h] = clampBox(rect, img.width, img.height);
  let area = 0;
  let edges = 0;
  const rs: number[] = [], gs: number[] = [], bs: number[] = [];
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const p = y * img.width + x;
      if (!mask[p]) continue;
      area++;
      if (!mask[p - 1] || !mask[p + 1] || !mask[p - img.width] || !mask[p + img.width]) edges++;
      if (area % 3 === 0) {
        rs.push(img.data[p * 4]);
        gs.push(img.data[p * 4 + 1]);
        bs.push(img.data[p * 4 + 2]);
      }
    }
  }
  if (area < 30 || !edges) return undefined;
  const comps = components(mask, img.width, [x0, y0, w, h]).filter((c) => c.pixels.length >= 8);
  const heights = comps.map((c) => c.box[3]).sort((a, b) => a - b);
  const letterHeight = heights.length ? heights[Math.floor(heights.length / 2)] : 0;
  // A stroke of width s has about 2 edge pixels per s pixels of area.
  const stroke = (2 * area) / edges;
  // Main ink colour: the most common colour among letter pixels (outlined lettering has two).
  const bins = new Map<number, { n: number; r: number; g: number; b: number }>();
  for (let i = 0; i < rs.length; i++) {
    const k = ((rs[i] >> 5) << 6) | ((gs[i] >> 5) << 3) | (bs[i] >> 5);
    const e = bins.get(k) ?? { n: 0, r: 0, g: 0, b: 0 };
    e.n++;
    e.r += rs[i];
    e.g += gs[i];
    e.b += bs[i];
    bins.set(k, e);
  }
  let best = { n: 0, r: 0, g: 0, b: 0 };
  for (const e of bins.values()) if (e.n > best.n) best = e;
  const ink: RGB = best.n ? [best.r / best.n, best.g / best.n, best.b / best.n] : [median(rs), median(gs), median(bs)];
  let close = 0;
  for (let i = 0; i < rs.length; i++) if (Math.hypot(rs[i] - ink[0], gs[i] - ink[1], bs[i] - ink[2]) < 60) close++;
  const out: Lettering = { color: toHex(ink), stroke, letterHeight, colorShare: close / Math.max(1, rs.length) };
  // Outlined lettering: the edge of the strokes has another colour than their middle.
  {
    let er = 0, eg = 0, eb = 0, en = 0;
    const deepBins = new Map<number, { n: number; r: number; g: number; b: number }>();
    let inn = 0;
    for (let y = y0 + 1; y < y0 + h - 1; y++) {
      for (let x = x0 + 1; x < x0 + w - 1; x++) {
        const p = y * img.width + x;
        if (!mask[p]) continue;
        const edge = !mask[p - 1] || !mask[p + 1] || !mask[p - img.width] || !mask[p + img.width];
        const deep = !edge && mask[p - 2] && mask[p + 2] && mask[p - 2 * img.width] && mask[p + 2 * img.width];
        if (edge) (er += img.data[p * 4]), (eg += img.data[p * 4 + 1]), (eb += img.data[p * 4 + 2]), en++;
        else if (deep) {
          const [r0, g0, b0] = [img.data[p * 4], img.data[p * 4 + 1], img.data[p * 4 + 2]];
          const k = ((r0 >> 5) << 6) | ((g0 >> 5) << 3) | (b0 >> 5);
          const e = deepBins.get(k) ?? { n: 0, r: 0, g: 0, b: 0 };
          e.n++;
          e.r += r0;
          e.g += g0;
          e.b += b0;
          deepBins.set(k, e);
          inn++;
        }
      }
    }
    if (en > 30 && inn > 30) {
      const e: RGB = [er / en, eg / en, eb / en];
      // The fill: the most common colour in the middle of the strokes (anti-aliasing excluded).
      let top = { n: 0, r: 0, g: 0, b: 0 };
      for (const v of deepBins.values()) if (v.n > top.n) top = v;
      const i: RGB = [top.r / top.n, top.g / top.n, top.b / top.n];
      // Anti-aliased edges are a blend of the fill and the background, not an outline.
      const blend = (() => {
        if (!bg) return false;
        const d = [bg[0] - i[0], bg[1] - i[1], bg[2] - i[2]];
        const len2 = d[0] ** 2 + d[1] ** 2 + d[2] ** 2 || 1;
        const t = Math.max(0, Math.min(1, ((e[0] - i[0]) * d[0] + (e[1] - i[1]) * d[1] + (e[2] - i[2]) * d[2]) / len2));
        return Math.hypot(e[0] - (i[0] + d[0] * t), e[1] - (i[1] + d[1] * t), e[2] - (i[2] + d[2] * t)) < 45;
      })();
      if (!blend && Math.hypot(e[0] - i[0], e[1] - i[1], e[2] - i[2]) > 120) {
        out.fill = toHex(i);
        out.outline = toHex(e);
      }
    }
  }
  // Alignment: lines whose left edges line up (and right edges do not) are left-aligned, etc.
  {
    const rows: Box[] = [];
    const letterComps = comps.filter((c) => c.box[3] <= letterHeight * 1.8 && c.box[2] <= letterHeight * 4);
    for (const c of letterComps.sort((a, b) => a.box[1] - b.box[1])) {
      const row = rows.find((r) => c.box[1] < r[1] + r[3] * 0.7 && c.box[1] + c.box[3] > r[1] + r[3] * 0.3);
      if (row) {
        const x = Math.min(row[0], c.box[0]);
        const y = Math.min(row[1], c.box[1]);
        row[2] = Math.max(row[0] + row[2], c.box[0] + c.box[2]) - x;
        row[3] = Math.max(row[1] + row[3], c.box[1] + c.box[3]) - y;
        row[0] = x;
        row[1] = y;
      } else rows.push([...c.box] as Box);
    }
    const lines = rows.filter((r) => r[3] >= letterHeight * 0.6);
    if (lines.length >= 2) {
      const spread = (v: number[]) => Math.max(...v) - Math.min(...v);
      const lefts = spread(lines.map((r) => r[0]));
      const rights = spread(lines.map((r) => r[0] + r[2]));
      const centres = spread(lines.map((r) => r[0] + r[2] / 2));
      const tol = Math.max(4, letterHeight * 0.35);
      // Lines of almost equal length say nothing about alignment: only clearly ragged edges count.
      const ragged = letterHeight * 1.2;
      if (lefts <= tol && rights >= ragged && centres > letterHeight * 0.6) out.align = 'left';
      else if (rights <= tol && lefts >= ragged && centres > letterHeight * 0.6) out.align = 'right';
      else out.align = 'center';
    }
  }
  return out;
}

/** Most common colour in a rectangle (coarse histogram) and the share of pixels close to it. */
export function dominantColor(img: PixelData, rect: Box, tol = 40): { color: RGB; share: number } {
  const [x0, y0, w, h] = clampBox(rect, img.width, img.height);
  const bins = new Map<number, { n: number; r: number; g: number; b: number }>();
  const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 40000)));
  for (let y = y0; y < y0 + h; y += step) {
    for (let x = x0; x < x0 + w; x += step) {
      const i = (y * img.width + x) * 4;
      const k = ((img.data[i] >> 5) << 6) | ((img.data[i + 1] >> 5) << 3) | (img.data[i + 2] >> 5);
      const e = bins.get(k) ?? { n: 0, r: 0, g: 0, b: 0 };
      e.n++;
      e.r += img.data[i];
      e.g += img.data[i + 1];
      e.b += img.data[i + 2];
      bins.set(k, e);
    }
  }
  let best: { n: number; r: number; g: number; b: number } | null = null;
  for (const e of bins.values()) if (!best || e.n > best.n) best = e;
  if (!best) return { color: [255, 255, 255], share: 0 };
  const color: RGB = [best.r / best.n, best.g / best.n, best.b / best.n];
  let near = 0;
  let total = 0;
  for (let y = y0; y < y0 + h; y += step) {
    for (let x = x0; x < x0 + w; x += step) {
      total++;
      if (colorDist(img.data, (y * img.width + x) * 4, color) <= tol) near++;
    }
  }
  return { color, share: near / Math.max(1, total) };
}

interface Component {
  box: Box;
  pixels: number[];
}

/** 8-connected components of a mask inside `rect`. */
export function components(mask: Uint8Array, width: number, rect: Box): Component[] {
  const [x0, y0, w, h] = rect;
  const seen = new Uint8Array(mask.length);
  const out: Component[] = [];
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const p0 = y * width + x;
      if (!mask[p0] || seen[p0]) continue;
      const pixels: number[] = [];
      const stack = [p0];
      seen[p0] = 1;
      let minX = x, maxX = x, minY = y, maxY = y;
      while (stack.length) {
        const p = stack.pop()!;
        pixels.push(p);
        const px = p % width;
        const py = (p - px) / width;
        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
        if (py < minY) minY = py;
        if (py > maxY) maxY = py;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const qx = px + dx;
            const qy = py + dy;
            if (qx < x0 || qy < y0 || qx >= x0 + w || qy >= y0 + h) continue;
            const q = qy * width + qx;
            if (mask[q] && !seen[q]) {
              seen[q] = 1;
              stack.push(q);
            }
          }
        }
      }
      out.push({ box: [minX, minY, maxX - minX + 1, maxY - minY + 1], pixels });
    }
  }
  return out;
}

function boxGap(a: Box, b: Box): number {
  const dx = Math.max(0, Math.max(a[0], b[0]) - Math.min(a[0] + a[2], b[0] + b[2]));
  const dy = Math.max(0, Math.max(a[1], b[1]) - Math.min(a[1] + a[3], b[1] + b[3]));
  return Math.max(dx, dy);
}

function unionBox(a: Box | null, b: Box): Box {
  if (!a) return b;
  const x = Math.min(a[0], b[0]);
  const y = Math.min(a[1], b[1]);
  return [x, y, Math.max(a[0] + a[2], b[0] + b[2]) - x, Math.max(a[1] + a[3], b[1] + b[3]) - y];
}

/**
 * The model's box is approximate. Starting from the letters that touch it, collect the
 * neighbouring letter-sized components (the rest of a word, a missed line) so the whole
 * lettering is erased, and nothing that looks like artwork.
 */
export function snapToLettering(candidates: Uint8Array, width: number, search: Box, seed: Box, img?: PixelData): { mask: Uint8Array; box: Box | null } {
  const comps = components(candidates, width, search).filter((c) => c.pixels.length >= 3);
  const seedBox = expandBox(seed, 2);
  const kept = new Set<Component>();
  let union: Box | null = null;
  const touching = comps.filter((c) => boxGap(c.box, seedBox) === 0 && c.box[2] <= seed[2] * 2.5 + 40 && c.box[3] <= seed[3] * 2.5 + 40);
  // Lettering is one colour (per stroke type); artwork inside a loose box (bokeh, stars,
  // highlights) usually is not. Keep components close in colour to the biggest letters.
  const meanColor = (c: Component): RGB => {
    let r = 0, g = 0, b = 0;
    const step = Math.max(1, Math.floor(c.pixels.length / 200));
    let n = 0;
    for (let i = 0; i < c.pixels.length; i += step) {
      const q = c.pixels[i] * 4;
      r += img!.data[q];
      g += img!.data[q + 1];
      b += img!.data[q + 2];
      n++;
    }
    return [r / n, g / n, b / n];
  };
  let ref: RGB | null = null;
  if (img && touching.length > 1) {
    const biggest = [...touching].sort((a, b) => b.pixels.length - a.pixels.length)[0];
    ref = meanColor(biggest);
  }
  const sameInk = (c: Component) => {
    if (!ref) return true;
    const m = meanColor(c);
    return Math.hypot(m[0] - ref[0], m[1] - ref[1], m[2] - ref[2]) < 90;
  };
  for (const c of touching) {
    if (!sameInk(c)) continue;
    kept.add(c);
    union = unionBox(union, c.box);
  }
  if (!union) return { mask: new Uint8Array(candidates.length), box: null };
  const heights = [...kept].map((c) => c.box[3]).sort((a, b) => a - b);
  const letter = Math.max(6, heights[Math.floor(heights.length / 2)]);
  const gap = Math.max(5, Math.round(letter * 0.75));
  for (let grew = true; grew; ) {
    grew = false;
    for (const c of comps) {
      if (kept.has(c)) continue;
      // Letter-sized and next to the lettering found so far.
      if (c.box[3] > letter * 2.6 || c.box[2] > Math.max(letter * 6, seed[2] * 1.5)) continue;
      if (boxGap(c.box, union!) > gap) continue;
      if (!sameInk(c)) continue;
      kept.add(c);
      union = unionBox(union, c.box);
      grew = true;
    }
  }
  const mask = new Uint8Array(candidates.length);
  for (const c of kept) for (const p of c.pixels) mask[p] = 1;
  return { mask, box: union };
}

/**
 * Drop candidate components that are not surrounded by the background flood: a letter's
 * pixels are all within a few pixels of the bubble colour, artwork beyond an outline is not.
 */
export function onBackground(cand: Uint8Array, width: number, height: number, rect: Box, floodMask: Uint8Array, reach = 5): Uint8Array {
  const near = dilate(floodMask, width, height, reach);
  const out = new Uint8Array(cand.length);
  for (const c of components(cand, width, rect)) {
    let n = 0;
    for (const p of c.pixels) if (near[p]) n++;
    if (n >= c.pixels.length * 0.85) for (const p of c.pixels) out[p] = 1;
  }
  return out;
}

/** Pixels still standing out from `bg` inside `rect` (what the reader could still see). */
function residual(img: PixelData, rect: Box, bg: RGB, threshold: number): number {
  const m = textMask(img, rect, bg, threshold);
  return countMask(m) / Math.max(1, rect[2] * rect[3]);
}

/** Solid rounded plate in the background colour: the last resort that always hides the lettering. */
function paintPlate(img: PixelData, rect: Box, color: RGB, limit?: Uint8Array): void {
  const [x0, y0, w, h] = clampBox(rect, img.width, img.height);
  const r = Math.min(10, Math.floor(Math.min(w, h) / 3));
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const cx = x < x0 + r ? x0 + r : x >= x0 + w - r ? x0 + w - r - 1 : x;
      const cy = y < y0 + r ? y0 + r : y >= y0 + h - r ? y0 + h - r - 1 : y;
      if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) continue;
      const p = y * img.width + x;
      if (limit && !limit[p]) continue;
      const i = p * 4;
      img.data[i] = color[0];
      img.data[i + 1] = color[1];
      img.data[i + 2] = color[2];
      img.data[i + 3] = 255;
    }
  }
}

/**
 * Remove the original text of one block from a tiled image and describe the
 * bubble the translation should go into. Works with imprecise boxes from small
 * vision models: it finds the real lettering around the box, erases it, checks
 * that nothing is left and, if something is, covers it with a solid plate.
 */
export function cleanBlock(image: TiledImage, bbox: Box, opts: CleanOptions = {}): CleanResult {
  const maxDim = Math.max(bbox[2], bbox[3]);
  const minDim = Math.max(8, Math.min(bbox[2], bbox[3]));
  // Bubbles are often much larger than their text: grow the analysed region until the
  // bubble closes (open page background never closes and ends as open lettering).
  const pads = [Math.max(40, 0.9 * maxDim), Math.max(70, 1.8 * maxDim), Math.max(110, 3 * maxDim)].map(Math.round);
  let region: Box = bbox;
  let img!: PixelData;
  let local: Box = bbox;
  let bg: RGB = [255, 255, 255];
  let flat = false;
  let flood: FloodResult | null = null;
  let leaked = true;
  for (let attempt = 0; attempt < pads.length; attempt++) {
    region = clampBox(expandBox(bbox, pads[attempt]), image.width, image.height);
    img = image.getRegion(...region);
    local = [bbox[0] - region[0], bbox[1] - region[1], bbox[2], bbox[3]];
    if (attempt === 0) {
      // Background = the dominant colour around and inside the box (letters are a minority).
      const around = clampBox(expandBox(local, Math.round(minDim * 0.6) + 6), img.width, img.height);
      const dom = dominantColor(img, around);
      bg = dom.color;
      flat = dom.share >= 0.45;
      if (!flat) break;
    }
    const letters = textMask(img, clampBox(expandBox(local, 4), img.width, img.height), bg, 60);
    flood = floodBubble(img, clampBox(expandBox(local, 2), img.width, img.height), bg, 42, letters);
    // Touching the analysed region's border means the flood ran out into open space;
    // touching the picture's own border is fine (a bubble cut off by the edge of the strip).
    leaked = floodLeaks(flood, region, image.width, image.height);
    if (!leaked) break;
  }

  const search = clampBox(expandBox(local, Math.round(minDim * 1.2) + 12), img.width, img.height);
  let result: CleanResult;

  if (flat) {
    // A bubble is a closed shape not much bigger than its text. Flooding the whole scene (a dark
    // night sky with the text on it) is open background, not a bubble — otherwise everything
    // inside it (stars, bokeh, other lettering) would count as text to erase.
    const floodArea = flood ? boxArea(flood.box) : 0;
    const closed =
      !!flood && !leaked && !opts.sfx && flood.area > boxArea(local) * 0.5 && floodArea <= Math.max(boxArea(local) * 30, 40_000) && floodArea < image.width * image.height * 0.35;
    let mask: Uint8Array;
    let tb: Box | null;
    let letterMask: Uint8Array;
    if (closed) {
      // Everything enclosed by the bubble interior is lettering.
      const holes = enclosedHoles(flood!.mask, img.width, img.height, clampBox(expandBox(flood!.box, 1), img.width, img.height));
      mask = holes.slice();
      const extra = textMask(img, clampBox(expandBox(local, 3), img.width, img.height), bg, 60);
      const interior = dilate(flood!.mask, img.width, img.height, 1);
      for (let i = 0; i < mask.length; i++) if (extra[i] && interior[i]) mask[i] = 1;
      tb = maskBounds(mask, img.width, img.height);
      letterMask = mask.slice();
      mask = dilate(mask, img.width, img.height, 2);
      // Never paint outside the bubble interior (keeps the outline intact).
      for (let i = 0; i < mask.length; i++) if (mask[i] && !interior[i] && !holes[i]) mask[i] = 0;
    } else {
      // Open flat space (white gutter, narration box): erase the letters around the box.
      // Letters sit in the bubble's white: keep only components lying (almost) entirely next to
      // the flooded background. Panel art behind an outline, or past where a bubble breaks out of
      // its panel into the gutter, is not lettering even if it is letter-sized and nearby.
      const cand = flood ? onBackground(textMask(img, search, bg, 60), img.width, img.height, search, flood.mask) : textMask(img, search, bg, 60);
      const snap = snapToLettering(cand, img.width, search, local, img);
      tb = snap.box;
      letterMask = snap.mask;
      mask = dilate(snap.mask, img.width, img.height, Math.max(1, (opts.expand ?? 3) - 1));
    }
    const lettering = measureLettering(img, letterMask, closed ? flood!.box : search, bg);
    if (!opts.analyzeOnly) fillMask(img, mask, bg);
    let method: CleanResult['method'] = opts.analyzeOnly ? 'none' : 'fill';
    // Verify: nothing that stands out from the bubble colour may remain where the text was.
    const textArea = clampBox(expandBox(tb ? unionBox(tb, local) : local, 2), img.width, img.height);
    if (!opts.analyzeOnly && residual(img, textArea, bg, 70) > 0.004) {
      // The plate only covers the bubble's own background and the letters, never the art or the
      // outline next to it (a rectangle would spill over the panel where the bubble is round).
      let limit: Uint8Array | undefined;
      if (closed) limit = dilate(flood!.mask, img.width, img.height, 1);
      else if (flood) {
        limit = dilate(flood.mask, img.width, img.height, 1);
        const near = dilate(letterMask, img.width, img.height, 3);
        for (let i = 0; i < limit.length; i++) if (near[i]) limit[i] = 1;
      }
      paintPlate(img, clampBox(expandBox(textArea, 3), img.width, img.height), bg, limit);
      method = 'plate';
    }
    const textBox: Box | null = tb ? [tb[0] + region[0], tb[1] + region[1], tb[2], tb[3]] : null;
    let bubble: BubbleInfo;
    if (closed) {
      const bb: Box = [flood!.box[0] + region[0], flood!.box[1] + region[1], flood!.box[2], flood!.box[3]];
      const fillRatio = flood!.area / Math.max(1, boxArea(flood!.box));
      // Cut off by the edge of the picture: only part of the bubble is visible, so fit the
      // text into that part as a box instead of shrinking it into a whole ellipse.
      const cut = bb[0] <= 0 || bb[1] <= 0 || bb[0] + bb[2] >= image.width || bb[1] + bb[3] >= image.height;
      const shape = !cut && fillRatio < 0.86 ? 'ellipse' : 'rect';
      const insetX = cut ? 0.1 : shape === 'ellipse' ? 0.1 : 0.06;
      const insetY = cut ? 0.2 : insetX;
      const safe: Box = [bb[0] + bb[2] * insetX, bb[1] + bb[3] * insetY, bb[2] * (1 - 2 * insetX), bb[3] * (1 - 2 * insetY)];
      // A bubble cut by the picture edge: keep the text inside the visible part.
      bubble = { box: bb, fill: toHex(bg), safeArea: clampBox(safe.map(Math.round) as Box, image.width, image.height), shape };
      // The real inside, row by row, so the translation follows any outline (spiky, cloud, wavy).
      const holes = enclosedHoles(flood!.mask, img.width, img.height, clampBox(expandBox(flood!.box, 1), img.width, img.height));
      const cx = Math.round(tb ? tb[0] + tb[2] / 2 : local[0] + local[2] / 2);
      bubble.rows = bubbleRows(flood!.mask, holes, img.width, flood!.box, cx, region);
    } else {
      const base = textBox ? unionBox(textBox, bbox) : bbox;
      bubble = { box: base, fill: toHex(bg), safeArea: clampBox(expandBox(base, Math.round(base[2] * 0.08), Math.round(base[3] * 0.08)).map(Math.round) as Box, image.width, image.height), shape: 'rect' };
    }
    const groups = letterGroups(letterMask, img.width, img.height, lettering?.letterHeight);
    result = { bubble, textBox, method, closed, lettering, ...(groups ? { textGroups: groups.map((g) => [g[0] + region[0], g[1] + region[1], g[2], g[3]] as Box) } : {}) };
  } else {
    // Text over artwork: letters are the extreme pixels (white/black fill and outline).
    const bgLum = luminance(...bg);
    const cand = new Uint8Array(img.width * img.height);
    for (let y = search[1]; y < search[1] + search[3]; y++) {
      for (let x = search[0]; x < search[0] + search[2]; x++) {
        const p = y * img.width + x;
        const l = luminance(img.data[p * 4], img.data[p * 4 + 1], img.data[p * 4 + 2]);
        // Extreme pixels count as letters only against a background that is not itself extreme
        // (a night scene is full of near-black pixels).
        if ((l > 232 && bgLum < 200) || (l < 28 && bgLum > 60) || colorDist(img.data, p * 4, bg) > 120) cand[p] = 1;
      }
    }
    const snap = snapToLettering(cand, img.width, search, local, img);
    let mask = snap.mask;
    const tb = snap.box;
    const inner = clampBox(expandBox(local, 2), img.width, img.height);
    const lettering = measureLettering(img, mask, search, bg);
    // No clear letters found: smear the box only if it is small. A big box (a sound effect drawn
    // into the art, an imprecise model box) would turn a large part of the picture into a blur.
    const small = inner[2] * inner[3] <= 45_000;
    if (countMask(mask) < inner[2] * inner[3] * 0.03) {
      mask = new Uint8Array(img.width * img.height);
      if (small && !opts.sfx) for (let y = inner[1]; y < inner[1] + inner[3]; y++) for (let x = inner[0]; x < inner[0] + inner[2]; x++) mask[y * img.width + x] = 1;
    }
    // Outlined lettering has a halo: take a little more around the strokes.
    mask = dilate(mask, img.width, img.height, opts.expand ?? 3);
    let method: CleanResult['method'] = opts.analyzeOnly ? 'none' : 'diffuse';
    const textArea = clampBox(expandBox(tb ? unionBox(tb, local) : local, 2), img.width, img.height);
    if (!opts.analyzeOnly) {
      diffuseInpaint(img, mask, 80);
      // Still readable (thick letters, busy art)? Cover the lettering with a plate.
      let left = 0;
      for (let y = textArea[1]; y < textArea[1] + textArea[3]; y++) {
        for (let x = textArea[0]; x < textArea[0] + textArea[2]; x++) {
          const p = y * img.width + x;
          const l = luminance(img.data[p * 4], img.data[p * 4 + 1], img.data[p * 4 + 2]);
          if ((l > 232 && bgLum < 200) || (l < 28 && bgLum > 60)) left++;
        }
      }
      const tight = tb ? boxArea(textArea) <= boxArea(tb) * 1.6 + 400 : false;
      if (left / Math.max(1, textArea[2] * textArea[3]) > 0.01 && !opts.sfx && tight && boxArea(textArea) <= 60_000) {
        paintPlate(img, clampBox(expandBox(textArea, 4), img.width, img.height), bg);
        method = 'plate';
      }
    }
    const textBox: Box | null = tb ? [tb[0] + region[0], tb[1] + region[1], tb[2], tb[3]] : null;
    // Where letters over artwork were smudged away: a better inpainter (LaMa) can redo this part.
    let artMask: CleanResult['artMask'];
    if (method === 'diffuse' && countMask(mask)) {
      let x0 = img.width, y0 = img.height, x1 = -1, y1 = -1;
      for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) if (mask[y * img.width + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      const w = x1 - x0 + 1;
      const h = y1 - y0 + 1;
      const m = new Uint8Array(w * h);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) m[y * w + x] = mask[(y + y0) * img.width + x + x0];
      artMask = { box: [x0 + region[0], y0 + region[1], w, h], mask: m };
    }
    result = {
      artMask,
      closed: false,
      lettering,
      bubble: method === 'plate' ? { box: unionBox(textBox, bbox), fill: toHex(bg), safeArea: unionBox(textBox, bbox), shape: 'rect' } : null,
      textBox,
      method,
    };
  }

  if (!opts.analyzeOnly) image.putRegion(img, region[0], region[1]);
  return result;
}

/** Free horizontal span of the bubble interior on every second row, through the text's centre column. */
export function bubbleRows(mask: Uint8Array, holes: Uint8Array, width: number, box: Box, cx: number, region: Box): BubbleRows {
  const step = 2;
  const l: number[] = [];
  const r: number[] = [];
  const inside = (p: number) => mask[p] === 1 || holes[p] === 1;
  const x0 = box[0];
  const x1 = box[0] + box[2] - 1;
  for (let y = box[1]; y < box[1] + box[3]; y += step) {
    const row = y * width;
    let c = Math.max(x0, Math.min(x1, cx));
    if (!inside(row + c)) {
      // The centre column may hit a stray mark: look for the interior nearby on this row.
      let found = -1;
      for (let d = 1; d < box[2] / 4 && found < 0; d++) {
        if (c - d >= x0 && inside(row + c - d)) found = c - d;
        else if (c + d <= x1 && inside(row + c + d)) found = c + d;
      }
      if (found < 0) {
        l.push(cx + region[0]);
        r.push(cx + region[0]);
        continue;
      }
      c = found;
    }
    let a = c;
    let b = c;
    while (a > x0 && inside(row + a - 1)) a--;
    while (b < x1 && inside(row + b + 1)) b++;
    l.push(a + region[0]);
    r.push(b + 1 + region[0]);
  }
  return { y: box[1] + region[1], step, l, r };
}

function floodLeaks(f: FloodResult, region: Box, imageW: number, imageH: number): boolean {
  const [bx, by, bw, bh] = f.box;
  const [rx, ry, rw, rh] = region;
  const atLeft = bx === 0 && rx > 0;
  const atTop = by === 0 && ry > 0;
  const atRight = bx + bw >= rw && rx + rw < imageW;
  const atBottom = by + bh >= rh && ry + rh < imageH;
  return atLeft || atTop || atRight || atBottom;
}

/** Paint a user-drawn mask with a colour (editor brush) or diffuse it (editor inpaint). */
export function paintRegion(image: TiledImage, box: Box, mask: Uint8Array, mode: { kind: 'color'; color: RGB } | { kind: 'inpaint' }): void {
  const region = clampBox(box, image.width, image.height);
  const img = image.getRegion(...region);
  if (mode.kind === 'color') fillMask(img, mask, mode.color);
  else diffuseInpaint(img, mask, 120);
  image.putRegion(img, region[0], region[1]);
}

export function parseHex(hex: string): RGB {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [255, 255, 255];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Where to look for text the model did not report: around one cleaned block. */
export interface LeftoverProbe {
  /** Bubble (or text) box of the block, page pixels. */
  area: Box;
  /** Background colour of the bubble. */
  fill: RGB;
  /** Measured letter height of the block's own lettering. */
  letterHeight: number;
}

/**
 * Lettering still visible after cleaning next to the blocks the model reported: a line or a
 * whole second text in the same bubble that the model skipped. Looks for rows of letter-sized
 * marks on the bubble colour, away from every known block. Returns page-pixel boxes.
 */
export function findLeftoverText(image: TiledImage, probes: LeftoverProbe[], known: Box[]): Box[] {
  const found: Box[] = [];
  const queue = [...probes];
  for (let guard = 0; queue.length && guard < 40; guard++) {
    const pr = queue.shift()!;
    const h = pr.letterHeight;
    if (h < 6) continue;
    const region = clampBox(expandBox(pr.area, Math.round(h * 3)), image.width, image.height);
    if (region[2] * region[3] > 4_000_000) continue;
    const img = image.getRegion(...region);
    const all: Box = [0, 0, img.width, img.height];
    const near = new Uint8Array(img.width * img.height);
    for (let p = 0; p < near.length; p++) if (colorDist(img.data, p * 4, pr.fill) <= 42) near[p] = 1;
    const cand = onBackground(textMask(img, all, pr.fill, 60), img.width, img.height, all, near, 4);
    const knownLocal = known.map((k): Box => expandBox([k[0] - region[0], k[1] - region[1], k[2], k[3]], Math.round(h * 0.3)));
    const letters = components(cand, img.width, all).filter((c) => {
      const [x, y, w, ch] = c.box;
      if (c.pixels.length < 8 || ch < h * 0.45 || ch > h * 1.7 || w > h * 3) return false;
      const cx = x + w / 2;
      const cy = y + ch / 2;
      return !knownLocal.some((k) => cx >= k[0] && cx <= k[0] + k[2] && cy >= k[1] && cy <= k[1] + k[3]);
    });
    // Group neighbouring letters into text.
    const groups: { box: Box; n: number }[] = [];
    for (const c of letters) {
      let g = groups.find((x) => boxGap(x.box, c.box) <= h * 0.8);
      if (!g) groups.push((g = { box: c.box, n: 0 }));
      g.box = unionBox(g.box, c.box);
      g.n++;
      // Joining may connect two groups: merge them.
      for (let i = groups.length - 1; i >= 0; i--) {
        const o = groups[i];
        if (o !== g && boxGap(o.box, g.box) <= h * 0.8) {
          g.box = unionBox(g.box, o.box);
          g.n += o.n;
          groups.splice(i, 1);
        }
      }
    }
    for (const g of groups) {
      if (g.n < 4 || g.box[2] < h * 2) continue;
      const box: Box = [g.box[0] + region[0], g.box[1] + region[1], g.box[2], g.box[3]];
      const same = found.findIndex((f) => boxGap(f, box) <= h * 0.8);
      if (same >= 0) {
        const grown = unionBox(found[same], box);
        if (boxArea(grown) <= boxArea(found[same])) continue;
        found[same] = grown;
      } else found.push(box);
      // The rest of that text may lie further from the bubble we started from: look around it too.
      queue.push({ area: box, fill: pr.fill, letterHeight: h });
    }
  }
  return found;
}

/**
 * Places with lettering anywhere on a (cleaned) page: light areas — bubbles of any shape, captions,
 * the white gutter — that enclose rows of letter-sized marks. Used to find text the model did not
 * report at all (an unusual bubble it skipped). Returns probes for findLeftoverText.
 */
export function findTextRegions(image: TiledImage, opts: { band?: number; minLetters?: number } = {}): LeftoverProbe[] {
  const bandH = opts.band ?? 2048;
  const minLetters = opts.minLetters ?? 6;
  const probes: LeftoverProbe[] = [];
  for (let top = 0; top < image.height; top += bandH - 200) {
    const region = clampBox([0, top, image.width, Math.min(bandH, image.height - top)], image.width, image.height);
    const img = image.getRegion(...region);
    const { width: w, height: h, data } = img;
    const n = w * h;
    // Light pixels: the inside of bubbles and captions (white or nearly white).
    const light = new Uint8Array(n);
    for (let p = 0; p < n; p++) if (data[p * 4] > 215 && data[p * 4 + 1] > 215 && data[p * 4 + 2] > 215) light[p] = 1;
    const label = new Int32Array(n).fill(-1);
    const comps: { box: Box; area: number }[] = [];
    const stack: number[] = [];
    for (let p0 = 0; p0 < n; p0++) {
      if (!light[p0] || label[p0] >= 0) continue;
      const id = comps.length;
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
        if (x > 0 && light[p - 1] && label[p - 1] < 0) (label[p - 1] = id), stack.push(p - 1);
        if (x < w - 1 && light[p + 1] && label[p + 1] < 0) (label[p + 1] = id), stack.push(p + 1);
        if (y > 0 && light[p - w] && label[p - w] < 0) (label[p - w] = id), stack.push(p - w);
        if (y < h - 1 && light[p + w] && label[p + w] < 0) (label[p + w] = id), stack.push(p + w);
      }
      comps.push({ box: [minX, minY, maxX - minX + 1, maxY - minY + 1], area });
    }
    for (const [id, c] of comps.entries()) {
      if (c.area < 1500 || c.box[2] < 40 || c.box[3] < 24) continue;
      // Marks enclosed by this light area (not connected to its bounding box's edge).
      const [bx, by, bw, bh] = c.box;
      const outside = new Uint8Array(bw * bh);
      const q: number[] = [];
      const local = (x: number, y: number) => (y - by) * bw + (x - bx);
      const seed = (x: number, y: number) => {
        const i = local(x, y);
        if (label[y * w + x] !== id && !outside[i]) (outside[i] = 1), q.push(i);
      };
      for (let x = bx; x < bx + bw; x++) seed(x, by), seed(x, by + bh - 1);
      for (let y = by; y < by + bh; y++) seed(bx, y), seed(bx + bw - 1, y);
      while (q.length) {
        const i = q.pop()!;
        const x = (i % bw) + bx;
        const y = Math.floor(i / bw) + by;
        for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]] as const) {
          if (nx < bx || ny < by || nx >= bx + bw || ny >= by + bh) continue;
          const j = local(nx, ny);
          if (!outside[j] && label[ny * w + nx] !== id) (outside[j] = 1), q.push(j);
        }
      }
      const holes = new Uint8Array(bw * bh);
      let any = 0;
      for (let y = by; y < by + bh; y++) for (let x = bx; x < bx + bw; x++) if (label[y * w + x] !== id && !outside[local(x, y)]) (holes[local(x, y)] = 1), any++;
      if (any < 60 || any > c.area) continue;
      // Letters: small, dark ink (bubble lettering is black or near-black, unlike bits of art).
      const ink = (m: Component) => {
        let sum = 0;
        for (let k = 0; k < m.pixels.length; k += 3) {
          const lx = m.pixels[k] % bw;
          const ly = (m.pixels[k] - lx) / bw;
          const p = ((ly + by) * w + lx + bx) * 4;
          sum += luminance(data[p], data[p + 1], data[p + 2]);
        }
        return sum / Math.ceil(m.pixels.length / 3);
      };
      const marks = components(holes, bw, [0, 0, bw, bh]).filter((m) => m.pixels.length >= 12 && m.box[3] >= 8 && m.box[3] <= 90 && m.box[2] <= m.box[3] * 3.5 && ink(m) < 100);
      if (marks.length < minLetters) continue;
      const hs = marks.map((m) => m.box[3]).sort((a, b) => a - b);
      const letterHeight = hs[Math.floor(hs.length / 2)];
      probes.push({ area: [bx + region[0], by + region[1], bw, bh], fill: [255, 255, 255], letterHeight });
    }
    if (top + bandH >= image.height) break;
  }
  return probes;
}
