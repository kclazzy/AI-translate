// A white bubble on a dark page, read by the model with a box that reaches past the bubble onto the
// dark (Return of the Mad Demon 202): the dark page must not be taken for the bubble — before, its
// white was erased as «letters» and the translation drawn huge in white over the art.
import { createCanvas } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import { configFromPreset } from '../src/llm/presets';
import { runStandalonePipeline } from '../src/pipeline/standalone';
import { DEFAULT_PROFILES } from '../src/translate/profiles';
import { mockOpenAi, napiBackend, toNorm } from './helpers';

describe('a loose box around a white bubble on a dark page', () => {
  it('the bubble is the white oval, the text stays in it, nothing is split off', async () => {
    const W = 800;
    const H = 1280;
    const c = createCanvas(W, H);
    const ctx = c.getContext('2d') as any;
    ctx.fillStyle = '#060604';
    ctx.fillRect(0, 0, W, 360);
    ctx.fillStyle = '#4a3b2a';
    ctx.fillRect(0, 360, W, H - 360);
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.ellipse(265, 165, 200, 90, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#111';
    ctx.font = 'bold 30px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText("I'M SO ANGRY,", 265, 155);
    ctx.fillText('MASTER.', 265, 195);
    const bytes = new Uint8Array(await c.encode('png'));
    const mock = mockOpenAi(() => JSON.stringify({ blocks: [{ box: toNorm([82, 61, 347, 168], W, H), text: "I'M SO ANGRY, MASTER.", translation: 'Я так зол, Мастер!', type: 'DIALOGUE' }], entities: [], summary: '' }));
    const config: any = { mode: 'standalone', privacy: 'local', sourceLang: 'en', targetLang: 'ru', quality: 'balanced', profile: DEFAULT_PROFILES[0], glossary: [], translateSfx: true, sfxStyle: 'translated', vision: { ...configFromPreset('lmstudio', 'v'), vision: true }, translator: null };
    const out = await runStandalonePipeline({ bytes, config, noSkip: true }, { backend: napiBackend, fetchImpl: mock.fetchImpl });
    expect(out.page.blocks).toHaveLength(1);
    const b = out.page.blocks[0];
    expect(b.translatedText).toBe('Я так зол, Мастер!');
    expect(b.bubble?.fill.toLowerCase()).not.toBe('#060604');
    // The bubble is the oval (≈ 400×180), not the dark band across the page.
    expect(b.bubble!.box[2]).toBeLessThan(500);
    // The bubble's white is still there after cleaning.
    const px = out.cleaned.getRegion(150, 120, 230, 20).data;
    let light = 0;
    for (let i = 0; i < px.length; i += 4) if (px[i] > 200) light++;
    expect(light).toBeGreaterThan((px.length / 4) * 0.9);
  });
});

describe('the reading step answering with a translation (Mad Demon 202: «Гнев — это нормальная реакция.»)', () => {
  const setup = async () => {
    const W = 800;
    const H = 1280;
    const c = createCanvas(W, H);
    const ctx = c.getContext('2d') as any;
    ctx.fillStyle = '#20201c';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.ellipse(250, 220, 190, 90, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#111';
    ctx.font = 'bold 30px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('RAGE IS A', 250, 210);
    ctx.fillText('NORMAL RESPONSE.', 250, 250);
    return { bytes: new Uint8Array(await c.encode('png')), box: toNorm([120, 180, 260, 85], W, H) };
  };
  const config = (): any => ({
    mode: 'standalone', privacy: 'local', sourceLang: 'en', targetLang: 'ru', quality: 'balanced', profile: DEFAULT_PROFILES[0], glossary: [], translateSfx: true, sfxStyle: 'translated', onlySourceLang: true,
    vision: { ...configFromPreset('lmstudio', 'v'), id: 'v', vision: true }, translator: { ...configFromPreset('lmstudio', 't'), id: 't', model: 'text' },
  });
  const isText = (body: any) => body.messages.every((m: any) => typeof m.content === 'string');

  it('is asked again for the original, then translated as usual', async () => {
    const { bytes, box } = await setup();
    let reads = 0;
    const mock = mockOpenAi((body) => {
      if (isText(body)) return JSON.stringify({ translations: [{ id: 'b1', text: 'Гнев — нормальная реакция.' }] });
      reads++;
      return JSON.stringify({ blocks: [{ box, text: reads === 1 ? 'Гнев — это нормальная реакция.' : 'RAGE IS A NORMAL RESPONSE.', type: 'DIALOGUE' }] });
    });
    const out = await runStandalonePipeline({ bytes, config: config(), noSkip: true }, { backend: napiBackend, fetchImpl: mock.fetchImpl });
    expect(reads).toBe(2);
    expect(out.page.blocks.map((b) => [b.originalText, b.translatedText, b.translate])).toEqual([['RAGE IS A NORMAL RESPONSE.', 'Гнев — нормальная реакция.', true]]);
  });

  it('when the model insists, its translation is used (marked unsure), not left untranslated', async () => {
    const { bytes, box } = await setup();
    const mock = mockOpenAi((body) => (isText(body) ? JSON.stringify({ translations: [] }) : JSON.stringify({ blocks: [{ box, text: 'Гнев — это нормальная реакция.', type: 'DIALOGUE' }] })));
    const out = await runStandalonePipeline({ bytes, config: config(), noSkip: true }, { backend: napiBackend, fetchImpl: mock.fetchImpl });
    const b = out.page.blocks[0];
    expect(b.translate).toBe(true);
    expect(b.translatedText).toBe('Гнев — это нормальная реакция.');
    expect(b.lowConfidence).toBe(true);
  });
});
