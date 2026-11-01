import type { Box, PageResult, TextBlock } from '../types';
import { dominantLanguage } from '../languages';
import type { DecodedImage, ImageBackend } from './backend';
import { rowBusyness } from './slice';
import { TiledImage } from './tiled';

/**
 * Webtoon sites cut one long strip into many pictures, often right through a speech bubble.
 * Translating each picture alone loses the half bubbles and the context between them, so
 * neighbouring pictures of one column are glued into chunks, translated as one page and the
 * result is cut back along the original pictures.
 */

export interface StripPart {
  bytes: Uint8Array;
  mime?: string;
}

export interface PartSpan {
  y: number;
  h: number;
  /** A picture narrower than the strip, centred in it: where it starts and its own width. */
  x?: number;
  w?: number;
}

/** A chunk is cut here at the latest, and preferably once it is this tall at a calm seam. */
export const STRIP_MAX = 8000;
/**
 * Glue only where something is drawn across the seam (a bubble cut by the site): every calm seam is
 * a cut. Big glued chunks made the model read more at once and the translation got worse.
 */
export const STRIP_MIN = 0;

/**
 * Group consecutive pictures (by height, at the common width) into chunks. A chunk ends once it
 * is tall enough and the seam after it is calm (nothing drawn across it), and before it would
 * grow past `max`. A single picture taller than `max` is a chunk of its own.
 */
