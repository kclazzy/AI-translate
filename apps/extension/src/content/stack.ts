/**
 * Is `lower` the next slice of the same strip under `upper` (same column, same width, right below)?
 * Sites cut a webtoon into slices and often leave a small gap between them (margins, the line
 * height under inline pictures): up to 32 px or 4 % of the width counts as touching. Whether a
 * bubble really crosses the seam is decided from the pixels later (the strip's calm seams).
 * One rule for gluing the pictures sent together and for repairing a seam afterwards.
 */
export interface Rect {
  left: number;
  top: number;
  width: number;
  bottom: number;
}

export function stackedBelow(upper: Rect, lower: Rect): boolean {
  if (upper.width <= 0 || lower.width <= 0) return false;
  if (Math.abs(upper.left - lower.left) > 2 || Math.abs(upper.width - lower.width) > 2) return false;
  const gap = lower.top - upper.bottom;
  return gap >= -6 && gap <= Math.max(32, upper.width * 0.04);
}
