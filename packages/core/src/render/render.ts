/* eslint-disable @typescript-eslint/no-explicit-any */
import type { AnyCanvas, ImageBackend, ImageMime } from '../image/backend';
import type { TiledImage } from '../image/tiled';
import type { Box, TextBlock } from '../types';
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

export function layoutBlock(measurer: Measurer, block: TextBlock, d: StyleDefaults = DEFAULT_STYLE_DEFAULTS): LayoutResult {
  const first = layoutBlockIn(measurer, block, d, targetBox(block, d), block.textBox ? 'rect' : block.bubble?.shape ?? 'rect');
  if (!first.overflow || block.textBox || !block.bubble || block.style?.fontSize) return first;
  // Does not fit the safe area: use the whole bubble (as a box, a little inside its edge) and
  // smaller letters, rather than letting the text run out of the bubble.
  const bb = block.bubble.box;
  const inner: Box = [bb[0] + bb[2] * 0.12, bb[1] + bb[3] * 0.1, bb[2] * 0.76, bb[3] * 0.8];
  const second = layoutBlockIn(measurer, block, d, inner, 'rect', 6);
  return second.overflow ? first : { ...second, box: inner };
}

function layoutBlockIn(measurer: Measurer, block: TextBlock, d: StyleDefaults, box: Box, shape: 'rect' | 'ellipse', minSize?: number): LayoutResult {
  const style = resolveStyle(block, d);
  const cap = block.fontSizeEstimate > 0 ? Math.max(14, block.fontSizeEstimate * 1.3) : undefined;
  return layoutText(measurer, {
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
  });
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
  if (style.shadow) {
    ctx.shadowColor = 'rgba(0,0,0,0.45)';
    ctx.shadowBlur = layout.fontSize * 0.15;
    ctx.shadowOffsetX = layout.fontSize * 0.06;
    ctx.shadowOffsetY = layout.fontSize * 0.06;
  }
  const paint = (text: string, x: number, y: number) => {
    if (strokeW) {
      ctx.strokeStyle = style.strokeColor;
      ctx.lineWidth = strokeW * 2;
      ctx.strokeText(text, x, y);
    }
    ctx.fillStyle = style.color;
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
    const l = layoutBlock(measurer, b, d);
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
      const box = targetBox(b, d);
      // Draw blocks near this tile (text may slightly exceed its box).
      const margin = l.fontSize * 4;
      if (box[1] + box[3] + margin < t.y || box[1] - margin > t.y + t.h) continue;
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
