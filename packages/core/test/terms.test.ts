/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from 'vitest';
import { configFromPreset, OpenAICompatibleProvider } from '../src';
import { emptyContext } from '../src/translate/context';
import { entityHints } from '../src/translate/context';
import { DEFAULT_PROFILES } from '../src/translate/profiles';
import { translateBlocks } from '../src/translate/translator';
import { jsonResponse } from './helpers';

const entities = [
  { source: 'Chanter', target: 'Певчий', kind: 'term' as const },
  { source: 'Entangling Vines', target: 'Опутывающие лозы', kind: 'ability' as const },
  { source: 'Al', target: 'Ал', kind: 'character' as const },
];

describe('one translation of a term through the whole series', () => {
  it('a known term in a line becomes that line\'s hint: also in capitals and plural; not inside other words', () => {
    expect(entityHints('CHANTER IS CONSIDERED A GARBAGE CLASS', entities)).toEqual(['Chanter → Певчий']);
    expect(entityHints('Two chanters and Entangling Vines!', entities)).toEqual(['Chanter → Певчий', 'Entangling Vines → Опутывающие лозы']);
    expect(entityHints('ALL HAIL', entities)).toEqual([]);
  });
  it('the text model gets it for that line', async () => {
    let user = '';
    const f = async (_u: string, i?: RequestInit) => {
      const b = JSON.parse(String(i?.body));
      user = b.messages.at(-1).content;
      return jsonResponse({ choices: [{ message: { content: JSON.stringify({ translations: [{ id: 'b1', text: 'Певчий — мусорный класс.' }] }) } }] });
    };
    const ctx = { ...emptyContext('s'), entities: entities.map((e) => ({ ...e })) } as any;
    await translateBlocks(new OpenAICompatibleProvider({ ...configFromPreset('openai', 'o'), apiKey: 'k' }, f), { sourceLang: 'en', targetLang: 'ru', profile: DEFAULT_PROFILES[0], glossary: [], translateSfx: true, context: ctx }, [{ id: 'b1', type: 'DIALOGUE', text: 'CHANTER IS CONSIDERED A GARBAGE CLASS' }]);
    expect(user).toContain('Chanter → Певчий');
  });
});
