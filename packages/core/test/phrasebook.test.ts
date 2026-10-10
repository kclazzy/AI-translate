import { describe, expect, it } from 'vitest';
import fixture from './fixtures/phrasebook.json';
import { builtinBooks, builtinGenres, normalizeBook, normalizeEntry, type LoadedBook } from '../src/translate/phrasebook/books';
import { activeEntries, findPhrases, matchText, normalizeCjk, phrasebookSection, phraseSourceLang, variantsFor, type PhrasebookSettings } from '../src/translate/phrasebook/match';
import { buildSystemPrompt, textTranslateInstruction, visionPhrasebook, type PromptInput } from '../src/translate/prompt';
import { DEFAULT_PROFILES } from '../src/translate/profiles';
import { translateBlocks } from '../src/translate/translator';
import { OpenAICompatibleProvider } from '../src/llm/openai';
import { configFromPreset } from '../src/llm/presets';
import { defaultSettings, migrateSettings } from '../src/settings';
import { pipelineConfigFromSettings, pipelineHash } from '../src/pipeline/config';
import type { GlossaryEntry } from '../src/translate/glossary';
import { emptyContext } from '../src/translate/context';
import { mockOpenAi } from './helpers';

const books: LoadedBook[] = fixture.books.map((b) => normalizeBook(b, { source: b.source, target: b.target }));
const on = (patch: Partial<PhrasebookSettings> = {}): PhrasebookSettings => ({ enabled: true, disabled: [], genres: [], user: [], ...patch });
const find = (texts: string[], opts: Partial<Parameters<typeof findPhrases>[1]> = {}) =>
  findPhrases(texts.map((text, i) => ({ id: `b${i + 1}`, text })), { sourceLang: 'ja', targetLang: 'ru', settings: on(), books, ...opts });
const ids = (m: ReturnType<typeof findPhrases>) => m.map((x) => x.entry.id);
const g = (p: Partial<GlossaryEntry>): GlossaryEntry => ({ id: 'g1', source: '', target: '', matchMode: 'exact', caseSensitive: false, forbidden: [], enabled: true, ...p });

describe('phrasebook data', () => {
  it('reads both the schema shape and the authoring shape of the data files', () => {
    const sensei = normalizeEntry(fixture.authoring[0], { source: 'ja', target: 'ru' })!;
    expect(sensei.src).toEqual(['先生']);
    expect(sensei.cat).toBe('address');
    expect(sensei.variants.map((v) => [v.text, v.policy])).toEqual([['учитель', 'adapt'], ['сэнсэй', 'keep']]);
    expect(normalizeEntry(fixture.authoring[1], { source: 'zh', target: 'ru' })!.genre).toBe('cultivation');
    expect(normalizeEntry(fixture.authoring[2], { source: 'zh', target: 'ru' })).toBeNull();
    expect(books[3].entries[0].genre).toBe('cultivation');
  });

  it('ships the built-in books for ja, ko, zh and en into Russian', () => {
    const b = builtinBooks();
    for (const lang of ['ja', 'ko', 'zh', 'en']) expect(b.some((x) => x.source === lang && x.target === 'ru' && x.entries.length > 20)).toBe(true);
    const ids = b.flatMap((x) => x.entries.map((e) => e.id));
    expect(new Set(ids).size).toBe(ids.length);
    // The cultivation set is a genre book: on only when switched on.
    expect(b.find((x) => x.genre === 'cultivation')?.entries.every((e) => e.genre === 'cultivation' && e.source === 'zh')).toBe(true);
    expect(builtinGenres()).toContain('cultivation');
  });
});

