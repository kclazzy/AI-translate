/* eslint-disable @typescript-eslint/no-explicit-any */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createCanvas } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import { configFromPreset } from '../src/llm/presets';
import { runStandalonePipeline } from '../src/pipeline/standalone';
import { renderOutput } from '../src/pipeline/run';
import { ctxMeasurer, layoutBlock } from '../src/render/render';
import { DEFAULT_STYLE_DEFAULTS } from '../src/render/style';
import { DEFAULT_PROFILES } from '../src/translate/profiles';
import type { Box } from '../src/types';
import { mockOpenAi, napiBackend, toNorm } from './helpers';

const OUT = new URL('../../../.test-output/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

/** Bubbles that are not ovals: a spiky shout, a thought cloud, a wavy box. */
const W = 900;
const H = 1300;
type Shape = { name: string; path: (ctx: any) => void; text: string[]; at: [number, number]; size: number; model: Box; ru: string };

const star = (cx: number, cy: number, rx: number, ry: number, n: number, k: number) => (ctx: any) => {
  ctx.beginPath();
  for (let i = 0; i <= n * 2; i++) {
    const a = (i / (n * 2)) * Math.PI * 2;
    const f = i % 2 ? k : 1;
    ctx.lineTo(cx + Math.cos(a) * rx * f, cy + Math.sin(a) * ry * f);
  }
  ctx.closePath();
};
const cloud = (cx: number, cy: number, rx: number, ry: number) => (ctx: any) => {
  ctx.beginPath();
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    ctx.moveTo(cx + Math.cos(a) * rx + 55, cy + Math.sin(a) * ry);
    ctx.arc(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry, 55, 0, Math.PI * 2);
  }
  ctx.moveTo(cx + rx, cy);
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
};
const wavy = (x: number, y: number, w: number, h: number) => (ctx: any) => {
  ctx.beginPath();
  for (let i = 0; i <= 40; i++) ctx.lineTo(x + (w * i) / 40, y + Math.sin(i) * 6);
  for (let i = 0; i <= 20; i++) ctx.lineTo(x + w + Math.sin(i) * 6, y + (h * i) / 20);
  for (let i = 40; i >= 0; i--) ctx.lineTo(x + (w * i) / 40, y + h + Math.sin(i) * 6);
  for (let i = 20; i >= 0; i--) ctx.lineTo(x + Math.sin(i) * 6, y + (h * i) / 20);
  ctx.closePath();
};

const SHAPES: Shape[] = [
  { name: 'spiky shout', path: star(300, 240, 260, 190, 14, 0.72), text: ['WHAT DID', 'YOU SAY?!'], at: [300, 200], size: 34, model: [200, 205, 200, 70], ru: 'ЧТО ТЫ СКАЗАЛ?!' },
  { name: 'thought cloud', path: cloud(560, 640, 230, 130), text: ['I SHOULD HAVE', 'TOLD HER', 'EARLIER...'], at: [560, 590], size: 28, model: [460, 590, 200, 90], ru: 'НАДО БЫЛО СКАЗАТЬ ЕЙ РАНЬШЕ...' },
  { name: 'wavy box', path: wavy(120, 940, 420, 230), text: ['THE NEXT MORNING,', 'AT THE ACADEMY'], at: [330, 1010], size: 30, model: [170, 1010, 320, 70], ru: 'НА СЛЕДУЮЩЕЕ УТРО, В АКАДЕМИИ' },
];

function draw(withText: boolean) {
  const c = createCanvas(W, H);
  const ctx = c.getContext('2d') as any;
  ctx.fillStyle = '#9aa7b8';
  ctx.fillRect(0, 0, W, H);
  let seed = 4;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 500; i++) {
    ctx.fillStyle = `rgb(${70 + rnd() * 120},${80 + rnd() * 110},${90 + rnd() * 120})`;
    ctx.beginPath();
    ctx.arc(rnd() * W, rnd() * H, 4 + rnd() * 18, 0, Math.PI * 2);
    ctx.fill();
  }
  for (const s of SHAPES) {
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#111111';
    ctx.lineWidth = 3;
    s.path(ctx);
    ctx.stroke();
    ctx.fill();
  }
  if (withText) {
    ctx.fillStyle = '#111111';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const s of SHAPES) {
      ctx.font = `bold ${s.size}px TestSans`;
      s.text.forEach((l, i) => ctx.fillText(l, s.at[0], s.at[1] + i * s.size * 1.15));
    }
  }
  return c;
}

