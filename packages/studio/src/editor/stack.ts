/**
 * Which pages of a chapter go into the whole-chapter strip of the editor, and where. Pages of a
 * similar width (a site scans them a few pixels apart, or the last page is a little narrower) are all
 * in it, the narrower ones centred; a page far wider or narrower (a double spread) stays out. The
 * strip holds the opened page and its neighbours while they fit in `limit` pixels.
 */

export interface StackPage {
  key: string;
  /** Its number in the chapter (1-based). */
  n: number;
  width: number;
  height: number;
}

/** A picture of the chapter that is not in the strip, and why. */
export interface Skipped {
  n: number;
  why: 'missing' | 'width' | 'window';
}

export interface StackPlan<P extends StackPage> {
  /** The strip's width: the widest page in it. */
  width: number;
  /** In order, each at its place in the strip. */
  chosen: (P & { x: number; y: number })[];
  skipped: Skipped[];
}

/** How far a page's width may be from the opened page's to be in the strip. */
export const STACK_WIDTH_SPREAD = 0.25;

export function planStack<P extends StackPage>(pages: P[], mainKey: string, limit: number): StackPlan<P> {
  const mainAt = Math.max(0, pages.findIndex((p) => p.key === mainKey));
  const w0 = pages[mainAt].width;
  const skipped: Skipped[] = [];
  const same: P[] = [];
  for (const p of pages) {
    if (Math.abs(p.width - w0) <= w0 * STACK_WIDTH_SPREAD) same.push(p);
    else skipped.push({ n: p.n, why: 'width' });
  }
  const width = Math.max(...same.map((p) => p.width));
  let lo = same.findIndex((p) => p.key === pages[mainAt].key);
  let hi = lo;
  let px = width * same[lo].height;
  for (let grew = true; grew; ) {
    grew = false;
    for (const side of [1, -1]) {
      const j = side > 0 ? hi + 1 : lo - 1;
      if (j < 0 || j >= same.length || px + width * same[j].height > limit) continue;
      px += width * same[j].height;
      if (side > 0) hi = j;
      else lo = j;
      grew = true;
    }
  }
  for (const [j, p] of same.entries()) if (j < lo || j > hi) skipped.push({ n: p.n, why: 'window' });
  skipped.sort((a, b) => a.n - b.n);
  let y = 0;
  const chosen = same.slice(lo, hi + 1).map((p) => {
    const at = { ...p, x: Math.floor((width - p.width) / 2), y };
    y += p.height;
    return at;
  });
  return { width, chosen, skipped };
}