describe('phrasebook matching', () => {
  it('normalises width, case, long-vowel marks and punctuation', () => {
    expect(normalizeCjk('ナルホドー！？ ｡')).toBe('ナルホド');
    expect(normalizeCjk('ﾔﾊﾞい〜〜')).toBe('ヤバい');
    expect(ids(find(['うそーーっ!!']))).toEqual(['ja:uso']); // うそ is 2 of the 3 letters of うそっ
    expect(ids(find(['うそだろお前']))).toEqual([]);
    expect(ids(find(['うそー！？']))).toEqual(['ja:uso']);
  });

  it('CJK: the longest spelling wins and no text is matched twice', () => {
    expect(ids(find(['これはやばすぎだろ']))).toEqual(['ja:yabasugi']);
    expect(ids(find(['やばい、やばすぎ']))).toEqual(['ja:yabai', 'ja:yabasugi']);
    expect(find(['先輩、お疲れ様です！'])[0].matched).toBe('先輩');
  });

  it('Korean: the inflected forms given are matched, longest first', () => {
    const m = find(['와 대박이다!!'], { sourceLang: 'ko' });
    expect(ids(m)).toEqual(['ko:daebak']);
    expect(m[0].matched).toBe('대박이다');
  });

  it('English: whole words only, any case', () => {
    expect(ids(find(['NO WAY! You did it?'], { sourceLang: 'en' }))).toEqual(['en:no-way']);
    expect(ids(find(['Germany is far'], { sourceLang: 'en' }))).toEqual([]);
    expect(ids(find(['Oh man, again'], { sourceLang: 'en' }))).toEqual(['en:man']);
    expect(ids(find(['Tsk.'], { sourceLang: 'en' }))).toEqual(['en:tsk']);
  });

  it('standalone expressions count only when they are most of the bubble', () => {
    expect(ids(find(['なるほど…！']))).toEqual(['ja:naruhodo']);
    expect(ids(find(['なるほどね']))).toEqual(['ja:naruhodo']); // 4 of 5 letters
    expect(ids(find(['なるほど、それで君はここに来たのか']))).toEqual([]);
    expect(find(['なるほど'])[0].whole).toBe(true);
    expect(ids(find(['Tsk, you never listen to me'], { sourceLang: 'en' }))).toEqual([]);
  });

  it('sends at most 8 per page, longer spellings and repeated ones first, in reading order', () => {
    const texts = ['ありがとう', 'すみません', 'ごめん', 'よろしく', '頑張って', '行ってきます', 'ただいま', 'いただきます', 'お疲れ様', 'やばい', 'やばい'];
    const m = find(texts);
    expect(m).toHaveLength(8);
    // The shortest (ごめん, やばい, ただいま…) lose; やばい is in two blocks, so it beats ごめん.
    expect(ids(m)).not.toContain('ja:gomen');
    expect(m.map((x) => x.blocks[0])).toEqual([...m.map((x) => x.blocks[0])].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))));
  });

  it('a glossary term wins over the phrasebook', () => {
    expect(ids(find(['先輩、待って']))).toEqual(['ja:senpai']);
    expect(ids(find(['先輩、待って'], { glossary: [g({ source: '先輩', target: 'Семпай' })] }))).toEqual([]);
    // A switched-off glossary term does not.
    expect(ids(find(['先輩、待って'], { glossary: [g({ source: '先輩', target: 'Семпай', enabled: false })] }))).toEqual(['ja:senpai']);
  });

  it('forms of address follow the profile honorifics', () => {
    const entry = books[0].entries.find((e) => e.id === 'ja:senpai')!;
    expect(variantsFor(entry, 'keep').map((v) => v.text)).toEqual(['сэмпай', 'наставник']);
    expect(variantsFor(entry, 'adapt').map((v) => v.text)).toEqual(['старший', 'наставник']);
    expect(variantsFor(entry, 'drop').map((v) => v.text)).toEqual(['старший', 'наставник']);
    expect(find(['先輩！'], { honorifics: 'keep' })[0].variants[0].text).toBe('сэмпай');
  });

  it('auto source: kana → ja, hangul → ko, han → zh, latin → en', () => {
    expect(phraseSourceLang('auto', ['漢字となるほど'])).toBe('ja');
    expect(phraseSourceLang('auto', ['대박'])).toBe('ko');
    expect(phraseSourceLang('auto', ['哎呀，师兄'])).toBe('zh');
    expect(phraseSourceLang('auto', ['No way'])).toBe('en');
    expect(phraseSourceLang('auto', ['Привет'])).toBeNull();
    expect(phraseSourceLang('zh-TW', ['x'])).toBe('zh');
    expect(ids(find(['哎呀！'], { sourceLang: 'auto' }))).toEqual(['zh:aiya']);
    expect(ids(find(['대박이야'], { sourceLang: 'auto' }))).toEqual(['ko:daebak']);
    // The source language must match the page: Japanese entries are not looked for in Korean.
    expect(ids(find(['なるほど'], { sourceLang: 'ko' }))).toEqual([]);
  });

  it('only into Russian, only when on; genre sets and switched-off entries', () => {
    expect(find(['なるほど'], { targetLang: 'en' })).toEqual([]);
    expect(find(['なるほど'], { settings: on({ enabled: false }) })).toEqual([]);
    expect(find(['なるほど'], { settings: undefined })).toEqual([]);
    expect(ids(find(['なるほど'], { settings: on({ disabled: ['ja:naruhodo'] }) }))).toEqual([]);
    expect(ids(find(['师兄在修炼'], { sourceLang: 'zh' }))).toEqual(['zh:shixiong']);
    expect(ids(find(['师兄在修炼'], { sourceLang: 'zh', settings: on({ genres: ['cultivation'] }) }))).toEqual(['zh:shixiong', 'zh:xiulian']);
  });

  it("the user's entries replace built-in ones with the same spelling", () => {
    const user = [{ id: 'u1', source: 'ja', src: ['成程'], variants: [{ text: 'Ага', when: 'мой вариант' }] }];
    const entries = activeEntries('ja', 'ru', on({ user }), books);
    expect(entries.some((e) => e.id === 'ja:naruhodo')).toBe(false);
    const m = find(['なるほど'], { settings: on({ user }) });
    expect(ids(m)).toEqual([]); // the user's entry has only 成程
    expect(find(['成程！'], { settings: on({ user }) })[0].variants).toEqual([{ text: 'Ага', when: 'мой вариант' }]);
  });

  it('matchText reports the share of the bubble', () => {
    const entries = activeEntries('ja', 'ru', on(), books);
    const [hit] = matchText('なるほど', entries, 'ja');
    expect(hit.share).toBe(1);
  });
});

