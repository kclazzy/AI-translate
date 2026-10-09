/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from 'vitest';
import { configFromPreset, crossCheckPage, machineTranslate, runCrossCheck, similarity, DEFAULT_PROFILES } from '../src';
import { jsonResponse } from './helpers';

const block = (id: string, original: string, translated: string): any => ({ id, textType: 'DIALOGUE', originalText: original, translatedText: translated, confidence: 1, language: 'en', bbox: [0, 0, 10, 10], polygon: [], orientation: 0, writingDirection: 'ltr', fontSizeEstimate: 20, bubble: null, translate: true });

/** Fake DeepL / Google / Yandex / LibreTranslate / judge model. */
function services(log: string[]) {
  return async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    log.push(url);
    if (url.includes('deepl.com')) {
      expect((init?.headers as any).authorization).toBe('DeepL-Auth-Key k:fx');
      return jsonResponse({ translations: body.text.map((t: string) => ({ text: t === 'I will not go.' ? 'Я не пойду.' : 'Привет.' })) });
    }
    if (url.includes('googleapis.com')) return jsonResponse({ data: { translations: body.q.map((t: string) => ({ translatedText: t === 'I will not go.' ? 'Я не пойду.' : 'Привет!' })) } });
    if (url.includes('yandex.net')) return jsonResponse({ translations: body.texts.map(() => ({ text: 'Я' })) });
    if (url.includes(':5000/translate')) return jsonResponse({ translatedText: body.q.map(() => 'Локально') });
    // The judge: our "Я пойду." lost the negation.
    return jsonResponse({ choices: [{ message: { content: JSON.stringify({ checks: [{ id: 'b1', ok: true }, { id: 'b2', ok: false, note: 'Потеряно отрицание.', better: 'Я не пойду.' }] }) } }], usage: { prompt_tokens: 10, completion_tokens: 10 } });
  };
}

describe('«Сверка» with other translators', () => {
  it('asks each service in its own format', async () => {
    const log: string[] = [];
    const f = services(log) as any;
    expect(await machineTranslate({ id: 'd', kind: 'deepl', enabled: true }, 'k:fx', ['I will not go.'], 'en', 'ru', f)).toEqual(['Я не пойду.']);
    expect(await machineTranslate({ id: 'g', kind: 'google', enabled: true }, 'gk', ['Hi.'], 'auto', 'ru', f)).toEqual(['Привет!']);
    expect(await machineTranslate({ id: 'y', kind: 'yandex', enabled: true }, 'yk', ['Hi.'], 'en', 'ru', f)).toEqual(['Я']);
    expect(await machineTranslate({ id: 'l', kind: 'libre', enabled: true, url: 'http://127.0.0.1:5000' }, undefined, ['Hi.'], 'en', 'ru', f)).toEqual(['Локально']);
    expect(log[0]).toContain('api-free.deepl.com');
    expect(similarity('Я не пойду.', 'Я не пойду!')).toBeGreaterThan(0.9);
    expect(similarity('Я не пойду.', 'Привет')).toBeLessThan(0.2);
  });

  it('the judge marks the wrong line; «fix» takes its wording and keeps ours to return to', async () => {
    const log: string[] = [];
    const config: any = {
      privacy: 'cloud', sourceLang: 'en', targetLang: 'ru', profile: DEFAULT_PROFILES[0], glossary: [], translateSfx: true,
      crossCheck: { mode: 'fix', judge: { ...configFromPreset('openai', 'gpt-x'), apiKey: 'x' }, checkers: [{ id: 'd', kind: 'deepl', enabled: true, apiKey: 'k:fx' }, { id: 'g', kind: 'google', enabled: true, apiKey: 'gk' }] },
    };
    const blocks = [block('b1', 'Hi.', 'Привет.'), block('b2', 'I will not go.', 'Я пойду.')];
    await runCrossCheck(blocks, config, { fetchImpl: services(log) as any });
    expect(blocks[0].check).toMatchObject({ verdict: 'ok' });
    expect(blocks[0].check.refs.map((r: any) => r.by)).toEqual(['DeepL', 'Google Translate']);
    expect(blocks[1].check).toMatchObject({ verdict: 'differs', note: 'Потеряно отрицание.', before: 'Я пойду.' });
    expect(blocks[1].translatedText).toBe('Я не пойду.');
  });

  it('privacy «local»: cloud translators are not asked, a local one is', async () => {
    const log: string[] = [];
    const config: any = {
      privacy: 'local', sourceLang: 'en', targetLang: 'ru', profile: DEFAULT_PROFILES[0], glossary: [], translateSfx: true,
      crossCheck: { mode: 'report', judge: null, checkers: [{ id: 'd', kind: 'deepl', enabled: true, apiKey: 'k:fx' }, { id: 'l', kind: 'libre', enabled: true, url: 'http://127.0.0.1:5000' }] },
    };
    const blocks = [block('b1', 'Hi.', 'Совсем другое')];
    await runCrossCheck(blocks, config, { fetchImpl: services(log) as any });
    expect(log.some((u) => u.includes('deepl'))).toBe(false);
    expect(blocks[0].check.refs).toEqual([{ by: 'LibreTranslate', text: 'Локально' }]);
    // No judge: a translation sharing nothing with the references is flagged.
    expect(blocks[0].check.verdict).toBe('differs');
  });

  it('a translator that fails is left out, the page goes on', async () => {
    const blocks = [block('b1', 'Hi.', 'Привет.')];
    const errors: string[] = [];
    await crossCheckPage(blocks, { references: [{ label: 'X', translate: async () => { throw new Error('down'); } }], judge: null, mode: 'report', targetLang: 'ru', onError: (l) => errors.push(l) });
    expect(errors).toEqual(['X']);
    expect(blocks[0].check).toBeUndefined();
  });
});
