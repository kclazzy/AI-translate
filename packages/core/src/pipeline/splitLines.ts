import type { PixelData } from '../image/backend';
import type { Box, TextBlock } from '../types';

/**
 * The model (or the detector) often cuts one bubble of two to four lines into two blocks: each is
 * translated without the other and set in its own size. Two speech blocks are one when they stand
 * one under the other (overlapping across by at least 35 % of the narrower), the gap between them is
 * less than 1.4 lines, and the ground between them is the bubble's own — no outline crosses it. Two
 * readings of the same box (a collage piece answered twice) are one as well.
 */

const SPEECH = new Set<TextBlock['textType']>(['DIALOGUE', 'NARRATION']);

const lum = (d: Uint8ClampedArray, i: number) => (d[i] * 3 + d[i + 1] * 6 + d[i + 2]) / 10;

function iou(a: Box, b: Box): number {
  const x = Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]));
  const y = Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
  const i = x * y;
  return i / Math.max(1, a[2] * a[3] + b[2] * b[3] - i);
}

/** Pixels of a part of the page (only the gap between two blocks is ever asked for). */
export type RegionOf = (x: number, y: number, w: number, h: number) => PixelData;

/** An outline (a long dark or light line, unlike the ground) across the gap between two boxes. */
function borderBetween(regionOf: RegionOf, x0: number, x1: number, y0: number, y1: number): boolean {
  const xa = Math.floor(x0);
  const ya = Math.floor(y0);
  const w = Math.ceil(x1) - xa;
  const h = Math.ceil(y1) - ya;
  if (w < 4 || h < 1) return false;
  const { width, height, data } = regionOf(xa, ya, w, h);
  // The ground: the median brightness of the gap.
  const vals: number[] = [];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x += 2) vals.push(lum(data, (y * width + x) * 4));
  vals.sort((a, b) => a - b);
  const ground = vals[vals.length >> 1];
  for (let y = 0; y < height; y++) {
    let n = 0;
    let all = 0;
    for (let x = 0; x < width; x += 2) {
      all++;
      if (Math.abs(lum(data, (y * width + x) * 4) - ground) > 100) n++;
    }
    if (n > all * 0.5) return true;
  }
  return false;
}

function union(a: Box, b: Box): Box {
  const x = Math.min(a[0], b[0]);
  const y = Math.min(a[1], b[1]);
  return [x, y, Math.max(a[0] + a[2], b[0] + b[2]) - x, Math.max(a[1] + a[3], b[1] + b[3]) - y];
}

const joinText = (a: string, b: string) => (!a ? b : !b ? a : /[-‐]$/.test(a) ? `${a.slice(0, -1)}${b}` : `${a} ${b}`);

/** Can `b` (below) be the next lines of `a`'s bubble? */
export function sameBubble(a: TextBlock, b: TextBlock, regionOf: RegionOf): boolean {
  if (!a.translate || !b.translate || a.textType !== b.textType || !SPEECH.has(a.textType)) return false;
  if (a.writingDirection !== 'ltr' || b.writingDirection !== 'ltr') return false;
  if (a.speaker && b.speaker && a.speaker !== b.speaker) return false;
  // Rows of a game/system window or a list (ATTACK +5% / DEFENSE +3%, [STATUS], • item): each its own.
  const row = (t: string) => /\d|[:：[\]【】•·|]/.test(t);
  if (row(a.originalText) || row(b.originalText)) return false;
  const [ax, ay, aw, ah] = a.bbox;
  const [bx, by, bw, bh] = b.bbox;
  if (iou(a.bbox, b.bbox) > 0.6) return true;
  const overlap = Math.min(ax + aw, bx + bw) - Math.max(ax, bx);
  if (overlap < Math.min(aw, bw) * 0.35) return false;
  // One line's height: the lower of the two boxes' line heights (from their font size estimate).
  const line = Math.max(6, Math.min(a.fontSizeEstimate || ah, b.fontSizeEstimate || bh, ah, bh));
  const gap = by - (ay + ah);
  if (gap > line * 1.4 || gap < -line * 0.5) return false;
  // Letters of very different sizes are different texts (a caption above a shout).
  const ka = a.fontSizeEstimate || ah;
  const kb = b.fontSizeEstimate || bh;
  if (Math.max(ka, kb) > Math.min(ka, kb) * 1.7) return false;
  return gap <= 2 || !borderBetween(regionOf, Math.max(ax, bx), Math.min(ax + aw, bx + bw), ay + ah, by);
}

