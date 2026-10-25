/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from 'vitest';
import { configFromPreset, defaultSettings, TranslateService, type AppSettings } from '../src';
import { jsonResponse, makeMangaPage, napiBackend, toNorm } from './helpers';

function memoryDb() {
  const m = new Map<string, unknown>();
  const of = (s: string) => [...m.entries()].filter(([k]) => k.startsWith(`${s}/`)).map(([k, v]) => [k.slice(s.length + 1), structuredClone(v)] as [string, unknown]);
  return {
    get: async (s: string, k: string) => structuredClone(m.get(`${s}/${k}`)),
    put: async (s: string, k: string, v: unknown) => void m.set(`${s}/${k}`, structuredClone(v)),
    delete: async (s: string, k: string) => void m.delete(`${s}/${k}`),
    keys: async (s: string) => of(s).map(([k]) => k),
    keysWithPrefix: async (s: string, p: string) => of(s).map(([k]) => k).filter((k) => k.startsWith(p)),
    entries: async (s: string) => of(s),
  } as any;
}

const settings = (over: Partial<AppSettings> = {}): AppSettings =>
  ({
    ...defaultSettings(),
    providers: [{ ...configFromPreset('openai', 'gpt-4o'), id: 'c', vision: true }],
    visionProviderId: 'c',
    translationProviderId: null,
    twoStepTranslation: false,
    qaMode: 'fix',
    privacy: 'cloud',
    sourceLang: 'ja',
    targetLang: 'ru',
    saveHistory: false,
    fonts: { dialogue: 'TestSans', narration: 'TestSans', sfx: 'TestSans' },
    ...over,
  }) as AppSettings;

describe('shown first, checked after', () => {
  it('the page is there before the model has checked it; the fix comes after and redraws it', async () => {
    const page = await makeMangaPage();
    let reviewDone = 0;
    const fetchImpl = async (_u: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const review = String(body.messages?.[0]?.content ?? '').includes('editor-in-chief');
      let content: string;
      if (review) {
        await new Promise((r) => setTimeout(r, 1500));
        const blocks = JSON.parse(/<blocks>\n(.*)\n<\/blocks>/s.exec(body.messages.at(-1).content)?.[1] ?? '[]');
        content = JSON.stringify({ reviews: blocks.map((b: any) => (b.id.endsWith('b1') ? { id: b.id, ok: false, issues: [{ kind: 'grammar', severity: 'major', note: 'род' }], fix: 'ИСПРАВЛЕНО' } : { id: b.id, ok: true })) });
        reviewDone = performance.now();
      } else {
        content = JSON.stringify({ blocks: page.bubbles.map((b) => ({ box: toNorm(b.textBox, 800, 1100), text: b.text, translation: `RU ${b.text}`, type: 'DIALOGUE', vertical: true })), entities: [], summary: '' });
      }
      return jsonResponse({ choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 10 }, model: body.model });
    };
    const svc = new TranslateService(memoryDb(), { get: async () => undefined } as any, napiBackend, async () => settings(), fetchImpl as any);
    svc.compactTiles = false;
    const changed: string[] = [];
    svc.onResultChanged = (k) => changed.push(k);
    const { result } = await svc.translate(page.bytes, 'image/png', { sourceUrl: 'https://site.example/m/1' });
    const shownAt = performance.now();
    expect(reviewDone === 0 || shownAt < reviewDone).toBe(true);
    expect(result.page.blocks[0].translatedText).toBe(`RU ${page.bubbles[0].text}`);
    await svc.flushReviews();
    const after = await svc.getResult(result.key);
    expect(after?.page.blocks[0].translatedText).toBe('ИСПРАВЛЕНО');
    expect(changed).toContain(result.key);
  }, 60000);

  it('off: the page waits for the check', async () => {
    const page = await makeMangaPage();
    const fetchImpl = async (_u: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const review = String(body.messages?.[0]?.content ?? '').includes('editor-in-chief');
      const content = review
        ? JSON.stringify({ reviews: JSON.parse(/<blocks>\n(.*)\n<\/blocks>/s.exec(body.messages.at(-1).content)?.[1] ?? '[]').map((b: any) => (b.id === 'b1' ? { id: b.id, ok: false, issues: [{ kind: 'grammar', severity: 'major', note: 'род' }], fix: 'ИСПРАВЛЕНО' } : { id: b.id, ok: true })) })
        : JSON.stringify({ blocks: page.bubbles.map((b) => ({ box: toNorm(b.textBox, 800, 1100), text: b.text, translation: `RU ${b.text}`, type: 'DIALOGUE', vertical: true })), entities: [], summary: '' });
      return jsonResponse({ choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 10 }, model: body.model });
    };
    const svc = new TranslateService(memoryDb(), { get: async () => undefined } as any, napiBackend, async () => settings({ qaAfterShow: false }), fetchImpl as any);
    svc.compactTiles = false;
    const { result } = await svc.translate(page.bytes, 'image/png');
    expect(result.page.blocks[0].translatedText).toBe('ИСПРАВЛЕНО');
  }, 60000);
});
