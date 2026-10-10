/* eslint-disable @typescript-eslint/no-explicit-any */
import { createCanvas } from '@napi-rs/canvas';
import { mkdirSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { configFromPreset } from '../src/llm/presets';
import { runStandalonePipeline } from '../src/pipeline/standalone';
import { renderOutput } from '../src/pipeline/run';
import { ctxMeasurer, layoutBlock } from '../src/render/render';
import { DEFAULT_STYLE_DEFAULTS, resolveStyle } from '../src/render/style';
import { DEFAULT_PROFILES } from '../src/translate/profiles';
import { cleanBlock, luminance } from '../src/image/clean';
import { TiledImage } from '../src/image/tiled';
import { matchLettering } from '../src/pipeline/standalone';
import type { TextBlock } from '../src/types';
import { mockOpenAi, napiBackend, toNorm } from './helpers';

const OUT = new URL('../../../.test-output/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

type Spec = { W: number; H: number; cx: number; cy: number; rx: number; ry: number; lines: string[]; textTop: number; size: number };

/** Colourful art (blue sky, a character) with a round white bubble whose lower part runs off the picture. */
function page(s: Spec) {
  const c = createCanvas(s.W, s.H);
  const ctx = c.getContext('2d') as any;
  ctx.fillStyle = '#3b5bd6';
  ctx.fillRect(0, 0, s.W, s.H);
  ctx.fillStyle = '#6f8cf0';
  ctx.beginPath();
  ctx.ellipse(s.W * 0.35, s.H * 0.15, s.W * 0.45, s.H * 0.12, 0.2, 0, Math.PI * 2);
  ctx.fill();
  // A character: dark helmet, teal collar, light face.
  ctx.fillStyle = '#2a2a33';
  ctx.fillRect(s.W * 0.25, 0, s.W * 0.22, s.H * 0.3);
  ctx.fillStyle = '#3fd1b0';
  ctx.fillRect(s.W * 0.22, s.H * 0.28, s.W * 0.3, s.H * 0.06);
  ctx.fillStyle = '#d8d8ee';
  ctx.beginPath();
  ctx.arc(s.W * 0.36, s.H * 0.33, s.W * 0.05, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.ellipse(s.cx, s.cy, s.rx, s.ry, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = 4;
  ctx.strokeStyle = '#111111';
  ctx.stroke();
  ctx.fillStyle = '#151515';
  ctx.font = `bold ${s.size}px TestSans`;
  ctx.textAlign = 'center';
  let minX = Infinity, maxX = -Infinity;
  s.lines.forEach((l, i) => {
    const w = ctx.measureText(l).width;
    minX = Math.min(minX, s.cx - w / 2);
    maxX = Math.max(maxX, s.cx + w / 2);
    ctx.fillText(l, s.cx, s.textTop + s.size + i * s.size * 1.2);
  });
  const textBox: [number, number, number, number] = [Math.round(minX), s.textTop, Math.round(maxX - minX), Math.round(s.lines.length * s.size * 1.2)];
  const data = ctx.getImageData(0, 0, s.W, s.H).data as Uint8ClampedArray;
  return { canvas: c, data: new Uint8ClampedArray(data), textBox };
}

async function run(s: Spec, box: [number, number, number, number]) {
  const p = page(s);
  const bytes = new Uint8Array(await p.canvas.encode('png'));
  const mock = mockOpenAi((_b, call) =>
    call > 1
      ? JSON.stringify({ blocks: [], entities: [], summary: '' })
      : JSON.stringify({
          blocks: [{ box: toNorm(box, s.W, s.H), text: s.lines.join(' '), translation: 'ЧТО ОВЕРВОЧ СДЕЛАЛ ДЛЯ МЕНЯ, КОГДА Я ВПЕРВЫЕ ПРИШЛА НА ЗЕМЛЮ.', type: 'DIALOGUE', vertical: false }],
          entities: [],
          summary: '',
        }),
  );
  const out = await runStandalonePipeline(
    { bytes, config: { mode: 'standalone', privacy: 'local', sourceLang: 'en', targetLang: 'ru', quality: 'balanced', profile: DEFAULT_PROFILES[0], glossary: [], translateSfx: true, sfxStyle: 'translated', vision: { ...configFromPreset('lmstudio', 'vlm'), vision: true }, translator: null } as any },
    { backend: napiBackend, fetchImpl: mock.fetchImpl },
  );
  return { p, out };
}

/** Art pixels (well outside the ellipse) changed by cleaning. */
function artChanged(s: Spec, before: Uint8ClampedArray, after: Uint8ClampedArray, margin = 6): number {
  let n = 0;
  for (let y = 0; y < s.H; y++) {
    for (let x = 0; x < s.W; x++) {
      const nx = (x - s.cx) / (s.rx + margin);
      const ny = (y - s.cy) / (s.ry + margin);
      if (nx * nx + ny * ny <= 1) continue;
      const i = (y * s.W + x) * 4;
      if (Math.abs(before[i] - after[i]) + Math.abs(before[i + 1] - after[i + 1]) + Math.abs(before[i + 2] - after[i + 2]) > 30) n++;
    }
  }
  return n;
}

const CASES: { name: string; s: Spec; box?: 'tight' | 'loose' | 'bubble' | 'art' }[] = [
  { name: 'cut by the bottom edge', s: { W: 507, H: 340, cx: 255, cy: 300, rx: 250, ry: 160, lines: ['WHAT OVERWATCH DID FOR', 'ME WHEN I FIRST', 'CAME TO EARTH.'], textTop: 200, size: 24 } },
  { name: 'cut by the bottom edge, loose model box', s: { W: 507, H: 340, cx: 255, cy: 300, rx: 250, ry: 160, lines: ['WHAT OVERWATCH DID FOR', 'ME WHEN I FIRST', 'CAME TO EARTH.'], textTop: 200, size: 24 }, box: 'loose' },
  { name: 'cut by the bottom edge, box = whole bubble', s: { W: 507, H: 340, cx: 255, cy: 300, rx: 250, ry: 160, lines: ['WHAT OVERWATCH DID FOR', 'ME WHEN I FIRST', 'CAME TO EARTH.'], textTop: 200, size: 24 }, box: 'bubble' },
  { name: 'model box reaching into the art above', s: { W: 507, H: 340, cx: 255, cy: 300, rx: 250, ry: 160, lines: ['WHAT OVERWATCH DID FOR', 'ME WHEN I FIRST', 'CAME TO EARTH.'], textTop: 200, size: 24 }, box: 'art' },
  { name: 'bubble crossing the bottom of a tall strip piece', s: { W: 700, H: 1300, cx: 350, cy: 1230, rx: 300, ry: 170, lines: ['WHAT OVERWATCH DID FOR', 'ME WHEN I FIRST', 'CAME TO EARTH.'], textTop: 1120, size: 28 } },
  // The lower half of a bubble the site cut: the top edge of the picture closes it.
  { name: 'cut by the top edge, loose model box', s: { W: 507, H: 340, cx: 255, cy: 30, rx: 250, ry: 160, lines: ['WHAT OVERWATCH DID FOR', 'ME WHEN I FIRST', 'CAME TO EARTH.'], textTop: 20, size: 24 }, box: 'loose' },
];

describe('round bubble cut by the edge of the picture over colourful art', () => {
  for (const c of CASES) {
    it(c.name, async () => {
      const s = c.s;
      const tb = page(s).textBox;
      const box: [number, number, number, number] =
        c.box === 'loose' ? [tb[0] - 30, tb[1] - 40, tb[2] + 60, tb[3] + 60] : c.box === 'art' ? [tb[0] - 30, 60, tb[2] + 60, tb[1] + tb[3] + 10 - 60] : c.box === 'bubble' ? [s.cx - s.rx + 10, s.cy - s.ry + 10, s.rx * 2 - 20, s.H - (s.cy - s.ry) - 10] : [tb[0] - 4, tb[1] - 4, tb[2] + 8, tb[3] + 8];
      const { p, out } = await run(s, box);
      const after = out.cleaned.getRegion(0, 0, s.W, s.H).data;
      const slug = c.name.replace(/[^a-z]+/gi, '-');
      const shot = createCanvas(s.W, s.H);
      const sctx = shot.getContext('2d') as any;
      const id = sctx.createImageData(s.W, s.H);
      id.data.set(after);
      sctx.putImageData(id, 0, 0);
      writeFileSync(`${OUT}cutbubble-${slug}-cleaned.png`, new Uint8Array(await shot.encode('png')));
      const d = { ...DEFAULT_STYLE_DEFAULTS, dialogueFont: 'TestSans' };
      const rendered = await renderOutput(napiBackend, out, d);
      writeFileSync(`${OUT}cutbubble-${slug}-rendered.png`, rendered.tiles[0].bytes);
      // Nothing of the art outside the bubble is painted over.
      expect(artChanged(s, p.data, after)).toBeLessThan(150);
      // The lettering is gone.
      let dark = 0;
      for (let y = tb[1]; y < tb[1] + tb[3]; y++) for (let x = tb[0]; x < tb[0] + tb[2]; x++) if (luminance(after[(y * s.W + x) * 4], after[(y * s.W + x) * 4 + 1], after[(y * s.W + x) * 4 + 2]) < 90) dark++;
      expect(dark).toBeLessThan(20);
      // Dark letters on the white bubble: the translation is dark, without a thick light/dark outline.
      const b = out.page.blocks[0];
      const st = resolveStyle(b, d);
      expect(luminance(...(st.color.match(/[0-9a-f]{2}/gi)!.map((h) => parseInt(h, 16)) as [number, number, number]))).toBeLessThan(100);
      const l = layoutBlock(ctxMeasurer(createCanvas(8, 8).getContext('2d') as any), b, d, { width: s.W, height: s.H });
      const strokePx = st.strokeColor && st.strokeWidth > 0 ? (st.strokeWidth * l.fontSize) / 18 : 0;
      expect(strokePx).toBeLessThanOrEqual(l.fontSize * 0.12);
      // The text stays inside the visible part of the bubble.
      const lb = l.box ?? b.bubble!.safeArea;
      for (const line of l.lines) {
        const y = lb[1] + line.y - l.fontSize * 0.4;
        const half = line.width / 2;
        for (const x of [lb[0] + line.x - half, lb[0] + line.x + half]) {
          const nx = (x - s.cx) / s.rx;
          const ny = (y - s.cy) / s.ry;
          expect(nx * nx + ny * ny).toBeLessThan(1);
        }
        expect(lb[1] + line.y - l.fontSize).toBeGreaterThan(s.cy - s.ry);
      }
    });
  }
});

describe('round bubble across the seam between two tiles of a glued strip chunk', () => {
  it('is erased inside its outline only, and cut by the bottom of the chunk', async () => {
    // TILE_HEIGHT = 4096: the bubble and its lettering cross the seam between the two tiles.
    const s: Spec = { W: 700, H: 4300, cx: 350, cy: 4130, rx: 300, ry: 175, lines: ['WHAT OVERWATCH DID FOR', 'ME WHEN I FIRST', 'CAME TO EARTH.'], textTop: 4030, size: 28 };
    const p = page(s);
    const img = await TiledImage.fromBytes(napiBackend, new Uint8Array(await p.canvas.encode('png')), 'image/png');
    expect(img.tiles.length).toBe(2);
    const tb = p.textBox;
    for (const box of [[tb[0] - 30, tb[1] - 40, tb[2] + 60, tb[3] + 60], [tb[0] - 30, s.cy - s.ry - 70, tb[2] + 60, tb[1] + tb[3] - (s.cy - s.ry - 70) + 10]] as [number, number, number, number][]) {
      const copy = img.clone();
      const r = cleanBlock(copy, box);
      expect(r.closed).toBe(true);
      expect(r.lettering?.outline).toBeUndefined();
      const after = copy.getRegion(0, 0, s.W, s.H).data;
      expect(artChanged(s, p.data, after)).toBeLessThan(150);
      const block = { originalText: s.lines.join(' '), textType: 'DIALOGUE', bubble: r.bubble } as unknown as TextBlock;
      const style = matchLettering(block, r.lettering);
      expect(style.strokeWidth ?? 0).toBe(0);
      expect(resolveStyle({ ...block, style } as TextBlock).strokeWidth).toBe(0);
    }
  });
});

describe('outlined lettering is matched only when there really is an outline', () => {
  it('a "fill" in the colour of a light bubble gives plain dark text, not light letters on dark plates', () => {
    const block = { originalText: 'WHAT', textType: 'DIALOGUE', bubble: { box: [0, 0, 100, 100], fill: '#ffffff', safeArea: [0, 0, 100, 100], shape: 'rect' } } as unknown as TextBlock;
    const style = matchLettering(block, { color: '#ffffff', stroke: 40, letterHeight: 60, colorShare: 0.4, fill: '#fefefe', outline: '#333333' });
    expect(style.color).toBeUndefined();
    expect(style.strokeColor).toBeUndefined();
    expect(resolveStyle({ ...block, style } as TextBlock).color).toBe('#111111');
  });
  it('a real outline stays thin in proportion to the letters', () => {
    const block = { originalText: 'STOP', textType: 'DIALOGUE', bubble: null } as unknown as TextBlock;
    const style = matchLettering(block, { color: '#000000', stroke: 20, letterHeight: 40, colorShare: 0.4, fill: '#ffffff', outline: '#000000' });
    expect(style.strokeColor).toBe('#000000');
    // drawBlock: outline px = strokeWidth × fontSize / 18.
    expect(style.strokeWidth! / 18).toBeLessThanOrEqual(0.12);
  });
});
