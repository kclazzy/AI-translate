/**
 * Telling one text read twice from two different texts.
 *
 * A tall page is read in overlapping views, a missed bubble is read again from a crop, and the
 * model echoes the previous page's lines: the same words then arrive twice with slightly different
 * boxes and wording. Box overlap alone misses those (the boxes drift apart), and dropping equal
 * lines would also drop real repeats on a page. So a pair counts as one text only when the text
 * is the same (or one is part of the other) AND the boxes belong together.
 */
import type { Box } from '../types';

/** Letters and digits only, lowercase: «Wait… WAIT!» → "waitwait". */
export function normText(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

/** Dice similarity of letter pairs, 0–1 (1 = same letters in the same order). */
export function textSimilarity(a: string, b: string): number {
  const x = normText(a);
  const y = normText(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return 0;
  const bx = bigrams(x);
  const by = bigrams(y);
  let both = 0;
  for (const [g, n] of bx) both += Math.min(n, by.get(g) ?? 0);
  return (2 * both) / (x.length - 1 + (y.length - 1));
}

/**
 * Same text: nearly the same letters, or one is a part of the other (a half of a bubble read at a
 * view's edge). Very short texts («Ah», «!?») only when equal — they repeat on a page for real.
 */
export function sameText(a: string, b: string, min = 0.8): boolean {
  const x = normText(a);
  const y = normText(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const short = Math.min(x.length, y.length);
  if (short < 4) return false;
  if (x.includes(y) || y.includes(x)) return short >= Math.max(x.length, y.length) * 0.3;
  return textSimilarity(x, y) >= min;
}

/** Overlap area / smaller box area. */
export function overlapOfSmaller(a: Box, b: Box): number {
  const x = Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]));
  const y = Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
  return (x * y) / Math.max(1, Math.min(a[2] * a[3], b[2] * b[3]));
}

/** Boxes close enough to be one text read twice: overlapping, or the gap under one box height. */
export function nearBoxes(a: Box, b: Box): boolean {
  if (overlapOfSmaller(a, b) > 0) return true;
  const gapX = Math.max(0, Math.max(a[0], b[0]) - Math.min(a[0] + a[2], b[0] + b[2]));
  const gapY = Math.max(0, Math.max(a[1], b[1]) - Math.min(a[1] + a[3], b[1] + b[3]));
  const h = Math.max(a[3], b[3]);
  return gapX <= h && gapY <= h;
}

export interface ViewRead {
  box: Box;
  text: string;
  view: { y: number; h: number };
}

/** The box touches the top or bottom edge of its view (except the picture's own edges): it may be cut. */
function cutByView(l: ViewRead, pageHeight: number): boolean {
  const m = l.view.h * 0.02;
  return (l.view.y > 0 && l.box[1] <= l.view.y + m) || (l.view.y + l.view.h < pageHeight && l.box[1] + l.box[3] >= l.view.y + l.view.h - m);
}

/**
 * Remove texts read twice. From one view: only a box covering the same place with the same text
 * (rows of a status window stay). From two views: the same place, or the same text in nearby
 * boxes (the box drifted between the views). The copy kept is the one not cut by a view's edge,
 * then the longer text, then the one nearer its view's centre.
 */
export function dedupeReads<T extends ViewRead>(items: T[], pageHeight = Infinity): T[] {
  const out: T[] = [];
  const better = (a: T, b: T): boolean => {
    const ca = cutByView(a, pageHeight);
    const cb = cutByView(b, pageHeight);
    if (ca !== cb) return !ca;
    const la = normText(a.text).length;
    const lb = normText(b.text).length;
    if (Math.abs(la - lb) > Math.max(2, Math.min(la, lb) * 0.15)) return la > lb;
    const centre = (l: T) => Math.abs(l.box[1] + l.box[3] / 2 - (l.view.y + l.view.h / 2)) / l.view.h;
    return centre(a) < centre(b);
  };
  for (const it of items) {
    const dup = out.findIndex((o) => {
      const overlap = overlapOfSmaller(o.box, it.box);
      if (o.view === it.view) return overlap > 0.55 && (sameText(o.text, it.text) || overlap > 0.9);
      return overlap > 0.55 || (sameText(o.text, it.text) && nearBoxes(o.box, it.box));
    });
    if (dup < 0) out.push(it);
    else if (better(it, out[dup])) out[dup] = it;
  }
  return out;
}

/** Parts of one bubble's group that say the same thing: the longer one stays (order kept). */
export function dropRepeatedParts<T extends { originalText: string; translatedText: string }>(parts: T[]): T[] {
  const keep = parts.map(() => true);
  for (let i = 0; i < parts.length; i++) {
    for (let j = i + 1; j < parts.length; j++) {
      if (!keep[i] || !keep[j]) continue;
      if (!sameText(parts[i].originalText, parts[j].originalText)) continue;
      const li = normText(parts[i].originalText).length;
      const lj = normText(parts[j].originalText).length;
      if (lj > li) keep[i] = false;
      else keep[j] = false;
    }
  }
  return parts.filter((_, i) => keep[i]);
}

/** A block whose text repeats one of the previous page's lines (the model echoed its context). */
export function echoesContext(text: string, previous: { src: string; dst?: string }[]): boolean {
  if (normText(text).length < 4) return false;
  // Stricter than within a page: lines of one scene share phrases; an echo is the same line.
  return previous.some((l) => sameText(text, l.src, 0.9) || (!!l.dst && sameText(text, l.dst, 0.9)));
}
