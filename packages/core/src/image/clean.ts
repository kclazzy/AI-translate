import type { Box, BubbleInfo } from '../types';
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
  // Initialise with the mean of unmasked neighbours along rows for a better start.
  for (const p of idx) {
    const y = Math.floor(p / width);
    let l = p - 1, r = p + 1;
    while (l >= y * width && mask[l]) l--;
    while (r < (y + 1) * width && mask[r]) r++;
    const pick = l >= y * width ? l : r < (y + 1) * width ? r : -1;
    if (pick >= 0) for (let c = 0; c < 3; c++) data[p * 4 + c] = data[pick * 4 + c];
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
  method: 'fill' | 'diffuse' | 'none';
}

export interface CleanOptions {
  /** Only analyse (find bubble/safe area) without erasing. */
  analyzeOnly?: boolean;
}

/**
 * Remove the original text of one block from a tiled image and describe the
 * bubble the translation should go into.
 */
export function cleanBlock(image: TiledImage, bbox: Box, opts: CleanOptions = {}): CleanResult {
  // Bubbles are often much larger than their text: grow the analysed region until the
  // bubble outline closes (open page background never closes and ends as a plain box).
  const maxDim = Math.max(bbox[2], bbox[3]);
  const pads = [Math.max(24, 0.9 * maxDim), Math.max(48, 1.8 * maxDim), Math.max(80, 3 * maxDim)].map(Math.round);
  let attempt = 0;
  let region: Box;
  let img: PixelData;
  let local: Box;
  let localPadded: Box;
  let ring: ReturnType<typeof ringStats>;
  for (;;) {
    region = clampBox(expandBox(bbox, pads[attempt]), image.width, image.height);
    img = image.getRegion(...region);
    local = [bbox[0] - region[0], bbox[1] - region[1], bbox[2], bbox[3]];
    localPadded = clampBox(expandBox(local, 3), img.width, img.height);
    ring = ringStats(img, localPadded, 2, 8);
    if (ring.std >= 24 || attempt === pads.length - 1) break;
    const probeMask = textMask(img, clampBox(expandBox(local, 4), img.width, img.height), ring.color, 48);
    const probe = floodBubble(img, localPadded, ring.color, 42, probeMask);
    if (!probe.touchesEdge) break;
    attempt++;
  }
  const bg = ring.color;
  const bgLum = luminance(...bg);

  let result: CleanResult = { bubble: null, textBox: null, method: 'none' };

  if (ring.std < 24) {
    // Flat background, typically a speech bubble.
    let mask = textMask(img, clampBox(expandBox(local, 4), img.width, img.height), bg, 48);
    const flood = floodBubble(img, localPadded, bg, 42, mask);
    const closed = !flood.touchesEdge && flood.area > boxArea(local) * 0.8;
    if (closed) {
      const holes = enclosedHoles(flood.mask, img.width, img.height, clampBox(expandBox(flood.box, 1), img.width, img.height));
      for (let i = 0; i < holes.length; i++) if (holes[i]) mask[i] = 1;
    }
    const tb = maskBounds(mask, img.width, img.height);
    mask = dilate(mask, img.width, img.height, 2);
    if (closed) {
      // Never paint outside the bubble interior (keeps the outline intact).
      const interior = dilate(flood.mask, img.width, img.height, 1);
      const holes = enclosedHoles(flood.mask, img.width, img.height, clampBox(expandBox(flood.box, 1), img.width, img.height));
      for (let i = 0; i < mask.length; i++) if (mask[i] && !interior[i] && !holes[i]) mask[i] = 0;
    }
    if (!opts.analyzeOnly) fillMask(img, mask, bg);
    const textBox: Box | null = tb ? [tb[0] + region[0], tb[1] + region[1], tb[2], tb[3]] : null;
    let bubble: BubbleInfo | null = null;
    if (closed) {
      const bb: Box = [flood.box[0] + region[0], flood.box[1] + region[1], flood.box[2], flood.box[3]];
      const fillRatio = flood.area / Math.max(1, boxArea(flood.box));
      const shape = fillRatio < 0.86 ? 'ellipse' : 'rect';
      const inset = shape === 'ellipse' ? 0.1 : 0.06;
      const safe: Box = [bb[0] + bb[2] * inset, bb[1] + bb[3] * inset, bb[2] * (1 - 2 * inset), bb[3] * (1 - 2 * inset)];
      bubble = { box: bb, fill: toHex(bg), safeArea: safe.map(Math.round) as Box, shape };
    } else {
      const base = textBox ?? bbox;
      bubble = { box: base, fill: toHex(bg), safeArea: expandBox(base, Math.round(base[2] * 0.08), Math.round(base[3] * 0.08)).map(Math.round) as Box, shape: 'rect' };
    }
    result = { bubble, textBox, method: opts.analyzeOnly ? 'none' : 'fill' };
  } else {
    // Textured background: erase text strokes (dark or light) and diffuse surrounding colour in.
    const inner = clampBox(expandBox(local, 2), img.width, img.height);
    let mask = textMask(img, inner, bg, 70);
    // Light outlines around dark SFX letters are common; include very bright/dark extremes too.
    for (let y = inner[1]; y < inner[1] + inner[3]; y++) {
      for (let x = inner[0]; x < inner[0] + inner[2]; x++) {
        const p = y * img.width + x;
        const l = luminance(img.data[p * 4], img.data[p * 4 + 1], img.data[p * 4 + 2]);
        if ((bgLum > 60 && l < 50) || (bgLum < 200 && l > 235)) mask[p] = 1;
      }
    }
    const tb = maskBounds(mask, img.width, img.height);
    if (countMask(mask) < inner[2] * inner[3] * 0.03) {
      mask = new Uint8Array(img.width * img.height);
      for (let y = inner[1]; y < inner[1] + inner[3]; y++) for (let x = inner[0]; x < inner[0] + inner[2]; x++) mask[y * img.width + x] = 1;
    }
    mask = dilate(mask, img.width, img.height, 3);
    if (!opts.analyzeOnly) diffuseInpaint(img, mask, 80);
    const textBox: Box | null = tb ? [tb[0] + region[0], tb[1] + region[1], tb[2], tb[3]] : null;
    result = { bubble: null, textBox, method: opts.analyzeOnly ? 'none' : 'diffuse' };
  }

  if (!opts.analyzeOnly) image.putRegion(img, region[0], region[1]);
  return result;
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
