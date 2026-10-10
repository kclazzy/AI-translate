/* eslint-disable @typescript-eslint/no-explicit-any */
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import { configFromPreset } from '../src/llm/presets';
import { runStandalonePipeline } from '../src/pipeline/standalone';
import { renderOutput } from '../src/pipeline/run';
import { ctxMeasurer, layoutBlock, minReadableSize } from '../src/render/render';
import { DEFAULT_STYLE_DEFAULTS, resolveStyle } from '../src/render/style';
import { DEFAULT_PROFILES } from '../src/translate/profiles';
import { luminance, parseHex } from '../src/image/clean';
import { mockOpenAi, napiBackend, toNorm } from './helpers';

type Box = [number, number, number, number];
const W = 900;
const H = 700;
// The bubble: white oval, cut on the left by the page's white gutter it touches.
const E = { cx: 330, cy: 200, rx: 318, ry: 172 };
const MARGIN = 22;

/**
 * A webtoon panel like the reported one: black sky, dark art below, a white oval with a glowing,
 * broken, spiky blue border whose left side runs into the white gutter of the page.
 */
async function page(lines: string[], size = 34, drawText = true) {
  const c = createCanvas(W, H);
  const ctx = c.getContext('2d') as any;
  ctx.fillStyle = '#050508';
  ctx.fillRect(0, 0, W, H);
  // Dark art below the bubble: a bluish cloud and a figure.
  ctx.fillStyle = '#1c1b2a';
  ctx.beginPath();
  ctx.ellipse(520, 560, 380, 120, 0.1, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#3a2f3f';
  ctx.fillRect(600, 430, 90, 270);
  ctx.fillStyle = '#7d6a78';
  ctx.beginPath();
  ctx.arc(645, 420, 36, 0, Math.PI * 2);
  ctx.fill();
  // The page's white gutter.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, MARGIN, H);
  // Glow around the bubble.
  ctx.save();
  ctx.shadowColor = '#7fb2ff';
  ctx.shadowBlur = 18;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.ellipse(E.cx, E.cy, E.rx, E.ry, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  // Broken blue border: arcs with gaps.
  ctx.strokeStyle = '#2f5fc8';
  ctx.lineWidth = 9;
  for (let a = 0; a < Math.PI * 2; a += Math.PI / 6) {
    ctx.beginPath();
    ctx.ellipse(E.cx, E.cy, E.rx - 3, E.ry - 3, 0, a, a + Math.PI / 9);
    ctx.stroke();
  }
  // Spikes (chevrons) along the lower edge, pointing in.
  ctx.fillStyle = '#2a50b0';
  for (let a = Math.PI * 0.15; a < Math.PI * 0.85; a += Math.PI / 40) {
    const x = E.cx + Math.cos(a) * (E.rx - 4);
    const y = E.cy + Math.sin(a) * (E.ry - 4);
    const ix = E.cx + Math.cos(a) * (E.rx - 26);
    const iy = E.cy + Math.sin(a) * (E.ry - 22);
    ctx.beginPath();
    ctx.moveTo(x - 5, y);
    ctx.lineTo(ix, iy);
    ctx.lineTo(x + 5, y);
    ctx.fill();
  }
  let text: Box = [0, 0, 0, 0];
  if (drawText) {
    ctx.fillStyle = '#0a0a0a';
    ctx.font = `bold ${size}px TestSans`;
    ctx.textAlign = 'center';
    let minX = Infinity, maxX = -Infinity;
    const top = E.cy - (lines.length * size * 1.2) / 2;
    lines.forEach((l, i) => {
      const w = ctx.measureText(l).width;
      minX = Math.min(minX, E.cx - w / 2);
      maxX = Math.max(maxX, E.cx + w / 2);
      ctx.fillText(l, E.cx, top + size + i * size * 1.2);
    });
    text = [Math.round(minX), Math.round(top), Math.round(maxX - minX), Math.round(lines.length * size * 1.2 + size * 0.3)];
  }
  const data = new Uint8ClampedArray(ctx.getImageData(0, 0, W, H).data);
  return { bytes: new Uint8Array(await c.encode('png')), data, text };
}

async function pixels(bytes: Uint8Array): Promise<Uint8ClampedArray> {
  const img = await loadImage(Buffer.from(bytes));
  const c = createCanvas(W, H);
  const ctx = c.getContext('2d') as any;
  ctx.drawImage(img, 0, 0);
  return new Uint8ClampedArray(ctx.getImageData(0, 0, W, H).data);
}

async function run(bytes: Uint8Array, box: Box, text: string, translation: string) {
  const mock = mockOpenAi((_b, call) =>
    call > 1 ? JSON.stringify({ blocks: [], entities: [], summary: '' }) : JSON.stringify({ blocks: [{ box: toNorm(box, W, H), text, translation, type: 'DIALOGUE', vertical: false }], entities: [], summary: '' }),
  );
  return runStandalonePipeline(
    { bytes, noSkip: true, config: { mode: 'standalone', privacy: 'local', sourceLang: 'en', targetLang: 'ru', quality: 'balanced', profile: DEFAULT_PROFILES[0], glossary: [], translateSfx: true, sfxStyle: 'translated', vision: { ...configFromPreset('lmstudio', 'vlm'), vision: true }, translator: null } as any },
    { backend: napiBackend, fetchImpl: mock.fetchImpl },
  );
}

/** Pixels away from the bubble (and its glow) that differ between two pictures. */
function artChanged(a: Uint8ClampedArray, b: Uint8ClampedArray, margin = 30): number {
  let n = 0;
  for (let y = 0; y < H; y++) {
    for (let x = MARGIN + 2; x < W; x++) {
      const nx = (x - E.cx) / (E.rx + margin);
      const ny = (y - E.cy) / (E.ry + margin);
      if (nx * nx + ny * ny <= 1) continue;
      const i = (y * W + x) * 4;
      if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 40) n++;
    }
  }
  return n;
}

const insideOval = (x: number, y: number, shrink = 0) => ((x - E.cx) / (E.rx - shrink)) ** 2 + ((y - E.cy) / (E.ry - shrink)) ** 2 <= 1;

const LINES = ['WE GAVE THOSE RIFTS A', 'NAME: DUNGEON.'];
const SRC = 'WE GAVE THOSE RIFTS A NAME: DUNGEON.';
const RU = 'МЫ ДАЛИ ЭТИМ РАЗРЫВАМ НАЗВАНИЕ: ПОДЗЕМЕЛЬЯ.';

describe('a bubble with a glowing, broken, spiky border on a black page', () => {
  const boxes: Record<string, (t: Box) => Box> = {
    'tight box': (t) => t,
    'loose box': (t) => [t[0] - 50, t[1] - 45, t[2] + 100, t[3] + 90],
    'box = whole bubble': () => [E.cx - E.rx, E.cy - E.ry, E.rx * 2, E.ry * 2],
    'box put below the bubble, over the dark art': () => [30, 420, 860, 220],
  };
  for (const [name, boxOf] of Object.entries(boxes)) {
    it(`${name}: the original is erased and the translation goes inside the oval, dark and readable`, async () => {
      const p = await page(LINES);
      const out = await run(p.bytes, boxOf(p.text), SRC, RU);
      expect(out.page.blocks).toHaveLength(1);
      const b = out.page.blocks[0];
      // The bubble's inside is known (not just the model's box).
      expect(b.bubble).toBeTruthy();
      expect(!!b.bubble!.rows || b.bubble!.shape === 'ellipse').toBe(true);
      expect(b.bubble!.box[2]).toBeGreaterThan(E.rx * 1.6);
      expect(b.bubble!.box[3]).toBeGreaterThan(E.ry * 1.6);
      expect(b.lowConfidence).toBeFalsy();
      // The original letters are gone.
      const cleaned = await pixels(new Uint8Array(await (out.cleaned.tiles[0].canvas as any).encode('png')));
      let dark = 0;
      for (let y = p.text[1]; y < p.text[1] + p.text[3]; y++) for (let x = p.text[0]; x < p.text[0] + p.text[2]; x++) if (luminance(cleaned[(y * W + x) * 4], cleaned[(y * W + x) * 4 + 1], cleaned[(y * W + x) * 4 + 2]) < 120) dark++;
      expect(dark).toBeLessThan(20);
      // Nothing outside the bubble changed while cleaning…
      expect(artChanged(p.data, cleaned)).toBe(0);
      // …dark letters, no halo, big enough, every line inside the oval…
      const d = { ...DEFAULT_STYLE_DEFAULTS, dialogueFont: 'TestSans' };
      const style = resolveStyle(b, d);
      expect(luminance(...parseHex(style.color))).toBeLessThan(100);
      expect(style.strokeWidth === 0 || !style.strokeColor).toBe(true);
      const m = ctxMeasurer(createCanvas(8, 8).getContext('2d') as any);
      const l = layoutBlock(m, b, d, { width: W, height: H });
      expect(l.overflow).toBe(false);
      expect(l.fontSize).toBeGreaterThanOrEqual(minReadableSize(W));
      const lb = l.box ?? b.bubble!.safeArea;
      for (const line of l.lines) {
        const y = lb[1] + line.y;
        const x0 = lb[0] + line.x - line.width / 2;
        const x1 = lb[0] + line.x + line.width / 2;
        for (const [x, yy] of [[x0, y], [x1, y], [x0, y - l.fontSize * 0.7], [x1, y - l.fontSize * 0.7]]) expect(insideOval(x, yy, 4) || x < MARGIN + 4).toBe(true);
      }
      // …and the rendered page leaves the art alone too.
      const r = await renderOutput(napiBackend, out, d);
      expect(artChanged(p.data, await pixels(r.tiles[0].bytes))).toBe(0);
    });
  }

  it('a box over the art with no lettering anywhere: nothing is erased, no big light letters', async () => {
    const p = await page(LINES, 34, false);
    const box: Box = [30, 420, 860, 220];
    const out = await run(p.bytes, box, SRC, RU);
    const b = out.page.blocks[0];
    expect(b.lowConfidence).toBe(true);
    const d = { ...DEFAULT_STYLE_DEFAULTS, dialogueFont: 'TestSans' };
    const style = resolveStyle(b, d);
    expect(luminance(...parseHex(style.color))).toBeLessThan(100);
    const cleaned = await pixels(new Uint8Array(await (out.cleaned.tiles[0].canvas as any).encode('png')));
    expect(artChanged(p.data, cleaned, 0)).toBe(0);
    const m = ctxMeasurer(createCanvas(8, 8).getContext('2d') as any);
    const l = layoutBlock(m, b, d, { width: W, height: H });
    expect(l.fontSize).toBeLessThanOrEqual(Math.round(W * 0.022 * 1.3) + 1);
  });

  it('a tight box on short lettering with a long translation: the text uses the oval, not the tiny box', async () => {
    const p = await page(['WHAT?!'], 20);
    const out = await run(p.bytes, p.text, 'WHAT?!', 'ЧТО?! ТЫ ХОЧЕШЬ СКАЗАТЬ, ЧТО ЭТО ПОДЗЕМЕЛЬЕ?!');
    const b = out.page.blocks[0];
    const d = { ...DEFAULT_STYLE_DEFAULTS, dialogueFont: 'TestSans' };
    const m = ctxMeasurer(createCanvas(8, 8).getContext('2d') as any);
    const l = layoutBlock(m, b, d, { width: W, height: H });
    expect(l.overflow).toBe(false);
    expect(l.fontSize).toBeGreaterThanOrEqual(minReadableSize(W));
    // Even when the text is pinned to the tight box of the letters, the known inside is used.
    const pinned = layoutBlock(m, { ...b, textBox: p.text }, d, { width: W, height: H });
    expect(pinned.fontSize).toBeGreaterThanOrEqual(minReadableSize(W));
    expect(pinned.overflow).toBe(false);
  });

  it('text that truly cannot be readable in its place is flagged for the editor', () => {
    const m = ctxMeasurer(createCanvas(8, 8).getContext('2d') as any);
    const d = { ...DEFAULT_STYLE_DEFAULTS, dialogueFont: 'TestSans' };
    const b: any = { id: 'b1', textType: 'DIALOGUE', originalText: 'HI', translatedText: 'ОЧЕНЬ ДЛИННЫЙ ПЕРЕВОД КОРОТКОЙ РЕПЛИКИ, КОТОРЫЙ НЕ ПОМЕСТИТСЯ', confidence: 1, language: 'en', bbox: [100, 100, 60, 24], polygon: [], orientation: 0, writingDirection: 'ltr', fontSizeEstimate: 16, bubble: { box: [96, 96, 68, 32], fill: '#ffffff', safeArea: [98, 98, 64, 28], shape: 'rect' }, translate: true };
    const l = layoutBlock(m, b, d, { width: 1200, height: 1600 });
    expect(l.fontSize).toBeLessThan(minReadableSize(1200));
    expect(l.overflow).toBe(true);
  });
});