describe('phrasebook in the prompt', () => {
  const input = (patch: Partial<PromptInput> = {}): PromptInput => ({ sourceLang: 'ja', targetLang: 'ru', profile: DEFAULT_PROFILES[0], glossary: [], translateSfx: true, phrasebook: { ...on(), books }, ...patch });

  it('one compact line per expression', () => {
    const section = phrasebookSection(find(['なるほど', 'やばい']));
    expect(section.split('\n')).toEqual([
      'PHRASEBOOK — hints for expressions on this page. Use a variant only if it fits the scene and the speaker; otherwise translate freely. Never translate these literally.',
      '- なるほど (bubble alone) → «Вот оно что» (догадка) | «Понятно» (нейтрально) — не «действительно»',
      '- やばい (проверь, кто говорит) → «Блин» (плохо) | «Офигеть» (восторг)',
    ]);
  });

  it('the text translation request carries the section only when something matched', async () => {
    const provider = (f: ReturnType<typeof mockOpenAi>['fetchImpl']) => new OpenAICompatibleProvider({ ...configFromPreset('lmstudio', 'lm'), jsonMode: 'json_object' }, f);
    const mock = mockOpenAi(() => '{"translations":[{"id":"b1","text":"Вот оно что"}]}');
    await translateBlocks(provider(mock.fetchImpl), input(), [{ id: 'b1', type: 'DIALOGUE', text: 'なるほど！' }]);
    const user = mock.calls[0].body.messages.find((m: { role: string }) => m.role === 'user').content as string;
    expect(user).toContain('PHRASEBOOK — hints for expressions on this page.');
    expect(user).toContain('- なるほど (bubble alone) → «Вот оно что» (догадка)');
    expect(user.indexOf('PHRASEBOOK')).toBeLessThan(user.indexOf('<blocks>'));
    // Not a rule of the system prompt.
    expect(mock.calls[0].body.messages[0].content).not.toContain('PHRASEBOOK');

    const none = mockOpenAi(() => '{"translations":[{"id":"b1","text":"Куда ты идёшь"}]}');
    await translateBlocks(provider(none.fetchImpl), input(), [{ id: 'b1', type: 'DIALOGUE', text: 'どこへ行くの' }]);
    expect(JSON.stringify(none.calls[0].body)).not.toContain('PHRASEBOOK');
    const off = mockOpenAi(() => '{"translations":[{"id":"b1","text":"Понятно"}]}');
    await translateBlocks(provider(off.fetchImpl), input({ phrasebook: undefined }), [{ id: 'b1', type: 'DIALOGUE', text: 'なるほど' }]);
    expect(JSON.stringify(off.calls[0].body)).not.toContain('PHRASEBOOK');
    expect(textTranslateInstruction([{ id: 'b1', type: 'DIALOGUE', text: 'x' }], {})).not.toContain('PHRASEBOOK');
    expect(buildSystemPrompt(input())).not.toContain('PHRASEBOOK');
  });

  it('single-call vision mode takes the hints from the previous lines of the series', () => {
    expect(visionPhrasebook(input())).toBe('');
    const ctx = { ...emptyContext('s'), recentLines: [{ src: 'やばい', dst: 'Блин' }] };
    const s = visionPhrasebook(input({ context: ctx }));
    expect(s).toContain('PHRASEBOOK — hints for expressions seen on the previous pages');
    expect(s).toContain('- やばい');
  });
});

