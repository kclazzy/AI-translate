import { describe, expect, it } from 'vitest';
import { emptyContext } from '../src/translate/context';
import { buildSystemPrompt, type PromptInput } from '../src/translate/prompt';
import { DEFAULT_PROFILES } from '../src/translate/profiles';
import { translateBlocks } from '../src/translate/translator';
import { configFromPreset, createProvider } from '../src/llm/presets';
import { jsonResponse } from './helpers';

const input = (narrator?: 'male' | 'female'): PromptInput => ({
  sourceLang: 'en',
  targetLang: 'ru',
  profile: DEFAULT_PROFILES[0],
  translateSfx: true,
  glossary: [],
  context: { ...emptyContext('s'), ...(narrator ? { narrator } : {}) },
});

describe('the main character\'s gender, set for the series (chapter 2: «я одолела», «я подняла уровень» for a man)', () => {
  it('goes into every page\'s instructions: «I» in narration and thoughts, and others speaking to him', () => {
    expect(buildSystemPrompt(input('male'))).toMatch(/MAIN CHARACTER.*male/is);
    expect(buildSystemPrompt(input('female'))).toMatch(/MAIN CHARACTER.*female/is);
    expect(buildSystemPrompt(input())).not.toMatch(/MAIN CHARACTER/);
  });

  it('narration («I got to claim all the XP for myself») goes to the translator as the main character\'s', async () => {
    let sent = '';
    const provider = createProvider({ ...configFromPreset('lmstudio', 'llm'), id: 't' }, async (_u, init) => {
      sent = JSON.parse(String(init?.body)).messages.at(-1).content;
      return jsonResponse({ choices: [{ message: { content: JSON.stringify({ translations: [{ id: 'b1', text: 'Весь опыт достался мне.' }, { id: 'b2', text: 'Отойди.' }] }) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    });
    await translateBlocks(provider, input('male'), [{ id: 'b1', type: 'NARRATION', text: 'I GOT TO CLAIM ALL THE XP FOR MYSELF.' }, { id: 'b2', type: 'DIALOGUE', text: 'STEP OFF.' }]);
    const data = JSON.parse(/<blocks>\n([\s\S]*)\n<\/blocks>/.exec(sent)![1]);
    expect(data[0].speakerGender).toBe('male');
    expect(data[1].speakerGender).toBeUndefined();
  });
});
