// Duplicates and text in the wrong place (audit D1, D3, D5, D6): one bubble read twice, the
// previous page's lines echoed onto a dark page, a sound effect merged into speech, a status
// window losing its rows.
import { createCanvas } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import { configFromPreset } from '../src/llm/presets';
import type { PipelineConfig } from '../src/pipeline/config';
import { dedupeReads, dropRepeatedParts, echoesContext, sameText } from '../src/pipeline/dupes';
import { mergeSharedBubbles, planViews, runStandalonePipeline, wanted } from '../src/pipeline/standalone';
import { emptyContext, mergeContext } from '../src/translate/context';
import { DEFAULT_PROFILES } from '../src/translate/profiles';
import type { TextBlock } from '../src/types';
import { mockOpenAi, napiBackend, toNorm } from './helpers';

function config(over: Partial<PipelineConfig> = {}): PipelineConfig {
  return {
    mode: 'standalone', privacy: 'local', sourceLang: 'en', targetLang: 'ru', quality: 'balanced',
    profile: DEFAULT_PROFILES[0], glossary: [], translateSfx: true, sfxStyle: 'translated',
    vision: { ...configFromPreset('lmstudio', 'vlm'), model: 'qwen3.5:9b', vision: true },
    translator: null, ...over,
  } as PipelineConfig;
}
const W = 800;
const norm = (box: [number, number, number, number], view: { y: number; h: number }) => toNorm([box[0], box[1] - view.y, box[2], box[3]], W, view.h);

describe('same text', () => {
  it('nearly the same words, or a part of them; short exclamations only when equal', () => {
    expect(sameText('THAT STAND IN OUR WAY', 'That stand in our way!')).toBe(true);
    expect(sameText('THAT STAND IN OUR WAY', 'IN OUR WAY')).toBe(true);
    expect(sameText('Ah', 'Ah!')).toBe(true);
    expect(sameText('Ah', 'Oh')).toBe(false);
    expect(sameText('Where are you going?', 'I am going home now.')).toBe(false);
  });

  it('an echo of an earlier page is the same line, not a shared phrase', () => {
    const prev = [{ src: 'RIGHT...', dst: 'РАЙТ...' }, { src: 'You will kneel before me', dst: 'Ты преклонишься передо мной' }];
    expect(echoesContext('RIGHT...', prev)).toBe(true);
    expect(echoesContext('ТЫ ПРЕКЛОНИШЬСЯ ПЕРЕДО МНОЙ', prev)).toBe(true);
    expect(echoesContext('You will never kneel', prev)).toBe(false);
  });

  it('views: a shifted copy with other words is one text; rows of a table in one view stay', () => {
    const v1 = { y: 0, h: 1600 };
    const v2 = { y: 800, h: 1600 };
    const out = dedupeReads([
      { box: [290, 1415, 220, 90], text: 'THAT STAND IN OUR WAY', view: v1 },
      { box: [290, 1465, 220, 90], text: 'that stand in our way.', view: v2 },
    ], 2400);
    expect(out).toHaveLength(1);
    const rows = dedupeReads([
      { box: [300, 300, 200, 40], text: 'ATTACK +5%', view: v1 },
      { box: [300, 330, 200, 40], text: 'DEFENSE +3%', view: v1 },
    ]);
    expect(rows).toHaveLength(2);
    // The copy cut by the view's edge loses to the whole one.
    const cut = dedupeReads([
      { box: [290, 1560, 220, 40], text: 'THAT STAND', view: v1 },
      { box: [290, 1560, 220, 90], text: 'THAT STAND IN OUR WAY', view: v2 },
    ], 2400);
    expect(cut.map((c) => c.text)).toEqual(['THAT STAND IN OUR WAY']);
  });

  it('parts of one bubble saying the same thing are said once', () => {
    const parts = [{ originalText: 'THAT STAND IN OUR WAY', translatedText: 'ВСТАЮЩИЕ НА НАШ ПУТЬ' }, { originalText: 'IN OUR WAY', translatedText: 'на нашем пути' }, { originalText: 'GO!', translatedText: 'Вперёд!' }];
    expect(dropRepeatedParts(parts).map((p) => p.translatedText)).toEqual(['ВСТАЮЩИЕ НА НАШ ПУТЬ', 'Вперёд!']);
  });
});

