/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from 'vitest';
import { configFromPreset, defaultSettings, TranslateService, type AppSettings } from '../src';
import { CpuLane } from '../src/util/cpuLane';
import { jsonResponse, makeMangaPage, napiBackend, toNorm } from './helpers';

describe('the processor goes page by page', () => {
  it('one stretch at a time, the page started first first', async () => {
    const lane = new CpuLane();
    const log: string[] = [];
    const work = (name: string, ms: number) => async () => {
      log.push(`${name}+`);
      await new Promise((r) => setTimeout(r, ms));
      log.push(`${name}-`);
    };
    const a = lane.run(1, work('a', 30));
    // While page 1 works, page 3 asks before page 2: page 2 still goes first.
    const c = lane.run(3, work('c', 5));
    const b = lane.run(2, work('b', 5));
    await Promise.all([a, b, c]);
    expect(log).toEqual(['a+', 'a-', 'b+', 'b-', 'c+', 'c-']);
  });
});

function memoryDb(log: { put: number[] }) {
  const m = new Map<string, unknown>();
  const of = (s: string) => [...m.entries()].filter(([k]) => k.startsWith(`${s}/`)).map(([k, v]) => [k.slice(s.length + 1), structuredClone(v)] as [string, unknown]);
  return {
    get: async (s: string, k: string) => structuredClone(m.get(`${s}/${k}`)),
    put: async (s: string, k: string, v: unknown) => {
      if (s === 'results') log.put.push(performance.now());
      m.set(`${s}/${k}`, structuredClone(v));
    },
    delete: async (s: string, k: string) => void m.delete(`${s}/${k}`),
    keys: async (s: string) => of(s).map(([k]) => k),
    keysWithPrefix: async (s: string, p: string) => of(s).map(([k]) => k).filter((k) => k.startsWith(p)),
    entries: async (s: string) => of(s),
  } as any;
}

describe('the next page of a series translates while this one is drawn', () => {
  it('its model request starts before the page before it is stored', async () => {
    const p1 = await makeMangaPage();
    const p2 = await makeMangaPage(800, 1100, [
      { cx: 220, cy: 260, rx: 120, ry: 170, text: 'まってよ' },
      { cx: 580, cy: 700, rx: 110, ry: 160, text: 'いくよ' },
    ]);
    const asked: number[] = [];
    const fetchImpl = async (_u: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      asked.push(performance.now());
      const page = asked.length === 1 ? p1 : p2;
      await new Promise((r) => setTimeout(r, 200));
      const content = JSON.stringify({ blocks: page.bubbles.map((b) => ({ box: toNorm(b.textBox, 800, 1100), text: b.text, translation: `RU ${b.text}`, type: 'DIALOGUE', vertical: true })), entities: [], summary: '' });
      return jsonResponse({ choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 10 }, model: body.model });
    };
    const log = { put: [] as number[] };
    const settings = { ...defaultSettings(), providers: [{ ...configFromPreset('openai', 'gpt-4o'), id: 'c', vision: true }], visionProviderId: 'c', translationProviderId: null, twoStepTranslation: false, qaMode: 'off', privacy: 'cloud', sourceLang: 'ja', targetLang: 'ru', saveHistory: false, fonts: { dialogue: 'TestSans', narration: 'TestSans', sfx: 'TestSans' } } as AppSettings;
    const svc = new TranslateService(memoryDb(log), { get: async () => undefined } as any, napiBackend, async () => settings, fetchImpl as any);
    svc.compactTiles = false;
    const url = 'https://site.example/manga/one/ch1';
    const [r1, r2] = await Promise.all([svc.translate(p1.bytes, 'image/png', { sourceUrl: url }), svc.translate(p2.bytes, 'image/png', { sourceUrl: url })]);
    expect(r1.result.page.blocks[0].translatedText).toBe('RU たなかさん待って');
    expect(r2.result.page.blocks[0].translatedText).toBe('RU まってよ');
    expect(asked.length).toBe(2);
    // Page 2 asked the model before page 1 was stored (page 1 was still being drawn).
    expect(asked[1]).toBeLessThan(log.put[0]);
  }, 60000);
});
