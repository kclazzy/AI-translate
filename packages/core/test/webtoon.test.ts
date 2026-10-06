/* eslint-disable @typescript-eslint/no-explicit-any */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createCanvas } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import { cleanBlock } from '../src/image/clean';
import { TiledImage } from '../src/image/tiled';
import type { Box } from '../src/types';
import { DEFAULT_PROFILES } from '../src/translate/profiles';
import { configFromPreset } from '../src/llm/presets';
import { runStandalonePipeline } from '../src/pipeline/standalone';
import { renderOutput } from '../src/pipeline/run';
import { DEFAULT_STYLE_DEFAULTS } from '../src/render/style';
import { mockOpenAi, napiBackend, toNorm } from './helpers';

const OUT = new URL('../../../.test-output/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

/**
 * A Webtoons-style strip segment: dark painted background, borderless white bubbles,
 * a bubble cut off by the image edge, a coloured narration box and white text over art.
 * Each case also gives the box a small vision model would return: shifted and too tight.
 */
interface Case {
  name: string;
  draw: (ctx: any) => void;
  text: { lines: string[]; x: number; y: number; size: number; color: string; stroke?: string };
  modelBox: Box;
}

const W = 800;
const H = 1700;

function background(ctx: any) {
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#1d2433');
  g.addColorStop(0.5, '#3a2f4a');
  g.addColorStop(1, '#14161c');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  // Painted texture: soft blobs and streaks.
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 900; i++) {
    ctx.fillStyle = `rgba(${150 + rnd() * 100},${120 + rnd() * 80},${170 + rnd() * 80},${0.05 + rnd() * 0.12})`;
    ctx.beginPath();
    ctx.arc(rnd() * W, rnd() * H, 2 + rnd() * 18, 0, Math.PI * 2);
    ctx.fill();
  }
}

