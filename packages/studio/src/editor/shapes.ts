import type { Box } from '@ait/core';

/** How the brush, eraser and ◍ paint: along the stroke, or a whole shape at once. */
export type BrushShape = 'free' | 'rect' | 'ellipse' | 'lasso';

/**
 * The area a shape gesture covers, as a box on the page and a mask over that box (1 = paint):
 * a rectangle or an ellipse in the frame from the first point to the last, or the polygon of all
 * points (lasso). Kept on the page; null when it has no area.
 */
export function shapeMask(shape: Exclude<BrushShape, 'free'>, pts: [number, number][], page: { width: number; height: number }): { box: Box; mask: Uint8Array } | null {
  if (!pts.length) return null;
  const xs = shape === 'lasso' ? pts.map((p) => p[0]) : [pts[0][0], pts[pts.length - 1][0]];
  const ys = shape === 'lasso' ? pts.map((p) => p[1]) : [pts[0][1], pts[pts.length - 1][1]];
  const fx0 = Math.min(...xs);
  const fy0 = Math.min(...ys);
  const fx1 = Math.max(...xs);
  const fy1 = Math.max(...ys);
  const x0 = Math.max(0, Math.floor(fx0));
  const y0 = Math.max(0, Math.floor(fy0));
  const x1 = Math.min(page.width, Math.ceil(fx1));
  const y1 = Math.min(page.height, Math.ceil(fy1));
  if (x1 - x0 < 2 || y1 - y0 < 2 || (shape === 'lasso' && pts.length < 3)) return null;
  const box: Box = [x0, y0, x1 - x0, y1 - y0];
  const mask = new Uint8Array(box[2] * box[3]);
  const cx = (fx0 + fx1) / 2;
  const cy = (fy0 + fy1) / 2;
  const rx = Math.max(0.5, (fx1 - fx0) / 2);
  const ry = Math.max(0.5, (fy1 - fy0) / 2);
  const inside = (x: number, y: number): boolean => {
    if (shape === 'rect') return true;
    if (shape === 'ellipse') return ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
    // Lasso: even-odd rule over the polygon of the points.
    let odd = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i];
      const [xj, yj] = pts[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) odd = !odd;
    }
    return odd;
  };
  for (let y = 0; y < box[3]; y++) for (let x = 0; x < box[2]; x++) if (inside(x0 + x + 0.5, y0 + y + 0.5)) mask[y * box[2] + x] = 1;
  return { box, mask };
}
