import { describe, expect, it } from 'vitest';
import { configFromPreset, OpenAICompatibleProvider } from '../src';
import { isAllCaps, matchLettering, mergeSharedBubbles, separateAreas } from '../src/pipeline/standalone';
import { qaPage, qaSummary, ruleChecks } from '../src/translate/qa';
import type { Box, TextBlock } from '../src/types';
import { jsonResponse } from './helpers';

function block(id: string, original: string, translated: string, over: Partial<TextBlock> = {}): TextBlock {
  const bbox: Box = [0, 0, 100, 40];
  return {
    id,
    textType: 'DIALOGUE',
    originalText: original,
    translatedText: translated,
    confidence: 0.9,
    language: 'en',
    bbox,
    polygon: [],
    orientation: 0,
    writingDirection: 'ltr',
    fontSizeEstimate: 20,
    bubble: null,
    translate: true,
    ...over,
  } as TextBlock;
}

describe('rule checks', () => {
  it('finds untranslated text, lost question marks, numbers and glossary terms', () => {
    const glossary = [{ id: 'g', source: 'Stellar', target: 'Звёздный', matchMode: 'exact' as const, caseSensitive: false, forbidden: [], enabled: true }];
    expect(ruleChecks(block('a', 'Where are you going?', 'Куда ты идёшь.'), 'ru', []).map((i) => i.kind)).toContain('punctuation');
    expect(ruleChecks(block('b', 'どこへ行くの', 'どこへ行くの'), 'ru', []).map((i) => i.kind)).toContain('untranslated');
    expect(ruleChecks(block('c', 'I have 3 swords', 'У меня пять мечей'), 'ru', []).map((i) => i.kind)).toContain('formatting');
    expect(ruleChecks(block('d', 'The Stellar sword', 'Звёздный меч'), 'ru', glossary)).toEqual([]);
    expect(ruleChecks(block('e', 'The Stellar sword', 'Звёздочный меч'), 'ru', glossary).map((i) => i.kind)).toContain('terminology');
  });
});

describe('semantic review', () => {
  const answer = (content: string) => new OpenAICompatibleProvider({ ...configFromPreset('lmstudio', 'x'), vision: true }, async () => jsonResponse({ choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5 }, model: 'm' }));
  const review = JSON.stringify({
    reviews: [
      { id: 'b1', ok: true },
      { id: 'b2', ok: false, issues: [{ kind: 'meaning', severity: 'major', note: 'Смысл перевёрнут: он не хочет уходить.' }], fix: 'Я не уйду!' },
    ],
  });
  it('fixes real meaning errors and keeps a report', async () => {
    const blocks = [block('b1', 'Hello', 'Привет'), block('b2', "I won't leave!", 'Я уйду!')];
    const usage = await qaPage(blocks, { provider: answer(review), mode: 'fix', targetLang: 'ru', glossary: [] });
    expect(usage).toHaveLength(1);
    expect(blocks[1].translatedText).toBe('Я не уйду!');
    expect(blocks[1].qa).toMatchObject({ before: 'Я уйду!', reviewed: true });
    expect(blocks[1].qa!.issues[0]).toMatchObject({ kind: 'meaning', severity: 'major', by: 'review' });
    expect(qaSummary(blocks)).toEqual({ checked: 2, issues: 1, fixed: 1, major: 1 });
  });
  it('only reports in report mode, and never fails the page when the review fails', async () => {
    const blocks = [block('b1', 'Hello', 'Привет'), block('b2', "I won't leave!", 'Я уйду!')];
    await qaPage(blocks, { provider: answer(review), mode: 'report', targetLang: 'ru', glossary: [] });
    expect(blocks[1].translatedText).toBe('Я уйду!');
    expect(blocks[1].qa!.issues).toHaveLength(1);
    const broken = new OpenAICompatibleProvider(configFromPreset('lmstudio', 'x'), async () => new Response('', { status: 500 }));
    const b2 = [block('b1', 'Hello', 'Привет')];
    await expect(qaPage(b2, { provider: broken, mode: 'fix', targetLang: 'ru', glossary: [] })).resolves.toEqual([]);
    expect(b2[0].qa).toMatchObject({ reviewed: false });
  });
});

describe('layout of several blocks', () => {
  it('joins blocks that share one bubble so their translations do not overlap', () => {
    const bubble = { box: [10, 10, 300, 200] as Box, fill: '#ffffff', safeArea: [40, 30, 240, 160] as Box, shape: 'ellipse' as const };
    const a = block('b1', 'I DIDN’T EXPECT', 'Я не ожидал,', { bbox: [60, 40, 200, 40], bubble: { ...bubble } });
    const b = block('b2', 'HIM TO COME BACK', 'что он вернётся.', { bbox: [60, 100, 200, 40], bubble: { ...bubble, safeArea: [...bubble.safeArea] as Box } });
    const c = block('b3', 'OTHER', 'Другое', { bbox: [400, 400, 80, 30], bubble: { box: [380, 380, 120, 70], fill: '#ffffff', safeArea: [390, 390, 100, 50], shape: 'rect' } });
    const out = mergeSharedBubbles([b, a, c], new Map([['b1', true], ['b2', true], ['b3', true]]));
    expect(out).toHaveLength(2);
    expect(out[0].translatedText).toBe('Я не ожидал, что он вернётся.');
    expect(out[0].bbox).toEqual([60, 40, 200, 100]);
  });
  it('splits overlapping text areas of neighbouring blocks', () => {
    const a = block('b1', 'A', 'А', { bubble: { box: [0, 0, 200, 120], fill: '#fff', safeArea: [10, 10, 180, 100], shape: 'rect' } });
    const b = block('b2', 'B', 'Б', { bubble: { box: [0, 80, 200, 120], fill: '#fff', safeArea: [10, 90, 180, 100], shape: 'rect' } });
    separateAreas([a, b]);
    const s1 = a.bubble!.safeArea;
    const s2 = b.bubble!.safeArea;
    expect(s1[1] + s1[3]).toBeLessThanOrEqual(s2[1]);
  });
});

describe('matching the original lettering', () => {
  it('keeps capitals, weight and coloured lettering', () => {
    expect(isAllCaps('YOU THINK A SWORD LIKE THAT CAN STOP ME?!')).toBe(true);
    expect(isAllCaps('You think so?')).toBe(false);
    const narration = block('n', 'MEANWHILE', 'Тем временем', { textType: 'NARRATION', bubble: { box: [0, 0, 1, 1], fill: '#1f3c88', safeArea: [0, 0, 1, 1], shape: 'rect' } });
    expect(matchLettering(narration, { color: '#ffffff', stroke: 5, letterHeight: 24 })).toMatchObject({ uppercase: true, bold: true, color: '#ffffff', strokeColor: null });
    const thin = block('t', 'well...', 'ну...', { bubble: { box: [0, 0, 1, 1], fill: '#ffffff', safeArea: [0, 0, 1, 1], shape: 'ellipse' } });
    expect(matchLettering(thin, { color: '#111111', stroke: 2, letterHeight: 24 })).toEqual({ color: '#111111', strokeColor: null, strokeWidth: 0 });
  });
});
