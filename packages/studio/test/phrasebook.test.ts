import { beforeEach, describe, expect, it } from 'vitest';
import { builtinEntries, DEFAULT_PHRASEBOOK, type TextBlock } from '@ait/core';
import { filterEntries, learnSuggestions, markAsked, rememberPhrase, resetAsked, splitForms, toggleEntry } from '../src/phrasebook';

const block = (id: string, originalText: string, translatedText: string): TextBlock =>
  ({ id, originalText, translatedText, textType: 'DIALOGUE', confidence: 1, language: 'ja', bbox: [0, 0, 10, 10], polygon: [], orientation: 0, writingDirection: 'ltr', fontSizeEstimate: 12, bubble: null, translate: true }) as TextBlock;
const pb = { ...DEFAULT_PHRASEBOOK };
const opts = { sourceLang: 'ja', targetLang: 'ru', phrasebook: pb };

describe('phrasebook in the Studio', () => {
  beforeEach(() => resetAsked());

  it('filters the list by language, category and search', () => {
    const all = builtinEntries();
    const ja = filterEntries(all, { lang: 'ja', query: '', cat: '' });
    expect(ja.length).toBeGreaterThan(50);
    expect(ja.every((e) => e.source === 'ja')).toBe(true);
    expect(filterEntries(all, { lang: 'ja', query: 'なるほど', cat: '' }).map((e) => e.id)).toContain('ja:naruhodo');
    expect(filterEntries(all, { lang: 'ja', query: '', cat: 'address' }).every((e) => e.cat === 'address')).toBe(true);
    // Search also looks at the translations.
    expect(filterEntries(all, { lang: 'ja', query: 'вот оно что', cat: '' }).length).toBeGreaterThan(0);
  });

  it('switching entries off and on, spellings typed with commas', () => {
    const off = toggleEntry(pb, 'ja:naruhodo', false);
    expect(off.disabled).toEqual(['ja:naruhodo']);
    expect(toggleEntry(off, 'ja:naruhodo', true).disabled).toEqual([]);
    expect(splitForms('なるほど, 成程、 なるほど ,')).toEqual(['なるほど', '成程']);
  });

  it('offers to remember the user wording once per expression', () => {
    const before = [block('b1', 'なるほど！', 'Понятно.'), block('b2', 'どこへ行くの', 'Куда ты?')];
    const after = [block('b1', 'なるほど！', 'Ага, вот как'), block('b2', 'どこへ行くの', 'Куда собрался?')];
    const s = learnSuggestions(before, after, opts);
    expect(s).toEqual([{ blockId: 'b1', source: 'ja', src: 'なるほど', text: 'Ага, вот как', whole: true }]);
    // Unchanged blocks, a variant already in the book, a spelling asked before: nothing.
    expect(learnSuggestions(before, before, opts)).toEqual([]);
    const variant = builtinEntries().find((e) => e.id === 'ja:naruhodo')!.variants[0].text;
    expect(learnSuggestions(before, [block('b1', 'なるほど！', variant)], opts)).toEqual([]);
    markAsked(s[0]);
    expect(learnSuggestions(before, after, opts)).toEqual([]);
    // Off, or another target language.
    resetAsked();
    expect(learnSuggestions(before, after, { ...opts, phrasebook: { ...pb, enabled: false } })).toEqual([]);
    expect(learnSuggestions(before, after, { ...opts, targetLang: 'en' })).toEqual([]);
  });

  it('a long line is not «whole»: the user picks the part to remember', () => {
    const s = learnSuggestions([block('b1', 'やばい、先生が来るぞ早く逃げろ', 'Блин, учитель идёт')], [block('b1', 'やばい、先生が来るぞ早く逃げろ', 'Чёрт, учитель идёт, бежим')], opts);
    expect(s).toHaveLength(1);
    expect(s[0].whole).toBe(false);
  });

  it('remembers the variant as a user entry that replaces an earlier one', () => {
    const one = rememberPhrase(pb, { source: 'ja', src: 'なるほど', text: 'Ага' }, 'мой вариант');
    expect(one.user).toHaveLength(1);
    expect(one.user[0]).toMatchObject({ source: 'ja', src: ['なるほど'], variants: [{ text: 'Ага', when: 'мой вариант' }] });
    const two = rememberPhrase(one, { source: 'ja', src: 'なるほど', text: 'Вот как' }, 'мой вариант');
    expect(two.user.map((u) => u.variants[0].text)).toEqual(['Вот как']);
  });
});
