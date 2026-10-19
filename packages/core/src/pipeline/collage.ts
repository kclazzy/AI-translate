import { releaseCanvas, type ImageBackend } from '../image/backend';
import { clampBox, type TiledImage } from '../image/tiled';
import type { Box } from '../types';
import { extractJson, findBlocksArray } from '../translate/parse';

/**
 * Only the text of a page, for the vision model: the pieces where the detector found text, cut out
 * with a margin, numbered and laid out side by side in one small picture. A local model spends most
 * of a reading request on the picture itself (≈3 s of ≈4 s for a 800×1000 page on an RTX 5070), and
 * the text usually covers a fifth of the page; the model also no longer has to write coordinates.
 */
export interface CollagePiece {
  id: number;
  /** Where it is on the page. */
  box: Box;
  /** Where it is in the collage (scaled). */
  at: Box;
  /** The text boxes merged into it, in reading order (a piece may hold two bubbles that touch). */
  parts?: Box[];
}

export interface CollagePlan {
  width: number;
  height: number;
  pieces: CollagePiece[];
}

const LABEL = 36;
const GAP = 14;

/** Text boxes with a margin, merged where they touch, in reading order. */
export function pieceBoxes(boxes: Box[], width: number, height: number): Box[] {
  const grown = boxes.map((b) => {
    const pad = Math.max(8, Math.min(24, Math.round(Math.min(b[2], b[3]) * 0.15)));
    return clampBox([b[0] - pad, b[1] - pad, b[2] + pad * 2, b[3] + pad * 2], width, height);
  });
  const touch = (a: Box, b: Box) => a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];
  const out: Box[] = [];
  for (const g of grown) {
    let cur = g;
    for (let i = out.length - 1; i >= 0; i--) {
      if (!touch(out[i], cur)) continue;
      const o = out.splice(i, 1)[0];
      const x0 = Math.min(o[0], cur[0]);
      const y0 = Math.min(o[1], cur[1]);
      cur = [x0, y0, Math.max(o[0] + o[2], cur[0] + cur[2]) - x0, Math.max(o[1] + o[3], cur[1] + cur[3]) - y0];
      i = out.length;
    }
    out.push(cur);
  }
  // Reading order: top to bottom, then left to right within a row of pieces.
  return out.sort((a, b) => (Math.abs(a[1] - b[1]) < Math.min(a[3], b[3]) * 0.5 ? a[0] - b[0] : a[1] - b[1]));
}

/** Pieces on shelves of a picture `maxWidth` wide; a piece too wide is scaled down. */
export function planCollage(boxes: Box[], maxWidth = 1024, texts: Box[] = []): CollagePlan {
  const pieces: CollagePiece[] = [];
  let x = 0;
  let y = 0;
  let row = 0;
  let width = 0;
  for (const [i, b] of boxes.entries()) {
    const k = Math.min(1, (maxWidth - LABEL) / b[2]);
    const w = Math.round(b[2] * k);
    const h = Math.round(b[3] * k);
    if (x && x + LABEL + w > maxWidth) {
      x = 0;
      y += row + GAP;
      row = 0;
    }
    const inside = texts.filter((t) => { const cx = t[0] + t[2] / 2; const cy = t[1] + t[3] / 2; return cx >= b[0] && cx < b[0] + b[2] && cy >= b[1] && cy < b[1] + b[3]; });
    inside.sort((a, c) => (Math.abs(a[1] - c[1]) < Math.min(a[3], c[3]) * 0.5 ? a[0] - c[0] : a[1] - c[1]));
    pieces.push({ id: i + 1, box: b, at: [x + LABEL, y, w, h], ...(inside.length > 1 ? { parts: inside } : {}) });
    x += LABEL + w + GAP;
    row = Math.max(row, h, 28);
    width = Math.max(width, x - GAP);
  }
  return { width: Math.max(1, width), height: Math.max(1, y + row), pieces };
}

/** Draw the collage: white, each piece with its number in a grey box on its left and a thin frame. */
export async function drawCollage(backend: ImageBackend, image: TiledImage, plan: CollagePlan): Promise<{ jpeg: Uint8Array; width: number; height: number }> {
  const canvas = backend.createCanvas(plan.width, plan.height);
  const ctx = canvas.getContext('2d') as unknown as CanvasRenderingContext2D;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, plan.width, plan.height);
  for (const p of plan.pieces) {
    const [ax, ay, aw, ah] = p.at;
    ctx.save();
    ctx.translate(ax, ay);
    image.drawRegion(ctx as unknown as { drawImage: (...a: unknown[]) => void }, p.box[0], p.box[1], p.box[2], p.box[3], aw, ah);
    ctx.restore();
    ctx.strokeStyle = '#7a7a7a';
    ctx.lineWidth = 2;
    ctx.strokeRect(ax - 1, ay - 1, aw + 2, ah + 2);
    ctx.fillStyle = '#d9d9d9';
    ctx.fillRect(ax - LABEL + 2, ay, LABEL - 6, 28);
    ctx.fillStyle = '#000000';
    ctx.font = 'bold 18px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(p.id), ax - LABEL / 2 - 1, ay + 14);
  }
  try {
    return { jpeg: await backend.encode(canvas, 'image/jpeg', 0.9), width: plan.width, height: plan.height };
  } finally {
    releaseCanvas(canvas);
  }
}

/**
 * The model's answer names pieces by number: each block gets the box of its piece on the page
 * (0–1000 of the page), as if it had been read from the whole page. Blocks with no known number are dropped.
 */
export function withPieceBoxes(raw: string, pieces: CollagePiece[], width: number, height: number): string {
  const json = extractJson(raw, { repair: true });
  const arr = findBlocksArray(json);
  if (!arr) return raw;
  const byId = new Map(pieces.map((p) => [p.id, p]));
  const found = arr.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const b = item as Record<string, unknown>;
    const p = byId.get(Number(String(b.id ?? b.piece ?? b.n ?? '').replace(/\D/g, '')));
    return p ? [{ b, p }] : [];
  });
  const count = new Map<number, number>();
  for (const { p } of found) count.set(p.id, (count.get(p.id) ?? 0) + 1);
  const seen = new Map<number, number>();
  const blocks = found.map(({ b, p }) => {
    const k = seen.get(p.id) ?? 0;
    seen.set(p.id, k + 1);
    // As many texts as bubbles in the piece: one each, in reading order; otherwise the whole piece.
    const [x, y, w, h] = p.parts && p.parts.length > 1 && p.parts.length === count.get(p.id) ? p.parts[k] : p.box;
    return { ...b, box: [(x / width) * 1000, (y / height) * 1000, ((x + w) / width) * 1000, ((y + h) / height) * 1000] };
  });
  const rest = json && typeof json === 'object' && !Array.isArray(json) ? (json as Record<string, unknown>) : {};
  return JSON.stringify({ ...rest, blocks });
}