export function planChunks(heights: number[], calmAfter: boolean[], min = STRIP_MIN, max = STRIP_MAX): number[][] {
  const chunks: number[][] = [];
  let cur: number[] = [];
  let h = 0;
  for (let i = 0; i < heights.length; i++) {
    if (cur.length && h + heights[i] > max) {
      chunks.push(cur);
      cur = [];
      h = 0;
    }
    cur.push(i);
    h += heights[i];
    if (h >= min && calmAfter[i] !== false) {
      chunks.push(cur);
      cur = [];
      h = 0;
    }
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

/**
 * planChunks with the seams' own word: `free(i)` says nothing (no bubble, no text) crosses the seam
 * after picture i — a seam can look calm (the white middle of a bubble) and still cut a bubble.
 * A cut needs a calm and free seam; a chunk grown past `max` is cut at its last free seam (where it
 * reaches the limit only when no seam in it is free). Without `free` the pixels decide, as before.
 */
export async function planChunksBy(heights: number[], calmAfter: boolean[], free: ((i: number) => Promise<boolean>) | undefined, min = STRIP_MIN, max = STRIP_MAX): Promise<number[][]> {
  if (!free) return planChunks(heights, calmAfter, min, max);
  const known = new Map<number, boolean>();
  const isFree = async (i: number) => {
    if (!known.has(i)) known.set(i, await free(i));
    return known.get(i)!;
  };
  const chunks: number[][] = [];
  let cur: number[] = [];
  let h = 0;
  for (let i = 0; i < heights.length; i++) {
    if (cur.length && h + heights[i] > max) {
      let at = cur.length - 1;
      while (at > 0 && !(await isFree(cur[at]))) at--;
      if (at === 0 && !(await isFree(cur[0]))) at = cur.length - 1;
      chunks.push(cur.slice(0, at + 1));
      cur = cur.slice(at + 1);
      h = cur.reduce((a, j) => a + heights[j], 0);
    }
    cur.push(i);
    h += heights[i];
    if (h >= min && calmAfter[i] !== false && (i === heights.length - 1 || (await isFree(i)))) {
      chunks.push(cur);
      cur = [];
      h = 0;
    }
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

/** Is the seam between two pictures calm: the bottom rows of one and top rows of the next are plain. */
export function calmSeam(bottom: Float32Array, top: Float32Array, threshold = 6): boolean {
  const mean = (a: Float32Array) => a.reduce((s, v) => s + v, 0) / Math.max(1, a.length);
  return mean(bottom) < threshold && mean(top) < threshold;
}

export interface Stitched {
  image: TiledImage;
  spans: PartSpan[];
  /** Calmness of the seam after each picture (the last one is always calm). */
  calmAfter: boolean[];
}

export interface StripPlan {
  /** Common width: the first picture's; the others are scaled to it. */
  width: number;
  spans: PartSpan[];
  /** Calmness of the seam after each picture (the last one is always calm). */
  calmAfter: boolean[];
}

const SEAM_BAND = 4;

/** Pixels of `rows` rows at the top or bottom of a decoded picture, scaled to `width`. */
function edgeRows(backend: ImageBackend, d: DecodedImage, width: number, top: boolean): Float32Array {
  const srcRows = Math.min(d.height, Math.max(1, Math.round((SEAM_BAND * d.width) / width)));
  const c = backend.createCanvas(width, SEAM_BAND);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(d.source, 0, top ? 0 : d.height - srcRows, d.width, srcRows, 0, 0, width, SEAM_BAND);
  return rowBusyness(ctx.getImageData(0, 0, width, SEAM_BAND).data, width, SEAM_BAND);
}

/**
 * Lay out pictures one under another without gluing them: sizes and seams only. One picture is
 * decoded at a time and released at once, so a whole chapter never sits in memory.
 */
export async function planStrip(backend: ImageBackend, parts: StripPart[]): Promise<StripPlan> {
  const spans: PartSpan[] = [];
  const tops: Float32Array[] = [];
  const bottoms: Float32Array[] = [];
  let width = 0;
  let y = 0;
  for (const p of parts) {
    const d = await backend.decode(p.bytes, p.mime);
    try {
      if (!width) width = d.width;
      const h = Math.max(1, Math.round((d.height * width) / d.width));
      spans.push({ y, h });
      y += h;
      tops.push(edgeRows(backend, d, width, true));
      bottoms.push(edgeRows(backend, d, width, false));
    } finally {
      d.close?.();
    }
  }
  const calmAfter = spans.map((_, i) => (i === spans.length - 1 ? true : calmSeam(bottoms[i], tops[i + 1])));
  return { width, spans, calmAfter };
}

/** Glue the pictures of one chunk (indices into `parts`/`plan.spans`), decoding one at a time. */
export async function stitchChunk(backend: ImageBackend, parts: StripPart[], plan: StripPlan, chunk: number[]): Promise<TiledImage> {
  const top = plan.spans[chunk[0]].y;
  const last = plan.spans[chunk[chunk.length - 1]];
  const image = new TiledImage(backend, plan.width, last.y + last.h - top);
  for (const i of chunk) {
    const d = await backend.decode(parts[i].bytes, parts[i].mime);
    try {
      const s = { y: plan.spans[i].y - top, h: plan.spans[i].h };
      for (const t of image.tiles) {
        if (t.y + t.h <= s.y || t.y >= s.y + s.h) continue;
        t.canvas.getContext('2d').drawImage(d.source, 0, 0, d.width, d.height, 0, s.y - t.y, plan.width, s.h);
      }
    } finally {
      d.close?.();
    }
  }
  return image;
}

/**
 * Glue all pictures one under another at the width of the first (others are scaled to it).
 * Holds the whole strip in memory: for long chapters use planStrip + stitchChunk.
 */
export async function stitchParts(backend: ImageBackend, parts: StripPart[]): Promise<Stitched> {
  const plan = await planStrip(backend, parts);
  const image = await stitchChunk(backend, parts, plan, parts.map((_, i) => i));
  return { image, spans: plan.spans, calmAfter: plan.calmAfter };
}

/** Cut a horizontal band out of a tiled image (and, for a narrower picture in it, its columns). */
export function cropRows(image: TiledImage, y: number, h: number, x = 0, w = image.width): TiledImage {
  const out = new TiledImage(image.backend, w, h);
  for (const t of out.tiles) {
    const ctx = t.canvas.getContext('2d');
    for (const s of image.tiles) {
      if (s.y + s.h <= y + t.y || s.y >= y + t.y + t.h) continue;
      ctx.drawImage(s.canvas, -x, s.y - y - t.y);
    }
  }
  return out;
}

const shiftBox = (b: Box, dy: number, dx: number): Box => [b[0] - dx, b[1] - dy, b[2], b[3]];

/** Move a block up by `dy` (and left by `dx`) pixels: into the coordinates of one picture. */
export function shiftBlock(b: TextBlock, dy: number, dx = 0): TextBlock {
  const out: TextBlock = { ...b, bbox: shiftBox(b.bbox, dy, dx), polygon: b.polygon.map(([x, y]) => [x - dx, y - dy] as [number, number]) };
  if (b.textBox) out.textBox = shiftBox(b.textBox, dy, dx);
  if (b.bubble) {
    out.bubble = { ...b.bubble, box: shiftBox(b.bubble.box, dy, dx), safeArea: shiftBox(b.bubble.safeArea, dy, dx) };
    if (b.bubble.rows) out.bubble.rows = { ...b.bubble.rows, y: b.bubble.rows.y - dy, l: b.bubble.rows.l.map((v) => v - dx), r: b.bubble.rows.r.map((v) => v - dx) };
  }
  return out;
}

/** Where a block's text is drawn: its text box, else its bubble, else the box of the original text. */
function drawnBox(b: TextBlock): Box {
  return b.textBox ?? b.bubble?.box ?? b.bbox;
}

/**
 * The blocks of one picture, in its coordinates. A block belongs to the picture holding the centre of
 * its drawn text; a picture also gets a copy (`continued: true`) of every other block whose drawn
 * text reaches into it, so a bubble crossing the seam is drawn on both halves.
 */
export function pageForSpan(page: PageResult, span: PartSpan, index: number): PageResult {
  const blocks: TextBlock[] = [];
  for (const b of page.blocks) {
    const box = drawnBox(b);
    const cy = box[1] + box[3] / 2;
    const own = cy >= span.y && cy < span.y + span.h;
    const reaches = box[1] < span.y + span.h && box[1] + box[3] > span.y;
    if (!own && !reaches) continue;
    const { continued: _continued, ...rest } = b;
    blocks.push(shiftBlock(own ? rest : { ...rest, continued: true }, span.y, span.x ?? 0));
  }
  return { ...page, stripLang: dominantLanguage(page.blocks.map((b) => b.language)), pageId: `${page.pageId}~${index}`, width: span.w ?? page.width, height: span.h, blocks, usage: index === 0 ? page.usage : [] };
}
