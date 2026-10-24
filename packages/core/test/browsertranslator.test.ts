import { afterEach, describe, expect, it } from 'vitest';
import { aiModesAvailable, applyAiMode, applyOcrTranslator, BROWSER_TRANSLATOR_ID, checkReadiness, configFromPreset, createProvider, defaultSettings, guessLanguage, ocrTranslators, setBrowserTranslate, translateBlocks, type AppSettings } from '../src';
import { recording } from '../src/pipeline/debug';

const base = (providers = [{ ...configFromPreset('ollama', 'qwen3.5:9b'), id: 'ol', vision: true }]): AppSettings => ({ ...defaultSettings(), providers, visionProviderId: providers[0]?.id ?? null, translationProviderId: null, privacy: 'local', pipeline: 'standalone' });

afterEach(() => setBrowserTranslate(null));

describe('the browser\'s own translator in «Распознавание»', () => {
  it('the mode works with no model server at all, and picks the browser translator by default', () => {
    const none = base([]);
    expect(aiModesAvailable(none).ocr).toBe(false);
    setBrowserTranslate(async (t) => t);
    expect(aiModesAvailable(none).ocr).toBe(true);
    const s = { ...none, ...applyAiMode(none, 'ocr')! };
    expect(s.visionProviderId).toBe(BROWSER_TRANSLATOR_ID);
    expect(s.readMode).toBe('ocr');
    // With Ollama in the list as well, the browser translator still comes first; the choice is kept.
    const ol = base();
    expect({ ...ol, ...applyAiMode(ol, 'ocr')! }.visionProviderId).toBe(BROWSER_TRANSLATOR_ID);
    expect(ocrTranslators(ol).map((p) => p.id)).toEqual([BROWSER_TRANSLATOR_ID, 'ol']);
    const picked = { ...ol, ...applyAiMode(ol, 'ocr')! };
    const back = { ...picked, ...applyOcrTranslator(picked, 'ol') };
    const again = { ...back, ...applyAiMode({ ...back, ...applyAiMode(back, 'ollama')! }, 'ocr')! };
    expect(again.visionProviderId).toBe('ol');
  });

  it('needs no program: the readiness check passes without Ollama', async () => {
    setBrowserTranslate(async (t) => t);
    const s = { ...base([]), visionProviderId: BROWSER_TRANSLATOR_ID, readMode: 'ocr' as const };
    const noNet = (async () => {
      throw new Error('no network');
    }) as never;
    expect(await checkReadiness(s, noNet)).toEqual({ ok: true });
  });

  it('translates line by line (through the debug wrapper too), a glossary term as the glossary says', async () => {
    const seen: string[] = [];
    setBrowserTranslate(async (texts, from, to) => {
      seen.push(`${from}>${to}`);
      return texts.map((t) => `[${t}]`);
    });
    const s = base([]);
    const { providerById } = await import('../src');
    const p = recording(createProvider(providerById(s, BROWSER_TRANSLATOR_ID)!), 'translate', { steps: [], answers: [] } as never);
    const res = await translateBlocks(p, { sourceLang: 'auto', targetLang: 'ru', profile: {} as never, glossary: [{ id: 'g', source: 'Sensei', target: 'Сэнсэй' }] } as never, [
      { id: 'b1', type: 'DIALOGUE', text: 'なにしてるの' },
      { id: 'b2', type: 'DIALOGUE', text: 'Sensei' },
    ]);
    expect(res.translations.get('b1')?.text).toBe('[なにしてるの]');
    expect(res.translations.get('b2')?.text).toBe('Сэнсэй');
    expect(seen).toEqual(['ja>ru']);
  });

  it('guesses the language of «auto» from the script', () => {
    expect(guessLanguage(['안녕하세요'])).toBe('ko');
    expect(guessLanguage(['你好'])).toBe('zh');
    expect(guessLanguage(['hello'])).toBe('en');
  });
});