describe('bubbles of unusual shape', () => {
  it('are cleaned and the translation follows their real outline', async () => {
    const withText = draw(true);
    const bytes = new Uint8Array(await withText.encode('png'));
    const mock = mockOpenAi(() =>
      JSON.stringify({ blocks: SHAPES.map((s) => ({ box: toNorm(s.model, W, H), text: s.text.join(' '), translation: s.ru, type: 'DIALOGUE', vertical: false })), entities: [], summary: '' }),
    );
    const out = await runStandalonePipeline(
      {
        bytes,
        config: {
          mode: 'standalone', privacy: 'local', sourceLang: 'en', targetLang: 'ru', quality: 'balanced', profile: DEFAULT_PROFILES[0], glossary: [], translateSfx: true, sfxStyle: 'translated',
          vision: { ...configFromPreset('lmstudio', 'vlm'), vision: true }, translator: null,
        },
      },
      { backend: napiBackend, fetchImpl: mock.fetchImpl },
    );
    const d = { ...DEFAULT_STYLE_DEFAULTS, dialogueFont: 'TestSans', narrationFont: 'TestSans', sfxFont: 'TestSans' };
    const rendered = await renderOutput(napiBackend, out, d);
    writeFileSync(`${OUT}shapes-rendered.png`, rendered.tiles[0].bytes);
    const clean = draw(false).getContext('2d') as any;
    const bg = clean.getImageData(0, 0, W, H).data as Uint8ClampedArray;
    const white = (x: number, y: number) => {
      const i = (Math.round(y) * W + Math.round(x)) * 4;
      return bg[i] > 235 && bg[i + 1] > 235 && bg[i + 2] > 235;
    };
    const measurer = ctxMeasurer(createCanvas(10, 10).getContext('2d') as any);
    expect(out.page.blocks).toHaveLength(SHAPES.length);
    for (const [i, b] of out.page.blocks.entries()) {
      expect(b.bubble?.rows, `${SHAPES[i].name}: outline found`).toBeTruthy();
      const l = layoutBlock(measurer, b, d, { width: W, height: H });
      const box = l.box ?? b.bubble!.safeArea;
      expect(l.overflow, `${SHAPES[i].name}: fits`).toBeFalsy();
      for (const line of l.lines) {
        const left = box[0] + line.x - line.width / 2;
        const right = left + line.width;
        const top = box[1] + line.y - l.fontSize * 0.8;
        const bottom = box[1] + line.y + l.fontSize * 0.2;
        // Every corner of every line lies inside the bubble, not on the outline or the art.
        for (const [x, y] of [[left, top], [right, top], [left, bottom], [right, bottom]]) expect(white(x, y), `${SHAPES[i].name}: «${line.text}» at ${Math.round(x)},${Math.round(y)}`).toBe(true);
      }
    }
  });

  it('a bubble the model did not report at all is found and translated', async () => {
    const withText = draw(true);
    const bytes = new Uint8Array(await withText.encode('png'));
    const reported = [SHAPES[0], SHAPES[2]];
    const mock = mockOpenAi((_b, call) =>
      call === 1
        ? JSON.stringify({ blocks: reported.map((s) => ({ box: toNorm(s.model, W, H), text: s.text.join(' '), translation: s.ru, type: 'DIALOGUE', vertical: false })), entities: [], summary: '' })
        : JSON.stringify({ blocks: [{ box: [100, 100, 900, 900], text: SHAPES[1].text.join(' '), translation: SHAPES[1].ru, type: 'DIALOGUE', vertical: false }], entities: [], summary: '' }),
    );
    const out = await runStandalonePipeline(
      {
        bytes,
        config: {
          mode: 'standalone', privacy: 'local', sourceLang: 'en', targetLang: 'ru', quality: 'balanced', profile: DEFAULT_PROFILES[0], glossary: [], translateSfx: true, sfxStyle: 'translated',
          vision: { ...configFromPreset('lmstudio', 'vlm'), vision: true }, translator: null,
        },
      },
      { backend: napiBackend, fetchImpl: mock.fetchImpl },
    );
    expect(mock.calls.length).toBe(2);
    expect(out.page.blocks.map((b) => b.translatedText)).toEqual([SHAPES[0].ru, SHAPES[1].ru, SHAPES[2].ru]);
    // The skipped bubble's lettering is gone from the cleaned page.
    const cl = out.cleaned.getRegion(400, 560, 320, 140).data;
    let dark = 0;
    for (let i = 0; i < cl.length; i += 4) if (cl[i] < 90 && cl[i + 1] < 90 && cl[i + 2] < 90) dark++;
    expect(dark).toBeLessThan(40);
  });
});