const CASES: Case[] = [
  {
    name: 'borderless white bubble, box shifted and tight',
    draw: (ctx) => {
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.ellipse(400, 200, 230, 110, 0, 0, Math.PI * 2);
      ctx.fill();
    },
    text: { lines: ['YOU THINK A SWORD', 'LIKE THAT CAN', 'STOP ME?!'], x: 400, y: 155, size: 30, color: '#111111' },
    modelBox: [300, 150, 190, 70],
  },
  {
    name: 'bubble cut off by the right edge',
    draw: (ctx) => {
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = '#222222';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.ellipse(700, 520, 220, 100, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    },
    text: { lines: ['THE STELLAR', 'SWORD ART...'], x: 650, y: 490, size: 30, color: '#111111' },
    modelBox: [560, 488, 150, 40],
  },
  {
    name: 'blue narration box with white text',
    draw: (ctx) => {
      ctx.fillStyle = '#1f3c88';
      ctx.fillRect(120, 800, 560, 120);
    },
    text: { lines: ['MEANWHILE, AT THE', 'NORTHERN FORTRESS'], x: 400, y: 830, size: 28, color: '#ffffff' },
    modelBox: [190, 835, 380, 50],
  },
  {
    name: 'white outlined text over the art',
    draw: () => undefined,
    text: { lines: ['HAH...', 'HAH...'], x: 260, y: 1150, size: 34, color: '#ffffff', stroke: '#000000' },
    modelBox: [210, 1150, 90, 50],
  },
  {
    name: 'rounded bubble, tall box missing the last line',
    draw: (ctx) => {
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.roundRect(420, 1340, 330, 230, 40);
      ctx.fill();
      ctx.stroke();
    },
    text: { lines: ['I WON’T', 'LET YOU', 'TOUCH HER.', 'NOT AGAIN.'], x: 585, y: 1375, size: 32, color: '#111111' },
    modelBox: [480, 1375, 210, 110],
  },
];

function drawText(ctx: any, t: Case['text']) {
  ctx.font = `bold ${t.size}px TestSans`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  t.lines.forEach((line, i) => {
    const y = t.y + i * t.size * 1.15;
    if (t.stroke) {
      ctx.lineWidth = 5;
      ctx.strokeStyle = t.stroke;
      ctx.strokeText(line, t.x, y);
    }
    ctx.fillStyle = t.color;
    ctx.fillText(line, t.x, y);
  });
}

async function render(withText: boolean): Promise<{ bytes: Uint8Array; canvas: any }> {
  const c = createCanvas(W, H);
  const ctx = c.getContext('2d') as any;
  background(ctx);
  for (const k of CASES) {
    k.draw(ctx);
    if (withText) drawText(ctx, k.text);
  }
  return { bytes: new Uint8Array(await c.encode('png')), canvas: c };
}

/** Pixels that belong to the original lettering (differ clearly between the two renders). */
function textPixels(a: Uint8ClampedArray, b: Uint8ClampedArray): Uint8Array {
  const m = new Uint8Array(W * H);
  for (let p = 0; p < W * H; p++) {
    const i = p * 4;
    const d = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    if (d > 150) m[p] = 1;
  }
  return m;
}

describe('webtoon pages: the original lettering is fully removed', () => {
  it('leaves no visible original text even when the model boxes are imprecise', async () => {
    const withText = await render(true);
    const clean = await render(false);
    const textCtx = withText.canvas.getContext('2d');
    const cleanCtx = clean.canvas.getContext('2d');
    const a = textCtx.getImageData(0, 0, W, H).data;
    const b = cleanCtx.getImageData(0, 0, W, H).data;
    const mask = textPixels(a, b);

    const image = await TiledImage.fromBytes(napiBackend, withText.bytes, 'image/png');
    for (const k of CASES) cleanBlock(image, k.modelBox);
    const out = image.getRegion(0, 0, W, H).data;
    const shot = createCanvas(W, H);
    const sctx = shot.getContext('2d') as any;
    const id = sctx.createImageData(W, H);
    id.data.set(out);
    sctx.putImageData(id, 0, 0);
    writeFileSync(`${OUT}webtoon-cleaned.png`, new Uint8Array(await shot.encode('png')));
    writeFileSync(`${OUT}webtoon-original.png`, withText.bytes);

    const report: string[] = [];
    for (const k of CASES) {
      // Count lettering pixels around this case that still look like the lettering.
      const [x0, y0] = [Math.max(0, k.text.x - 300), Math.max(0, k.text.y - 40)];
      const [x1, y1] = [Math.min(W, k.text.x + 300), Math.min(H, k.text.y + k.text.lines.length * k.text.size * 1.2 + 40)];
      let total = 0;
      let left = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const p = y * W + x;
          if (!mask[p]) continue;
          total++;
          const i = p * 4;
          const dText = Math.abs(out[i] - a[i]) + Math.abs(out[i + 1] - a[i + 1]) + Math.abs(out[i + 2] - a[i + 2]);
          const dBg = Math.abs(out[i] - b[i]) + Math.abs(out[i + 1] - b[i + 1]) + Math.abs(out[i + 2] - b[i + 2]);
          if (dText < dBg) left++;
        }
      }
      report.push(`${k.name}: ${left}/${total} (${((100 * left) / Math.max(1, total)).toFixed(1)}%)`);
    }
    console.log(report.join('\n'));
    for (const line of report) expect(Number(/\(([\d.]+)%\)/.exec(line)![1]), line).toBeLessThan(1);
  }, 60_000);

  it('typesets the translation over the place of the original, end to end', async () => {
    const { bytes } = await render(true);
    const ru = ['Думаешь, такой меч меня остановит?!', 'Звёздное искусство меча...', 'Тем временем в северной крепости', 'Ха... ха...', 'Я не дам тебе её тронуть. Больше никогда.'];
    const mock = mockOpenAi(() =>
      JSON.stringify({ blocks: CASES.map((k, i) => ({ box: toNorm(k.modelBox, W, H), text: k.text.lines.join(' '), translation: ru[i], type: i === 2 ? 'NARRATION' : 'DIALOGUE', vertical: false })), entities: [], summary: '' }),
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
    const rendered = await renderOutput(napiBackend, out, { ...DEFAULT_STYLE_DEFAULTS, dialogueFont: 'TestSans', narrationFont: 'TestSans', sfxFont: 'TestSans' });
    writeFileSync(`${OUT}webtoon-rendered.png`, rendered.tiles[0].bytes);
    expect(rendered.page.blocks).toHaveLength(5);
    // Every translation fits its place (no overflow) and sits where the original lettering was.
    for (const [i, b] of rendered.page.blocks.entries()) {
      expect(b.overflow, `${CASES[i].name}: overflow`).toBeFalsy();
      const t = CASES[i].text;
      const cy = t.y + (t.lines.length * t.size * 1.15) / 2;
      const area = b.bubble?.safeArea ?? b.bbox;
      expect(cy, `${CASES[i].name}: centre`).toBeGreaterThanOrEqual(area[1] - 10);
      expect(cy, `${CASES[i].name}: centre`).toBeLessThanOrEqual(area[1] + area[3] + 10);
    }
  }, 60_000);
});
