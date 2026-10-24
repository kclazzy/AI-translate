/* eslint-disable @typescript-eslint/no-explicit-any */
import { createCanvas } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import { runStandalonePipeline } from '../src/pipeline/standalone';
import { DEFAULT_PROFILES } from '../src/translate/profiles';
import { configFromPreset } from '../src/llm/presets';
import type { Box } from '../src/types';
import { mockOpenAi, napiBackend, toNorm } from './helpers';

// Three captions; the model reads only the first, the detector sees all three: the two it missed
// are read again in ONE request (a collage of their crops), not one request each — and not at all in «Быстро».
const W = 800;
const H = 800;
const TEXTS: { box: Box; text: string; ru: string }[] = [
  { box: [80, 80, 300, 50], text: 'FIRST LINE', ru: 'Первая' },
  { box: [380, 380, 300, 50], text: 'SECOND LINE', ru: 'Вторая' },
  { box: [120, 640, 300, 50], text: 'THIRD LINE', ru: 'Третья' },
];

async function page(): Promise<Uint8Array> {
  const c = createCanvas(W, H);
  const g = c.getContext('2d') as any;
  g.fillStyle = '#fff';
  g.fillRect(0, 0, W, H);
  g.fillStyle = '#111';
  g.font = 'bold 34px sans-serif';
  g.textBaseline = 'top';
  for (const t of TEXTS) g.fillText(t.text, t.box[0] + 6, t.box[1] + 8);
  return new Uint8Array(await c.encode('png'));
}

const detect = async (img: { width: number; height: number }) => ({
  boxes: TEXTS.map((t) => ({ box: [(t.box[0] * img.width) / W, (t.box[1] * img.height) / H, (t.box[2] * img.width) / W, (t.box[3] * img.height) / H] as Box, kind: 'text_free' as const, score: 0.9 })),
});

async function run(quality: 'fast' | 'balanced') {
  const mock = mockOpenAi((body, call) => {
    if (call === 1) return JSON.stringify({ blocks: [{ box: toNorm(TEXTS[0].box, W, H), text: TEXTS[0].text, translation: TEXTS[0].ru, type: 'NARRATION', vertical: false }], entities: [], summary: '' });
    // The collage of the two missed crops: one answer per piece.
    const prompt = JSON.stringify(body);
    expect(prompt).toMatch(/piece|кусоч|collage/i);
    return JSON.stringify({ blocks: [1, 2].map((id) => ({ id, text: TEXTS[id].text, translation: TEXTS[id].ru, type: 'NARRATION' })), entities: [], summary: '' });
  });
  const out = await runStandalonePipeline(
    {
      bytes: await page(),
      config: { mode: 'standalone', privacy: 'local', sourceLang: 'en', targetLang: 'ru', quality, profile: DEFAULT_PROFILES[0], glossary: [], translateSfx: true, sfxStyle: 'translated', vision: { ...configFromPreset('lmstudio', 'vlm'), vision: true }, translator: null, detector: true },
    },
    { backend: napiBackend, fetchImpl: mock.fetchImpl, detect: detect as any },
  );
  return { calls: mock.calls.length, texts: out.page.blocks.map((b) => b.translatedText) };
}

describe('text the model missed is read again in one request', () => {
  it('two missed texts: one extra request, both on the page', async () => {
    const r = await run('balanced');
    expect(r.calls).toBe(2);
    expect(r.texts.sort()).toEqual(['Вторая', 'Первая', 'Третья']);
  }, 60000);

  it('«Быстро»: no extra requests', async () => {
    const r = await run('fast');
    expect(r.calls).toBe(1);
  }, 60000);
});
