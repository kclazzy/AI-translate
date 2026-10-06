/**
 * Cutting a long webtoon strip into book pages for PDF/EPUB: cut where a row is (nearly) one
 * colour — a gutter between panels — so speech bubbles and faces are not sliced in half.
 */

/** How "busy" each pixel row is: mean absolute difference between neighbouring pixels plus colour spread. */
export function rowBusyness(data: Uint8ClampedArray, width: number, height: number, step = 2): Float32Array {
  const out = new Float32Array(height);
  for (let y = 0; y < height; y++) {
    const row = y * width * 4;
    let diff = 0;
    let min = 255;
    let max = 0;
    let n = 0;
    for (let x = step; x < width; x += step) {
      const i = row + x * 4;
      const j = i - step * 4;
      const l = (data[i] * 3 + data[i + 1] * 6 + data[i + 2]) / 10;
      const k = (data[j] * 3 + data[j + 1] * 6 + data[j + 2]) / 10;
      diff += Math.abs(l - k);
      if (l < min) min = l;
      if (l > max) max = l;
      n++;
    }
    out[y] = diff / Math.max(1, n) + (max - min) * 0.05;
  }
  return out;
}

export interface SliceOptions {
  /** Preferred page height in pixels (default: 1.45 × width, a book page). */
  target?: number;
  /** A page may be this much shorter / longer than the target to reach a calm row. */
  minFactor?: number;
  maxFactor?: number;
}

/**
 * Cut positions (y of each page start, starting with 0) for a strip of `height` rows given their
 * busyness. Picks the calmest row in a window around each target; a short remainder is merged
 * into the previous page.
 */
export function planSlices(busy: Float32Array, width: number, opts: SliceOptions = {}): number[] {
  const height = busy.length;
  const target = Math.round(opts.target ?? width * 1.45);
  const minH = Math.round(target * (opts.minFactor ?? 0.6));
  const maxH = Math.round(target * (opts.maxFactor ?? 1.35));
  if (height <= maxH) return [0];
  const cuts = [0];
  let start = 0;
  while (height - start > maxH) {
    const from = start + minH;
    const to = Math.min(height - minH, start + maxH);
    let best = start + target;
    let bestScore = Infinity;
    for (let y = from; y <= to; y++) {
      // A calm band (a few rows) is a better cut than one calm row inside artwork.
      let s = 0;
      for (let d = -3; d <= 3; d++) s += busy[Math.max(0, Math.min(height - 1, y + d))];
      // Mild preference for staying near the target height.
      const score = s + Math.abs(y - (start + target)) * 0.002;
      if (score < bestScore) {
        bestScore = score;
        best = y;
      }
    }
    if (best <= start) best = start + target;
    cuts.push(best);
    start = best;
  }
  return cuts;
}
