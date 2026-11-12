import { describe, expect, it } from 'vitest';
import { emptyContext } from '../src/translate/context';
import type { PromptInput } from '../src/translate/prompt';
import { DEFAULT_PROFILES } from '../src/translate/profiles';
import { mixedScriptWords } from '../src/translate/parse';
import { ruleChecks } from '../src/translate/qa';
import type { TextBlock } from '../src/types';
import { translateBlocks } from '../src/translate/translator';
import { configFromPreset, createProvider } from '../src/llm/presets';
import { jsonResponse } from './helpers';

const input: PromptInput = { sourceLang: 'en', targetLang: 'ru', profile: DEFAULT_PROFILES[0], translateSfx: true, glossary: [], context: emptyContext('s') };
const answer = (text: string) => jsonResponse({ choices: [{ message: { content: JSON.stringify({ translations: [{ id: 'b1', text }] }) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });

describe('a word half translated («URGH!» → «Урgh!»: Cyrillic and Latin letters in one word)', () => {
  it('is told from whole words of either alphabet', () => {
    expect(mixedScriptWords('Урgh! Я не понимаю!')).toEqual(['Урgh']);
    expect(mixedScriptWords('Я получил 2250 XP и ранг S.')).toEqual([]);
    expect(mixedScriptWords('USB-кабель, e-mail, IT-отдел')).toEqual([]);
    expect(mixedScriptWords('Привет, John!')).toEqual([]);
  });

  it('is asked again of the translator, and the mended word is used', async () => {
    const asked: string[] = [];
    const provider = createProvider({ ...configFromPreset('lmstudio', 'llm'), id: 't' }, async (_u, init) => {
      asked.push(JSON.parse(String(init?.body)).messages.at(-1).content);
      return answer(asked.length === 1 ? 'Урgh! Я не понимаю!' : 'Ургх! Я не понимаю!');
    });
    const r = await translateBlocks(provider, input, [{ id: 'b1', type: 'DIALOGUE', text: "URGH! I DON'T UNDERSTAND!" }]);
    expect(asked).toHaveLength(2);
    expect(asked[1]).toContain('Урgh');
    expect(r.translations.get('b1')!.text).toBe('Ургх! Я не понимаю!');
  });

  it('is marked on the page when it stays', () => {
    const b = { originalText: 'URGH!', translatedText: 'Урgh!', translate: true } as unknown as TextBlock;
    expect(ruleChecks(b, 'ru', []).map((i) => i.kind)).toContain('untranslated');
  });

  it('a clean translation is not asked again', async () => {
    let n = 0;
    const provider = createProvider({ ...configFromPreset('lmstudio', 'llm'), id: 't' }, async () => (n++, answer('Ургх! Я не понимаю!')));
    await translateBlocks(provider, input, [{ id: 'b1', type: 'DIALOGUE', text: "URGH! I DON'T UNDERSTAND!" }]);
    expect(n).toBe(1);
  });
});
