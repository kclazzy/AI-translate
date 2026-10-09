/* eslint-disable @typescript-eslint/no-explicit-any */
import type { AnyCanvas, ImageBackend, ImageMime } from '../image/backend';
import type { TiledImage } from '../image/tiled';
import type { Box, BubbleRows, TextBlock } from '../types';
import { layoutText, type LayoutResult, type Measurer } from '../typeset/layout';
import { resolveStyle, targetBox, type StyleDefaults, DEFAULT_STYLE_DEFAULTS } from './style';

export function ctxMeasurer(ctx: any): Measurer {
  const cache = new Map<string, number>();
  return {
    measure(text: string, font: string) {
      const key = font + '\u0000' + text;
      const hit = cache.get(key);
      if (hit !== undefined) return hit;
      ctx.font = font;
      const w = ctx.measureText(text).width as number;
      cache.set(key, w);
      return w;
    },
  };
}

export function shouldDraw(block: TextBlock, d: StyleDefaults): boolean {
  if (!block.translate || !block.translatedText.trim()) return false;
  if (block.textType === 'SFX' && d.sfxStyle === 'original') return false;
  return true;
}

/** The text as it is drawn (capitals when the original lettering is all caps). */
export function displayText(block: TextBlock, d: StyleDefaults = DEFAULT_STYLE_DEFAULTS): string {
  const style = resolveStyle(block, d);
  return style.uppercase ? block.translatedText.toLocaleUpperCase(d.targetLang) : block.translatedText;
}

export function layoutBlock(measurer: Measurer, block: TextBlock, d: StyleDefaults = DEFAULT_STYLE_DEFAULTS, page?: { width: number; height: number }): LayoutResult {
  const l = layoutBlockRaw(measurer, block, d);
  return page ? keepInsidePage(l, l.box ?? targetBox(block, d), page) : l;
}

/**
 * Text must never be drawn outside the picture: a bubble cut by the top edge with a long
 * translation would otherwise push its first line above the image, where it is cut off.
 */
export function keepInsidePage(l: LayoutResult, box: Box, page: { width: number; height: number }, margin = 2): LayoutResult {
  if (l.vertical || !l.lines.length) return l;
  const top = box[1] + Math.min(...l.lines.map((x) => x.y)) - l.fontSize * 0.95;
  const bottom = box[1] + Math.max(...l.lines.map((x) => x.y)) + l.fontSize * 0.3;
  let dy = 0;
  if (top < margin) dy = margin - top;
  else if (bottom > page.height - margin) dy = Math.max(margin - top, page.height - margin - bottom);
  const half = (w: number) => (l.alignment === 'center' ? w / 2 : 0);
  const left = box[0] + Math.min(...l.lines.map((x) => x.x - (l.alignment === 'right' ? x.width : half(x.width))));
  const right = box[0] + Math.max(...l.lines.map((x) => x.x + (l.alignment === 'left' ? x.width : half(x.width))));
  let dx = 0;
  if (left < margin) dx = margin - left;
  else if (right > page.width - margin) dx = Math.max(margin - left, page.width - margin - right);
  if (!dx && !dy) return l;
  return { ...l, lines: l.lines.map((x) => ({ ...x, x: x.x + dx, y: x.y + dy })) };
}

function layoutBlockRaw(measurer: Measurer, block: TextBlock, d: StyleDefaults): LayoutResult {
  const first = layoutBlockIn(measurer, block, d, targetBox(block, d), block.textBox ? 'rect' : block.bubble?.shape ?? 'rect');
  if (!first.overflow || block.textBox || !block.bubble || block.style?.fontSize) return first;
  // Does not fit the safe area: use the whole bubble (as a box, a little inside its edge) and
  // smaller letters, rather than letting the text run out of the bubble.
  const bb = block.bubble.box;
  const inner: Box = [bb[0] + bb[2] * 0.12, bb[1] + bb[3] * 0.1, bb[2] * 0.76, bb[3] * 0.8];
  const second = layoutBlockIn(measurer, block, d, inner, 'rect', 6);
  return second.overflow ? first : { ...second, box: inner };
}

