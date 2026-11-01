import type { Box } from '../types';

/**
 * Checks of a chapter's analysis pack (its page.json files and pictures) for the two layout faults
 * seen on webtoons: a speech bubble cut by the seam between two pictures that were translated apart,
 * and a translation drawn off its bubble (over the art). Pure: the caller reads the pack.
 */

export interface PackBlock {
  id: string;
  text: string;
  /** What is drawn in its place: empty when the block was left as it is (an untranslated SFX). */
  translation: string;
  bbox: Box;
  bubble?: Box;
}

export interface PackPage {
  /** Folder name in the pack: 001, 002… (reading order). */
  name: string;
  width: number;
  height: number;
  blocks: PackBlock[];
  /** 'strip' when this picture was translated together with the one above. */
  joined?: string;
}

export type PackIssue =
  | { kind: 'seam-cut'; upper: string; lower: string; glued: boolean; text: string }
  | { kind: 'loose-box'; page: string; block: string; why: string }
  | { kind: 'spill'; page: string; box: Box; area: number };

/** A bubble this close to a picture's edge goes on in the neighbour picture. */
const EDGE = 6;

export function checkPack(pages: PackPage[]): PackIssue[] {
  const out: PackIssue[] = [];
  for (const [i, lower] of pages.entries()) {
    const upper = pages[i - 1];
    if (upper) {
      const low = upper.blocks.filter((b) => b.bubble && b.bubble[1] + b.bubble[3] >= upper.height - EDGE);
      const top = lower.blocks.filter((b) => b.bubble && b.bubble[1] <= EDGE);
      if (low.length && top.length) out.push({ kind: 'seam-cut', upper: upper.name, lower: lower.name, glued: lower.joined === 'strip', text: [...low, ...top].map((b) => b.text).join(' | ') });
    }
    for (const b of lower.blocks) {
      if (!b.translation.trim()) continue;
      const why = looseWhy(b, lower);
      if (why) out.push({ kind: 'loose-box', page: lower.name, block: b.id, why });
    }
  }
  return out;
}

/** Why the place for the translation is wrong for this text, or null. */
function looseWhy(b: PackBlock, p: PackPage): string | null {
  const share = (b.bbox[2] * b.bbox[3]) / (p.width * p.height);
  const chars = Math.max(1, b.text.length);
  if (!b.bubble) {
    // Lettering takes far less than 0.5% of the picture per character.
    return share >= 0.05 && share / chars >= 0.005 ? `no bubble, box is ${Math.round(share * 100)}% of the picture for ${chars} characters` : null;
  }
  const inside = overlap(b.bbox, b.bubble) / Math.max(1, b.bbox[2] * b.bbox[3]);
  return inside < 0.5 ? `box is ${Math.round((1 - inside) * 100)}% outside its bubble` : null;
}

function overlap(a: Box, b: Box): number {
  const w = Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * Places the render changed outside every allowed box (bubbles and text boxes): `changed` is 1 where
 * the result differs from the original. Regions smaller than `minArea` pixels (JPEG noise) are left out.
 */
export function spillRegions(changed: Uint8Array, width: number, height: number, allowed: Box[], minArea: number): { box: Box; area: number }[] {
  const free = changed.slice();
  for (const [x, y, w, h] of allowed)
    for (let yy = Math.max(0, y); yy < Math.min(height, y + h); yy++) free.fill(0, yy * width + Math.max(0, x), yy * width + Math.min(width, x + w));
  const out: { box: Box; area: number }[] = [];
  const stack: number[] = [];
  for (let start = 0; start < free.length; start++) {
    if (!free[start]) continue;
    free[start] = 0;
    stack.push(start);
    let area = 0;
    let x0 = width, y0 = height, x1 = 0, y1 = 0;
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % width;
      const y = (i - x) / width;
      area++;
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
      for (const n of [x > 0 ? i - 1 : -1, x < width - 1 ? i + 1 : -1, y > 0 ? i - width : -1, y < height - 1 ? i + width : -1])
        if (n >= 0 && free[n]) {
          free[n] = 0;
          stack.push(n);
        }
    }
    if (area >= minArea) out.push({ box: [x0, y0, x1 - x0 + 1, y1 - y0 + 1], area });
  }
  return out;
}
