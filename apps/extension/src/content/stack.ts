/**
 * Is `lower` right under `upper` in the same column (same left edge and width)?
 * - `touching` (gap up to 6 px): pictures sent together are glued into one strip job;
 * - `near` (gap up to 32 px or 4 % of the width): sites cut a webtoon into slices and often leave
 *   margins between them — a bubble cut by such a seam is repaired afterwards (the band across the
 *   seam translated once). Pages of a manga with margins stay separate jobs (each its own place in
 *   the queue); whether anything crosses a seam is decided from the pixels.
 */
export interface Rect {
  left: number;
  top: number;
  width: number;
  bottom: number;
}

export function stackedBelow(upper: Rect, lower: Rect, how: 'touching' | 'near' = 'near'): boolean {
  if (upper.width <= 0 || lower.width <= 0) return false;
  if (Math.abs(upper.left - lower.left) > 2 || Math.abs(upper.width - lower.width) > 2) return false;
  const gap = lower.top - upper.bottom;
  return gap >= -6 && gap <= (how === 'touching' ? 6 : Math.max(32, upper.width * 0.04));
}