describe('the page', () => {
  it('D1: one bubble read in two overlapping views with a drifted box → one block, said once', async () => {
    const H = 2400;
    const views = planViews(W, H);
    expect(views.length).toBeGreaterThan(1);
    const c = createCanvas(W, H);
    const ctx = c.getContext('2d') as any;
    ctx.fillStyle = '#c9d3df';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#111';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.ellipse(400, 1460, 250, 120, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#111';
    ctx.font = 'bold 34px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('THAT STAND', 400, 1445);
    ctx.fillText('IN OUR WAY', 400, 1495);
    const bytes = new Uint8Array(await c.encode('png'));
    const truth: [number, number, number, number] = [290, 1415, 220, 90];
    const shifted: [number, number, number, number] = [290, 1465, 220, 90];
    const mock = mockOpenAi((_b, call) => {
      const v = views[call - 1];
      if (!v || v.y + v.h < 1500 || v.y > 1415) return JSON.stringify({ blocks: [], entities: [], summary: '' });
      const first = call === 1 || views[call - 2].y + views[call - 2].h < 1500;
      return JSON.stringify({ blocks: [{ box: norm(first ? truth : shifted, v), text: 'THAT STAND IN OUR WAY', translation: first ? 'ВСТАЮЩИЕ НА НАШ ПУТЬ' : 'встающие у нас на пути.', type: 'DIALOGUE' }], entities: [], summary: '' });
    });
    const out = await runStandalonePipeline({ bytes, config: config(), noSkip: true }, { backend: napiBackend, fetchImpl: mock.fetchImpl });
    const said = out.page.blocks.filter((b) => b.translate).map((b) => b.translatedText);
    expect(said).toHaveLength(1);
    expect(said[0]).not.toMatch(/ПУТЬ.*пути|пути.*ПУТЬ/i);
  });

  it('D3: lines of the previous page echoed onto a dark page with no lettering are not drawn and not learned again', async () => {
    const H = 1100;
    const c = createCanvas(W, H);
    const ctx = c.getContext('2d') as any;
    ctx.fillStyle = '#06101a';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#c9a27e';
    ctx.beginPath();
    ctx.ellipse(400, 600, 140, 180, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#dfefff';
    for (let i = 0; i < 25; i++) {
      ctx.beginPath();
      ctx.arc(250 + ((i * 37) % 300), 300 + ((i * 53) % 200), 6 + (i % 4), 0, Math.PI * 2);
      ctx.fill();
    }
    const bytes = new Uint8Array(await c.encode('png'));
    const context = mergeContext(emptyContext('s'), { lines: [{ src: 'RIGHT...', dst: 'РАЙТ...' }, { src: 'YOU WILL KNEEL BEFORE ME', dst: 'ТЫ ПРЕКЛОНИШЬСЯ ПЕРЕДО МНОЙ' }] });
    const mock = mockOpenAi(() =>
      JSON.stringify({
        blocks: [
          { box: [300, 250, 700, 330], text: 'RIGHT...', translation: 'РАЙТ...', type: 'DIALOGUE' },
          { box: [330, 500, 670, 600], text: 'YOU WILL KNEEL BEFORE ME', translation: 'ТЫ ПРЕКЛОНИШЬСЯ ПЕРЕДО МНОЙ', type: 'DIALOGUE' },
        ],
        entities: [],
        summary: '',
      }),
    );
    const out = await runStandalonePipeline({ bytes, config: config(), context, noSkip: true }, { backend: napiBackend, fetchImpl: mock.fetchImpl });
    expect(out.page.blocks).toHaveLength(0);
    expect(out.contextUpdate?.lines ?? []).toHaveLength(0);
    // The art is untouched (no smudge, no plate).
    const orig = c.getContext('2d').getImageData(0, 0, W, H).data;
    let changed = 0;
    for (const t of out.cleaned.tiles) {
      const d = t.canvas.getContext('2d').getImageData(0, 0, W, t.h).data;
      for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - orig[t.y * W * 4 + i]) > 30) changed++;
    }
    expect(changed).toBe(0);
  });

  it('D5: a sound effect above a speech bubble keeps its own block and type', () => {
    const mk = (id: string, type: TextBlock['textType'], y: number, bubble: [number, number, number, number], tr: string): TextBlock => ({
      id, textType: type, originalText: tr, translatedText: tr, confidence: 1, language: 'en', bbox: [300, y, 200, 40], polygon: [], orientation: 0, writingDirection: 'ltr', fontSizeEstimate: 30,
      bubble: { box: bubble, fill: '#ffffff', safeArea: bubble, shape: 'rect' }, translate: true,
    });
    const out = mergeSharedBubbles([mk('b1', 'SFX', 300, [290, 290, 220, 60], 'СТИСК'), mk('b2', 'DIALOGUE', 352, [250, 280, 300, 200], 'Я НЕ СДАМСЯ')], new Map([['b1', false], ['b2', true]]));
    expect(out.map((b) => [b.textType, b.translatedText])).toEqual([['SFX', 'СТИСК'], ['DIALOGUE', 'Я НЕ СДАМСЯ']]);
  });

  it('D6: a status window and its rows → its text once, translated (a row left in English is asked again)', async () => {
    const H = 1000;
    const c = createCanvas(W, H);
    const ctx = c.getContext('2d') as any;
    ctx.fillStyle = '#0d1b2a';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 30px sans-serif';
    ctx.fillText('[STATUS]', 300, 300);
    ctx.fillText('ATTACK +5%', 300, 360);
    ctx.fillText('DEFENSE +3%', 300, 420);
    const bytes = new Uint8Array(await c.encode('png'));
    const view = { y: 0, h: H };
    const mock = mockOpenAi((body) => {
      const user = JSON.stringify(body.messages);
      // The text-only re-ask of a block left in English.
      if (body.messages.every((m: { content: unknown }) => typeof m.content === 'string')) return JSON.stringify({ translations: [...user.matchAll(/\\"id\\":\\"(b\d+)\\"/g)].map((m) => ({ id: m[1], text: 'ЗАЩИТА +3%' })) });
      return JSON.stringify({
        blocks: [
          { box: norm([290, 395, 220, 40], view), text: 'DEFENSE +3%', type: 'NARRATION' },
          { box: norm([290, 330, 200, 40], view), text: 'ATTACK +5%', translation: 'АТАКА +5%', type: 'NARRATION' },
        ],
        entities: [],
        summary: '',
      });
    });
    const out = await runStandalonePipeline({ bytes, config: config(), noSkip: true }, { backend: napiBackend, fetchImpl: mock.fetchImpl });
    const texts = out.page.blocks.filter((b) => b.translate).map((b) => b.translatedText);
    expect(texts).toContain('АТАКА +5%');
    expect(texts).toContain('ЗАЩИТА +3%');
    expect(texts.filter((t) => /[A-Z]{3}/.test(t))).toHaveLength(0);
  });

  it('«Только баблы»: one rule for the page, the re-reads and the detector\'s free text', () => {
    const c = { bubblesOnly: true, onlySourceLang: true, sourceLang: 'ja' } as const;
    expect(wanted(c, 'DIALOGUE', 'こんにちは')).toBe(true);
    expect(wanted(c, 'SIGN', 'こんにちは')).toBe(false);
    expect(wanted(c, 'DIALOGUE', 'こんにちは', 'text_free')).toBe(false);
    expect(wanted(c, 'NARRATION', 'こんにちは', 'text_free')).toBe(true);
    expect(wanted(c, 'DIALOGUE', 'Hello')).toBe(false);
    expect(wanted({ sourceLang: 'ja' }, 'SFX', 'ドン')).toBe(true);
  });
});