describe('phrasebook settings', () => {
  it('defaults to on, and migration drops entries of the wrong shape', () => {
    expect(defaultSettings().phrasebook).toEqual({ enabled: true, disabled: [], genres: [], user: [] });
    expect(migrateSettings({}).phrasebook).toEqual({ enabled: true, disabled: [], genres: [], user: [] });
    const s = migrateSettings({
      phrasebook: {
        enabled: false,
        disabled: ['ja:naruhodo', 5, 'ja:naruhodo'],
        genres: 'cultivation',
        user: [
          { id: 'u1', source: 'ja', src: ['なるほど', 3, ' '], variants: [{ text: 'Ага', when: 'мой вариант' }, { text: '' }, 'x'], note: 'n' },
          { id: 'u2', source: 'ja', src: [], variants: [{ text: 'a', when: '' }] },
          { source: 'ko', src: ['대박'], variants: [{ text: 'Круто' }] },
          'junk',
        ],
      },
    }).phrasebook!;
    expect(s.enabled).toBe(false);
    expect(s.disabled).toEqual(['ja:naruhodo']);
    expect(s.genres).toEqual([]);
    expect(s.user).toEqual([
      { id: 'u1', source: 'ja', src: ['なるほど'], variants: [{ text: 'Ага', when: 'мой вариант' }], note: 'n' },
      { id: 'user:2', source: 'ko', src: ['대박'], variants: [{ text: 'Круто', when: '' }] },
    ]);
    expect(migrateSettings({ phrasebook: 'x' }).phrasebook!.enabled).toBe(true);
  });

  it('the cache key changes with the phrasebook settings and only with them', async () => {
    const s = defaultSettings();
    const h = (p: PhrasebookSettings) => pipelineHash(pipelineConfigFromSettings({ ...s, phrasebook: p }));
    const base = await h(on());
    expect(await h(on())).toBe(base);
    expect(await h(on({ genres: ['cultivation'] }))).not.toBe(base);
    expect(await h(on({ disabled: ['ja:naruhodo'] }))).not.toBe(base);
    expect(await h(on({ enabled: false }))).not.toBe(base);
    expect(await h(on({ user: [{ id: 'u', source: 'ja', src: ['x'], variants: [{ text: 'y', when: '' }] }] }))).not.toBe(base);
    // Order of switched-off ids does not matter.
    expect(await h(on({ disabled: ['a', 'b'] }))).toBe(await h(on({ disabled: ['b', 'a'] })));
  });
});

describe('phrasebook data', () => {
  it('a switched-on genre set wins over the general set for the same word', async () => {
    const { activeEntries } = await import('../src/translate/phrasebook/match');
    const plain = activeEntries('zh', 'ru', { enabled: true, disabled: [], genres: [], user: [] });
    const genre = activeEntries('zh', 'ru', { enabled: true, disabled: [], genres: ['cultivation'], user: [] });
    const has = (list: { id: string; src: string[] }[], w: string) => list.filter((e) => e.src.includes(w)).map((e) => e.id);
    expect(has(plain, '师尊').every((id) => id.startsWith('zh:'))).toBe(true);
    expect(has(genre, '师尊').length).toBe(1);
    expect(has(genre, '师尊')[0]).toMatch(/^zhc:/);
  });

  it('every built-in book loads with sane entries', async () => {
    const { builtinEntries } = await import('../src/translate/phrasebook/books');
    const all = builtinEntries();
    expect(all.length).toBeGreaterThan(1000);
    for (const e of all) {
      expect(e.variants.length).toBeGreaterThan(0);
      for (const s of e.src) expect([...s].length).toBeGreaterThanOrEqual(e.source === 'en' ? 3 : 2);
    }
  });
});
