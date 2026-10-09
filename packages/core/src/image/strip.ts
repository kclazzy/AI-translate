import type { Box, PageResult, TextBlock } from '../types';
import type { ImageBackend } from './backend';
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
}

/** A chunk is cut here at the latest, and preferably once it is this tall at a calm seam. */
export const STRIP_MAX = 8000;
export const STRIP_MIN = 3500;

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

/** Glue pictures one under another at the width of the first (others are scaled to it). */
export async function stitchParts(backend: ImageBackend, parts: StripPart[]): Promise<Stitched> {
  const decoded = [];
  try {
    for (const p of parts) decoded.push(await backend.decode(p.bytes, p.mime));
    const width = decoded[0].width;
    const spans: PartSpan[] = [];
    let y = 0;
    for (const d of decoded) {
      const h = Math.max(1, Math.round((d.height * width) / d.width));
      spans.push({ y, h });
      y += h;
    }
    const image = new TiledImage(backend, width, y);
    for (const [i, d] of decoded.entries()) {
      const s = spans[i];
      for (const t of image.tiles) {
        if (t.y + t.h <= s.y || t.y >= s.y + s.h) continue;
        t.canvas.getContext('2d').drawImage(d.source, 0, 0, d.width, d.height, 0, s.y - t.y, width, s.h);
      }
    }
    const calmAfter = spans.map((s, i) => {
      if (i === spans.length - 1) return true;
      const band = 4;
      const a = image.getRegion(0, s.y + s.h - band, width, band);
      const b = image.getRegion(0, s.y + s.h, width, band);
      return calmSeam(rowBusyness(a.data, width, band), rowBusyness(b.data, width, band));
    });
    return { image, spans, calmAfter };
  } finally {
    for (const d of decoded) d.close?.();
  }
}

/** Cut a horizontal band out of a tiled image. */
export function cropRows(image: TiledImage, y: number, h: number): TiledImage {
  const out = new TiledImage(image.backend, image.width, h);
  for (const t of out.tiles) {
    const ctx = t.canvas.getContext('2d');
    for (const s of image.tiles) {
      if (s.y + s.h <= y + t.y || s.y >= y + t.y + t.h) continue;
      ctx.drawImage(s.canvas, 0, s.y - y - t.y);
    }
  }
  return out;
}

const shiftBox = (b: Box, dy: number): Box => [b[0], b[1] - dy, b[2], b[3]];

/** Move a block up by `dy` pixels (into the coordinates of one picture). */
export function shiftBlock(b: TextBlock, dy: number): TextBlock {
  const out: TextBlock = { ...b, bbox: shiftBox(b.bbox, dy), polygon: b.polygon.map(([x, y]) => [x, y - dy] as [number, number]) };
  if (b.textBox) out.textBox = shiftBox(b.textBox, dy);
  if (b.bubble) {
    out.bubble = { ...b.bubble, box: shiftBox(b.bubble.box, dy), safeArea: shiftBox(b.bubble.safeArea, dy) };
    if (b.bubble.rows) out.bubble.rows = { ...b.bubble.rows, y: b.bubble.rows.y - dy };
  }
  return out;
}

/** The blocks that belong to one picture: those whose centre lies in it, in its coordinates. */
export function pageForSpan(page: PageResult, span: PartSpan, index: number): PageResult {
  const blocks = page.blocks.filter((b) => {
    const box = b.bubble?.box ?? b.bbox;
    const cy = box[1] + box[3] / 2;
    return cy >= span.y && cy < span.y + span.h;
  });
  return { ...page, pageId: `${page.pageId}~${index}`, height: span.h, blocks: blocks.map((b) => shiftBlock(b, span.y)), usage: index === 0 ? page.usage : [] };
}