/** Free span of a bubble's real outline for a band of rows of `box`, a little inside its edge. */
export function spansFromRows(rows: BubbleRows, box: Box, pad: number): (top: number, bottom: number) => [number, number] | null {
  return (top, bottom) => {
    const a = Math.max(0, Math.floor((box[1] + top - rows.y) / rows.step));
    const b = Math.min(rows.l.length - 1, Math.ceil((box[1] + bottom - rows.y) / rows.step));
    if (b < a) return null;
    let l = -Infinity;
    let r = Infinity;
    for (let i = a; i <= b; i++) {
      l = Math.max(l, rows.l[i]);
      r = Math.min(r, rows.r[i]);
    }
    if (r - l <= pad * 2) return null;
    return [l + pad - box[0], r - pad - box[0]];
  };
}

/** Letter spacing widens every measured run by (letters − 1) × spacing × font size. */
function spaced(m: Measurer, spacing: number | undefined): Measurer {
  if (!spacing) return m;
  return {
    measure(text, font) {
      const size = Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? 16);
      return m.measure(text, font) + Math.max(0, [...text].length - 1) * spacing * size;
    },
  };
}

function layoutBlockIn(measurer: Measurer, block: TextBlock, d: StyleDefaults, box: Box, shape: 'rect' | 'ellipse', minSize?: number): LayoutResult {
  const style = resolveStyle(block, d);
  measurer = spaced(measurer, style.letterSpacing);
  const rows = !block.textBox && block.bubble?.rows && !style.vertical ? block.bubble.rows : undefined;
  const pad = Math.max(3, (block.bubble?.box[2] ?? 0) * 0.06);
  // «Размер шрифта перевода» in the settings: all automatic sizes scaled (a size set by hand stays).
  const scale = Math.max(0.5, Math.min(2, d.fontScale ?? 1));
  const cap = block.fontSizeEstimate > 0 ? Math.max(14, block.fontSizeEstimate * 1.3) * Math.max(1, scale) : undefined;
  const input = {
    text: displayText(block, d),
    minSize,
    box,
    shape,
    fontFamily: style.fontFamily,
    bold: style.bold,
    italic: style.italic,
    fontSize: style.fontSize,
    maxSize: block.textType === 'SFX' ? undefined : cap,
    lineHeight: style.lineHeight,
    vertical: style.vertical,
    alignment: style.alignment,
    lang: d.targetLang,
    spans: rows ? spansFromRows(rows, box, pad) : undefined,
  };
  const l = layoutText(measurer, input);
  // Smaller than fits: the same layout at a fixed, scaled-down size.
  if (scale < 1 && style.fontSize == null && !l.overflow) return layoutText(measurer, { ...input, fontSize: Math.max(6, Math.round(l.fontSize * scale)) });
  return l;
}

