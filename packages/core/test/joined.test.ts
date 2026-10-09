/* eslint-disable @typescript-eslint/no-explicit-any */
import { createCanvas } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import { configFromPreset } from '../src/llm/presets';
import { runStandalonePipeline } from '../src/pipeline/standalone';
import { ctxMeasurer, layoutBlock } from '../src/render/render';
import { DEFAULT_STYLE_DEFAULTS } from '../src/render/style';
import { DEFAULT_PROFILES } from '../src/translate/profiles';
import { mockOpenAi, napiBackend, toNorm } from './helpers';

const W = 900;
const H = 2600;

/** Two black bubbles drawn as one joined shape: one speech in the upper-right lobe, one in the lower-left. */
async function joined() {
  const c = createCanvas(W, H);
  const ctx = c.getContext('2d') as any;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#000000';
  ctx.beginPath();
  ctx.ellipse(560, 250, 280, 220, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(330, 580, 260, 210, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 34px TestSans';
  ctx.textAlign = 'center';
  ['I... COULDN’T', 'SENSE YOU UNTIL', 'JUST NOW.'].forEach((l, i) => ctx.fillText(l, 580, 180 + i * 42));
  ['I DIDN’T', 'KNOW YOU WERE', 'IN TROUBLE.'].forEach((l, i) => ctx.fillText(l, 300, 560 + i * 42));
  return new Uint8Array(await c.encode('png'));
}

describe('bubbles drawn joined together', () => {
  it('each speech stays in its own part of the shape', async () => {
    const bytes = await joined();
    const mock = mockOpenAi((_b, call) =>
  call > 1 ? JSON.stringify({ blocks: [], entities: [], summary: '' }) :
      JSON.stringify({
        blocks: [
          { box: toNorm([450, 145, 260, 130], W, H), text: 'I... COULDN’T SENSE YOU UNTIL JUST NOW.', translation: 'Я... НЕ ЧУВСТВОВАЛ ТЕБЯ ДО ЭТОГО МОМЕНТА.', type: 'DIALOGUE', vertical: false },
          { box: toNorm([180, 525, 250, 130], W, H), text: 'I DIDN’T KNOW YOU WERE IN TROUBLE.', translation: 'Я НЕ ЗНАЛ, ЧТО ТЕБЕ ПЛОХО.', type: 'DIALOGUE', vertical: false },
        ],
        entities: [],
        summary: '',
      }),
    );
    const out = await runStandalonePipeline(
      { bytes, config: { mode: 'standalone', privacy: 'local', sourceLang: 'en', targetLang: 'ru', quality: 'balanced', profile: DEFAULT_PROFILES[0], glossary: [], translateSfx: true, sfxStyle: 'translated', vision: { ...configFromPreset('lmstudio', 'vlm'), vision: true }, translator: null } as any },
      { backend: napiBackend, fetchImpl: mock.fetchImpl },
    );
    expect(out.page.blocks).toHaveLength(2);
    const m = ctxMeasurer(createCanvas(8, 8).getContext('2d') as any);
    const d = { ...DEFAULT_STYLE_DEFAULTS, dialogueFont: 'TestSans' };
    const centre = out.page.blocks.map((b) => {
      const l = layoutBlock(m, b, d, { width: W, height: H });
      const box = l.box ?? b.bubble!.safeArea;
      const ys = l.lines.map((x) => box[1] + x.y);
      return (Math.min(...ys) + Math.max(...ys)) / 2;
    });
    // Upper speech in the upper lobe, lower speech in the lower lobe (not both at the top).
    expect(centre[0]).toBeLessThan(400);
    expect(centre[1]).toBeGreaterThan(450);
  });

  it('one block read for both speeches is split between them', async () => {
    const bytes = await joined();
    for (const box of [[450, 145, 260, 130]] as [number, number, number, number][]) {
      const mock = mockOpenAi((_b, call) =>
  call > 1 ? JSON.stringify({ blocks: [], entities: [], summary: '' }) :
        JSON.stringify({
          blocks: [{ box: toNorm(box, W, H), text: 'I... COULDN’T SENSE YOU UNTIL JUST NOW. I DIDN’T KNOW YOU WERE IN TROUBLE.', translation: 'Я... не чувствовал тебя до этого момента. Я не знал, что тебе плохо.', type: 'DIALOGUE', vertical: false }],
          entities: [],
          summary: '',
        }),
      );
      const out = await runStandalonePipeline(
        { bytes, config: { mode: 'standalone', privacy: 'local', sourceLang: 'en', targetLang: 'ru', quality: 'balanced', profile: DEFAULT_PROFILES[0], glossary: [], translateSfx: true, sfxStyle: 'translated', vision: { ...configFromPreset('lmstudio', 'vlm'), vision: true }, translator: null } as any },
        { backend: napiBackend, fetchImpl: mock.fetchImpl },
      );
      if (process.env.SHOT) {
        const { renderOutput } = await import('../src/pipeline/run');
        const r = await renderOutput(napiBackend, out, { ...DEFAULT_STYLE_DEFAULTS, dialogueFont: 'TestSans' });
        (await import('node:fs')).writeFileSync(process.env.SHOT, r.tiles[0].bytes);
      }
      const texts = out.page.blocks.filter((b) => b.translatedText).sort((a, b) => a.bbox[1] - b.bbox[1]);
      expect(texts.map((b) => b.translatedText), `box ${box}: ${JSON.stringify(texts.map((b) => [b.translatedText, b.bbox]))}`).toEqual(['Я... не чувствовал тебя до этого момента.', 'Я не знал, что тебе плохо.']);
      expect(texts[0].bbox[1]).toBeLessThan(300);
      expect(texts[1].bbox[1]).toBeGreaterThan(450);
    }
  });
});
