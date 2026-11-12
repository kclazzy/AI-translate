/* eslint-disable @typescript-eslint/no-explicit-any */
import { createCanvas } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import { configFromPreset } from '../src/llm/presets';
import { runStandalonePipeline } from '../src/pipeline/standalone';
import { DEFAULT_PROFILES } from '../src/translate/profiles';
import { ctxMeasurer, layoutBlock } from '../src/render/render';
import { DEFAULT_STYLE_DEFAULTS } from '../src/render/style';
import { mockOpenAi, napiBackend, toNorm } from './helpers';

const W = 800;
const H = 700;
const SIZE = 36;
type Box = [number, number, number, number];

/** Two speech bubbles: a one-word remark and three lines, both lettered at the same size. */
function page() {
  const c = createCanvas(W, H);
  const ctx = c.getContext('2d') as any;
  ctx.fillStyle = '#d8dde6';
  ctx.fillRect(0, 0, W, H);
  const bubble = (cx: number, cy: number, rx: number, ry: number) => {
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#000000';
    ctx.stroke();
  };
  bubble(220, 180, 150, 100);
  bubble(520, 480, 230, 150);
  ctx.fillStyle = '#000000';
  ctx.font = `bold ${SIZE}px TestSans`;
  ctx.textAlign = 'center';
  ctx.fillText('STOP!', 220, 193);
  ['IS IT STRICTLY', 'NECESSARY TO', 'GO THERE NOW?'].forEach((l, i) => ctx.fillText(l, 520, 450 + i * 44));
  return c;
}

describe('a short remark in a bubble', () => {
  it('is set about as large as the original lettering, like longer speech', async () => {
    const short: Box = [165, 160, 110, 40];
    const long: Box = [360, 415, 320, 130];
    const mock = mockOpenAi((_b, call) =>
      call > 1
        ? JSON.stringify({ blocks: [], entities: [], summary: '' })
        : JSON.stringify({
            blocks: [
              { box: toNorm(short, W, H), text: 'STOP!', translation: 'Стоп!', type: 'DIALOGUE' },
              { box: toNorm(long, W, H), text: 'IS IT STRICTLY NECESSARY TO GO THERE NOW?', translation: 'Так уж нужно идти туда сейчас?', type: 'DIALOGUE' },
            ],
            entities: [],
            summary: '',
          }),
    );
    const out = await runStandalonePipeline(
      { bytes: new Uint8Array(await page().encode('png')), config: { mode: 'standalone', privacy: 'local', sourceLang: 'en', targetLang: 'ru', quality: 'balanced', profile: DEFAULT_PROFILES[0], glossary: [], translateSfx: false, vision: { ...configFromPreset('lmstudio', 'vlm'), vision: true }, translator: null } as any },
      { backend: napiBackend, fetchImpl: mock.fetchImpl },
    );
    const measurer = ctxMeasurer(createCanvas(10, 10).getContext('2d') as any);
    const d = { ...DEFAULT_STYLE_DEFAULTS, dialogueFont: 'TestSans', narrationFont: 'TestSans', sfxFont: 'TestSans' };
    const size = (text: string) => layoutBlock(measurer, out.page.blocks.find((b) => b.translatedText === text)!, d, { width: W, height: H }).fontSize;
    // The remark: not shrunk below the original's size (it was drawn at about 0.7 of it), not blown up.
    expect(size('Стоп!')).toBeGreaterThanOrEqual(SIZE * 0.9);
    expect(size('Стоп!')).toBeLessThanOrEqual(SIZE * 1.1);
    expect(size('Так уж нужно идти туда сейчас?')).toBeLessThanOrEqual(SIZE * 1.25);
  });
});