/** Draw the translated text of one block. `offsetY` shifts page coordinates into a tile. */
export function drawBlock(ctx: any, block: TextBlock, layout: LayoutResult, d: StyleDefaults, offsetY = 0): void {
  const style = resolveStyle(block, d);
  const box = layout.box ?? targetBox(block, d);
  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, style.opacity));
  const cx = box[0] + box[2] / 2;
  const cy = box[1] + box[3] / 2 - offsetY;
  ctx.translate(cx, cy);
  if (style.rotation) ctx.rotate((style.rotation * Math.PI) / 180);
  ctx.translate(-box[2] / 2, -box[3] / 2);
  ctx.font = layout.font;
  ctx.textBaseline = 'alphabetic';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;
  const strokeW = style.strokeColor && style.strokeWidth > 0 ? Math.max(1, (style.strokeWidth * layout.fontSize) / 18) : 0;
  if (style.letterSpacing && 'letterSpacing' in ctx) ctx.letterSpacing = `${(style.letterSpacing * layout.fontSize).toFixed(2)}px`;
  if (style.shadow) {
    ctx.shadowColor = 'rgba(0,0,0,0.45)';
    ctx.shadowBlur = layout.fontSize * 0.15;
    ctx.shadowOffsetX = layout.fontSize * 0.06;
    ctx.shadowOffsetY = layout.fontSize * 0.06;
  }
  // Gradient fill: from the colour at the top of the text to the second colour at its bottom.
  let fill: unknown = style.color;
  if (style.gradient) {
    const ys = layout.vertical ? layout.glyphs.map((g) => g.y) : layout.lines.map((l) => l.y);
    const top = Math.min(...ys) - layout.fontSize * 0.85;
    const bottom = Math.max(...ys) + layout.fontSize * 0.2;
    if (Number.isFinite(top) && Number.isFinite(bottom) && bottom > top) {
      const g = ctx.createLinearGradient(0, top, 0, bottom);
      g.addColorStop(0, style.color);
      g.addColorStop(1, style.gradient);
      fill = g;
    }
  }
  const glowW = style.glow ? Math.max(1, ((style.glowSize ?? 6) * layout.fontSize) / 18) : 0;
  const paint = (text: string, x: number, y: number) => {
    if (glowW) {
      // Glow: a soft blurred halo of the glow colour under the letters.
      ctx.save();
      ctx.shadowColor = style.glow;
      ctx.shadowBlur = glowW * 2;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 0;
      ctx.strokeStyle = style.glow;
      ctx.lineWidth = glowW;
      ctx.strokeText(text, x, y);
      ctx.restore();
    }
    if (strokeW) {
      ctx.strokeStyle = style.strokeColor;
      ctx.lineWidth = strokeW * 2;
      ctx.strokeText(text, x, y);
    }
    ctx.fillStyle = fill;
    ctx.fillText(text, x, y);
  };
  if (layout.vertical) {
    ctx.textAlign = 'center';
    for (const g of layout.glyphs) paint(g.ch, g.x, g.y);
  } else {
    ctx.textAlign = layout.alignment;
    for (const line of layout.lines) paint(line.text, line.x, line.y);
  }
  ctx.restore();
}

/** Render cleaned image + translated text into new tiles. Returns per-block layouts (for overflow flags). */
export function renderTiles(backend: ImageBackend, cleaned: TiledImage, blocks: TextBlock[], d: StyleDefaults = DEFAULT_STYLE_DEFAULTS): { tiles: { y: number; h: number; canvas: AnyCanvas }[]; overflow: Set<string> } {
  const measureCanvas = backend.createCanvas(8, 8);
  const measurer = ctxMeasurer(measureCanvas.getContext('2d'));
  const layouts = new Map<string, LayoutResult>();
  const overflow = new Set<string>();
  for (const b of blocks) {
    if (!shouldDraw(b, d)) continue;
    const l = layoutBlock(measurer, b, d, { width: cleaned.width, height: cleaned.height });
    layouts.set(b.id, l);
    if (l.overflow) overflow.add(b.id);
  }
  const tiles = cleaned.tiles.map((t) => {
    const canvas = backend.createCanvas(cleaned.width, t.h);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(t.canvas, 0, 0);
    for (const b of blocks) {
      const l = layouts.get(b.id);
      if (!l) continue;
      // Draw blocks whose letters reach this tile (overflowing text can run well past its box).
      const box = l.box ?? targetBox(b, d);
      const ys = l.vertical ? l.glyphs.map((g) => g.y) : l.lines.map((x) => x.y);
      const top = box[1] + Math.min(0, ...ys) - l.fontSize * 1.5;
      const bottom = box[1] + Math.max(box[3], ...ys) + l.fontSize * 1.5;
      if (bottom < t.y || top > t.y + t.h) continue;
      drawBlock(ctx, b, l, d, t.y);
    }
    return { y: t.y, h: t.h, canvas };
  });
  return { tiles, overflow };
}

export async function encodeTiles(backend: ImageBackend, tiles: { y: number; h: number; canvas: AnyCanvas }[], mime: ImageMime = 'image/png', quality?: number): Promise<{ y: number; h: number; bytes: Uint8Array }[]> {
  const out: { y: number; h: number; bytes: Uint8Array }[] = [];
  for (const t of tiles) out.push({ y: t.y, h: t.h, bytes: await backend.encode(t.canvas, mime, quality) });
  return out;
}