/** Join blocks that are one bubble cut in two (see above), in reading order; ids of the kept blocks are returned with what they took in. */
export function mergeSplitLines(blocks: TextBlock[], regionOf: RegionOf): { blocks: TextBlock[]; joined: [string, string][] } {
  const out: TextBlock[] = [];
  const joined: [string, string][] = [];
  const used = new Set<string>();
  const order = [...blocks].sort((p, q) => p.bbox[1] - q.bbox[1]);
  for (const a of order) {
    if (used.has(a.id)) continue;
    let cur = a;
    for (const b of order) {
      if (b === a || used.has(b.id) || b.bbox[1] < cur.bbox[1] - 2) continue;
      if (!sameBubble(cur, b, regionOf)) continue;
      used.add(b.id);
      joined.push([cur.id, b.id]);
      const box = union(cur.bbox, b.bbox);
      const same = iou(cur.bbox, b.bbox) > 0.6;
      cur = {
        ...cur,
        originalText: joinText(cur.originalText, b.originalText),
        // A translation for both halves, or none (the joined text is translated as one).
        translatedText: cur.translatedText && b.translatedText ? joinText(cur.translatedText, b.translatedText) : '',
        bbox: box,
        polygon: [[box[0], box[1]], [box[0] + box[2], box[1]], [box[0] + box[2], box[1] + box[3]], [box[0], box[1] + box[3]]],
        fontSizeEstimate: same ? cur.fontSizeEstimate : Math.min(cur.fontSizeEstimate || b.fontSizeEstimate, b.fontSizeEstimate || cur.fontSizeEstimate),
        ...(cur.lowConfidence && b.lowConfidence ? {} : { lowConfidence: undefined }),
      };
    }
    used.add(a.id);
    out.push(cur);
  }
  // Back in the order they came in (reading order of the model).
  const pos = new Map(blocks.map((b, i) => [b.id, i]));
  out.sort((p, q) => pos.get(p.id)! - pos.get(q.id)!);
  return { blocks: out, joined };
}

/**
 * Room for a longer translation: grow a text area over the plain ground of its (open) bubble — rows
 * and columns of the fill colour — at most 35 % of its size on each side, stopping 6 px before
 * anything else (an outline, art, another text).
 */
export function growOverPlain(regionOf: RegionOf, box: Box, fill: [number, number, number], limits: { width: number; height: number }): Box {
  const [x, y, w, h] = box.map(Math.round) as Box;
  const my = Math.round(h * 0.35);
  const mx = Math.round(w * 0.35);
  const ox = Math.max(0, x - mx);
  const oy = Math.max(0, y - my);
  const ow = Math.min(limits.width, x + w + mx) - ox;
  const oh = Math.min(limits.height, y + h + my) - oy;
  if (ow <= 0 || oh <= 0) return box;
  const px = regionOf(ox, oy, ow, oh);
  const plain = (xx: number, yy: number) => {
    const i = ((yy - oy) * px.width + (xx - ox)) * 4;
    return Math.abs(px.data[i] - fill[0]) <= 24 && Math.abs(px.data[i + 1] - fill[1]) <= 24 && Math.abs(px.data[i + 2] - fill[2]) <= 24;
  };
  const rowPlain = (yy: number, x0: number, x1: number) => {
    for (let xx = x0; xx < x1; xx += 2) if (!plain(xx, yy)) return false;
    return true;
  };
  const colPlain = (xx: number, y0: number, y1: number) => {
    for (let yy = y0; yy < y1; yy += 2) if (!plain(xx, yy)) return false;
    return true;
  };
  const PAD = 6;
  let top = y;
  while (top - 1 >= oy && top - 1 >= y - my && rowPlain(top - 1, x, x + w)) top--;
  let bottom = y + h;
  while (bottom < oy + oh && bottom < y + h + my && rowPlain(bottom, x, x + w)) bottom++;
  // Only a side that grew keeps the distance to what stopped it.
  if (top < y) top = Math.min(y, top + PAD);
  if (bottom > y + h) bottom = Math.max(y + h, bottom - PAD);
  let left = x;
  while (left - 1 >= ox && left - 1 >= x - mx && colPlain(left - 1, top, bottom)) left--;
  let right = x + w;
  while (right < ox + ow && right < x + w + mx && colPlain(right, top, bottom)) right++;
  if (left < x) left = Math.min(x, left + PAD);
  if (right > x + w) right = Math.max(x + w, right - PAD);
  return [left, top, right - left, bottom - top];
}
