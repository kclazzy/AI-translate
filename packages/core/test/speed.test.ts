/* eslint-disable @typescript-eslint/no-explicit-any */
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import { configFromPreset, defaultSettings, emptyContext, mergeContext, QA_BATCH, TaskQueue, TranslateService, translateBlocks, type AppSettings, type GlossaryEntry, type ImageBackend, type StoredResult } from '../src';
import { buildSystemPrompt, type PromptInput } from '../src/translate/prompt';
import { DEFAULT_PROFILES } from '../src/translate/profiles';
import { jsonResponse, makeMangaPage, napiBackend, toNorm } from './helpers';

/** An in-memory IdbStore with every method the service uses. */
function memoryDb() {
  const m = new Map<string, unknown>();
  const of = (s: string) => [...m.entries()].filter(([k]) => k.startsWith(`${s}/`)).map(([k, v]) => [k.slice(s.length + 1), structuredClone(v)] as [string, unknown]);
  return {
    map: m,
    get: async (s: string, k: string) => structuredClone(m.get(`${s}/${k}`)),
    put: async (s: string, k: string, v: unknown) => void m.set(`${s}/${k}`, structuredClone(v)),
    delete: async (s: string, k: string) => void m.delete(`${s}/${k}`),
    keys: async (s: string) => of(s).map(([k]) => k),
    entries: async (s: string) => of(s),
  } as any;
}

const secrets = { get: async () => undefined } as any;

function settingsWith(over: Partial<AppSettings> = {}): AppSettings {
  return {
    ...defaultSettings(),
    providers: [{ ...configFromPreset('lmstudio', 'vlm'), id: 'v', vision: true }],
    visionProviderId: 'v',
    translationProviderId: null,
    twoStepTranslation: false,
    qaMode: 'off',
    targetLang: 'ru',
    sourceLang: 'ja',
    saveHistory: false,
    fonts: { dialogue: 'TestSans', narration: 'TestSans', sfx: 'TestSans' },
    ...over,
  } as AppSettings;
}

/** A picture with only art: a gradient sky and a few shapes. */
async function artOnly(seed = 1, w = 800, h = 1100): Promise<Uint8Array> {
  const c = createCanvas(w, h);
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, '#6a8fd0');
  g.addColorStop(1, '#f0e0c8');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#3a4a2a';
  ctx.beginPath();
  ctx.ellipse(200 + seed * 40, 800, 260, 120, 0, 0, Math.PI * 2);
  ctx.fill();
  return new Uint8Array(await c.encode('png'));
}

/** Vision answer for makeMangaPage(): its two bubbles. */
function mangaAnswer(bubbles: { text: string; textBox: [number, number, number, number] }[], w = 800, h = 1100) {
  return JSON.stringify({ blocks: bubbles.map((b) => ({ box: toNorm(b.textBox, w, h), text: b.text, translation: `RU ${b.text}`, type: 'DIALOGUE', vertical: true })), entities: [], summary: '' });
}

/** OpenAI-compatible mock that can be slow and logs when each answer was sent. */
function mock(answer: (body: any, n: number) => string, delayMs = 0) {
  const calls: { body: any; at: number; done?: number }[] = [];
  const fetchImpl = async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    const call: { body: any; at: number; done?: number } = { body, at: performance.now() };
    calls.push(call);
    const text = answer(body, calls.length);
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    call.done = performance.now();
    return jsonResponse({ choices: [{ message: { content: text } }], usage: { prompt_tokens: 1000, completion_tokens: 100 }, model: body.model });
  };
  return { fetchImpl, calls };
}

const isReview = (body: any) => String(body.messages?.[0]?.content ?? '').includes('editor-in-chief');

describe('pictures without text are not sent to the model', () => {
  it('skips art, translates lettering, ⟳ (force) asks the model anyway', async () => {
    const page = await makeMangaPage();
    const m = mock(() => mangaAnswer(page.bubbles));
    const svc = new TranslateService(memoryDb(), secrets, napiBackend, async () => settingsWith(), m.fetchImpl);
    svc.compactTiles = false;
    const art = await artOnly();
    const skipped = await svc.translate(art, 'image/png');
    expect(m.calls).toHaveLength(0);
    expect(skipped.result.page).toMatchObject({ skippedNoText: true, blocks: [] });
    expect(skipped.result.page.timings.textCheckMs).toBeGreaterThanOrEqual(0);
    // Remembered: the next visit is a cache hit without the model.
    expect((await svc.translate(art, 'image/png')).cached).toBe(true);
    expect(m.calls).toHaveLength(0);
    // ⟳ «перевести всё равно».
    const forced = await svc.translate(art, 'image/png', { force: true });
    expect(m.calls).toHaveLength(1);
    expect(forced.result.page.skippedNoText).toBeUndefined();
    // A page with lettering is never skipped.
    const text = await svc.translate(page.bytes, 'image/png');
    expect(m.calls).toHaveLength(2);
    expect(text.result.page.skippedNoText).toBeUndefined();
    expect(text.result.page.blocks.length).toBe(2);
  });

  it('the setting turns it off (and gives other cache keys)', async () => {
    const m = mock(() => JSON.stringify({ blocks: [], entities: [], summary: '' }));
    const svc = new TranslateService(memoryDb(), secrets, napiBackend, async () => settingsWith({ skipEmptyPages: false }), m.fetchImpl);
    svc.compactTiles = false;
    await svc.translate(await artOnly(), 'image/png');
    expect(m.calls).toHaveLength(1);
  });

  it('a strip chunk without text is skipped, the chunk with a bubble is translated', async () => {
    // A webtoon picture: a flat background and one bubble with a line of text.
    const c = createCanvas(800, 1100);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#dfe6ee';
    ctx.fillRect(0, 0, 800, 1100);
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.ellipse(400, 550, 260, 120, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#111';
    ctx.font = 'bold 34px TestSans';
    ctx.textAlign = 'center';
    ctx.fillText('WAIT FOR ME!', 400, 562);
    const text = new Uint8Array(await c.encode('png'));
    const m = mock(() => JSON.stringify({ blocks: [{ box: toNorm([280, 525, 240, 45], 800, 1100), text: 'WAIT FOR ME!', translation: 'ПОДОЖДИ!', type: 'DIALOGUE', vertical: false }], entities: [], summary: '' }));
    const svc = new TranslateService(memoryDb(), secrets, napiBackend, async () => settingsWith({ sourceLang: 'en' }), m.fetchImpl);
    svc.compactTiles = false;
    const got: StoredResult[] = [];
    const parts = [await artOnly(1), text, await artOnly(2)];
    await svc.translateStrip(parts.map((bytes) => ({ bytes, mime: 'image/png' })), { onPart: (i, r) => (got[i] = r) });
    expect(m.calls).toHaveLength(1);
    expect(got.map((r) => !!r.page.skippedNoText)).toEqual([true, false, true]);
    expect(got[1].page.blocks[0].translatedText).toBe('ПОДОЖДИ!');
  });
});

describe('the system prompt is the same for every page', () => {
  const glossary: GlossaryEntry[] = [
    { id: 'g1', source: '田中', target: 'Танака', matchMode: 'exact', caseSensitive: false, forbidden: ['Танака-сан'], enabled: true },
    { id: 'g2', source: '魔王', target: 'Король Демонов', matchMode: 'exact', caseSensitive: false, forbidden: [], enabled: true },
  ];
  const input = (context?: PromptInput['context']): PromptInput => ({ sourceLang: 'ja', targetLang: 'ru', profile: DEFAULT_PROFILES[0], glossary, translateSfx: true, context });

  it('two pages with different text, terms and series context → byte-identical system prompt', async () => {
    const systems: string[] = [];
    const users: string[] = [];
    const provider = {
      config: { ...configFromPreset('lmstudio', 'x'), label: 'x' },
      complete: async (req: any) => {
        systems.push(req.system);
        users.push(req.messages[0].content);
        const ids = [...String(req.messages[0].content).matchAll(/"id":"(b\d+)"/g)].map((x) => x[1]);
        return { text: JSON.stringify({ translations: ids.map((id) => ({ id, text: 'Привет' })), entities: [], summary: '' }), inputTokens: 1, outputTokens: 1, model: 'x' };
      },
    } as any;
    const ctx1 = emptyContext('s');
    const ctx2 = mergeContext(ctx1, { entities: [{ source: '佐藤', target: 'Сато', kind: 'character' }], summary: 'Танака ушёл.', lines: [{ src: 'はい', dst: 'Да' }] });
    await translateBlocks(provider, input(ctx1), [{ id: 'b1', type: 'DIALOGUE', text: '田中さん、待って！' }]);
    await translateBlocks(provider, input(ctx2), [{ id: 'b1', type: 'DIALOGUE', text: '魔王が来た' }, { id: 'b2', type: 'DIALOGUE', text: 'どこへ行くの' }]);
    expect(systems[0]).toBe(systems[1]);
    // The vision request of the same settings starts with the same system prompt too.
    expect(buildSystemPrompt(input(ctx2))).toBe(systems[0]);
    // What the page has goes into the message: the learned context and the terms of this page.
    expect(users[1]).toContain('Сато');
    expect(users[1]).toContain('Король Демонов');
    expect(systems[0]).not.toContain('Сато');
  });

  it('terms past the glossary limit reach the model through the message', async () => {
    const many: GlossaryEntry[] = Array.from({ length: 160 }, (_, i) => ({ id: `g${i}`, source: `term${i}x`, target: `термин${i}`, matchMode: 'exact', caseSensitive: false, forbidden: [], enabled: true }));
    let user = '';
    let system = '';
    const provider = {
      config: { ...configFromPreset('lmstudio', 'x'), label: 'x' },
      complete: async (req: any) => {
        system = req.system;
        user = req.messages[0].content;
        return { text: JSON.stringify({ translations: [{ id: 'b1', text: 'x' }] }), inputTokens: 1, outputTokens: 1, model: 'x' };
      },
    } as any;
    await translateBlocks(provider, { ...input(), glossary: many }, [{ id: 'b1', type: 'DIALOGUE', text: 'term155x and term3x' }]);
    expect(system).not.toContain('термин155');
    expect(system).toContain('термин3');
    expect(user).toContain('term155x → термин155');
  });
});

describe('batched translation check (qaBatch)', () => {
  it('short pages of a chapter share one review request; the fix reaches the stored result and the app', async () => {
    const pages = await Promise.all(['あいう', 'かきく', 'さしす'].map((t, i) => makeMangaPage(800, 1100, [{ cx: 220, cy: 260, rx: 120, ry: 170, text: `${t}えお${i}` }, { cx: 580, cy: 700, rx: 110, ry: 160, text: `${t}たちつてと` }])));
    let visionN = 0;
    const m = mock((body) => {
      if (isReview(body)) {
        const blocks = JSON.parse(/<blocks>\n(.*)\n<\/blocks>/s.exec(body.messages[1].content)![1]);
        return JSON.stringify({ reviews: blocks.map((b: any) => (b.id === 'p2.b1' ? { id: b.id, ok: false, issues: [{ kind: 'grammar', severity: 'major', note: 'род' }], fix: 'ИСПРАВЛЕНО' } : { id: b.id, ok: true })) });
      }
      const p = pages[visionN++ % 3];
      return mangaAnswer(p.bubbles.map((b) => ({ ...b, text: `${b.text}。これはとても長い文章です、本当に` })));
    });
    const svc = new TranslateService(memoryDb(), secrets, napiBackend, async () => settingsWith({ qaMode: 'fix', qaBatch: true, quality: 'balanced' }), m.fetchImpl);
    svc.compactTiles = false;
    const changed: string[] = [];
    svc.onResultChanged = (k) => changed.push(k);
    const keys: string[] = [];
    for (const p of pages) keys.push((await svc.translate(p.bytes, 'image/png', { sourceUrl: 'https://site.example/manga/one/ch1' })).result.key);
    await svc.flushReviews();
    const reviews = m.calls.filter((c) => isReview(c.body));
    expect(reviews).toHaveLength(1);
    expect(reviews[0].body.messages[1].content).toContain('p3.b2');
    const second = await svc.getResult(keys[1]);
    expect(second!.page.blocks[0].translatedText).toBe('ИСПРАВЛЕНО');
    expect(second!.page.blocks[0].qa).toMatchObject({ reviewed: true, before: expect.stringContaining('RU') });
    expect(changed).toEqual([keys[1]]);
    expect((await svc.getResult(keys[0]))!.page.blocks[0].qa?.reviewed).toBe(true);
  });

  it('1–2 short bubbles get the rule checks only; off by default', async () => {
    const page = await makeMangaPage(800, 1100, [{ cx: 220, cy: 260, rx: 120, ry: 170, text: 'はいはいはい' }]);
    const m = mock((body) => (isReview(body) ? JSON.stringify({ reviews: [] }) : mangaAnswer(page.bubbles)));
    const on = new TranslateService(memoryDb(), secrets, napiBackend, async () => settingsWith({ qaMode: 'fix', qaBatch: true }), m.fetchImpl);
    on.compactTiles = false;
    const r = await on.translate(page.bytes, 'image/png');
    await on.flushReviews();
    expect(m.calls.filter((c) => isReview(c.body))).toHaveLength(0);
    expect(r.result.page.blocks[0].qa).toMatchObject({ reviewed: false });
    expect(r.result.page.timings.qaMs).toBeGreaterThanOrEqual(0);
    const off = new TranslateService(memoryDb(), secrets, napiBackend, async () => settingsWith({ qaMode: 'fix' }), m.fetchImpl);
    off.compactTiles = false;
    await off.translate(page.bytes, 'image/png');
    expect(m.calls.filter((c) => isReview(c.body))).toHaveLength(1);
  });

  it('never in "best" quality', async () => {
    const page = await makeMangaPage(800, 1100, [{ cx: 220, cy: 260, rx: 120, ry: 170, text: 'はいはいはい' }]);
    const m = mock((body) => (isReview(body) ? JSON.stringify({ reviews: [] }) : mangaAnswer(page.bubbles)));
    const svc = new TranslateService(memoryDb(), secrets, napiBackend, async () => settingsWith({ qaMode: 'fix', qaBatch: true, quality: 'best' }), m.fetchImpl);
    svc.compactTiles = false;
    await svc.translate(page.bytes, 'image/png');
    expect(m.calls.filter((c) => isReview(c.body))).toHaveLength(1);
  });
  void QA_BATCH;
});

describe('the next page is made ready while the model works', () => {
  it('decoding and the text check of page N+1 start before page N leaves the model', async () => {
    const pages = await Promise.all([0, 1, 2].map((i) => makeMangaPage(800, 1100, [{ cx: 220, cy: 260, rx: 120, ry: 170, text: `たなかさん${i}` }, { cx: 580, cy: 700, rx: 110, ry: 160, text: 'どこへ行くの' }])));
    const decoded: { len: number; at: number }[] = [];
    const backend: ImageBackend = { ...napiBackend, decode: async (bytes, mime) => (decoded.push({ len: bytes.length, at: performance.now() }), napiBackend.decode(bytes, mime)) };
    const m = mock(() => mangaAnswer(pages[0].bubbles), 400);
    const svc = new TranslateService(memoryDb(), secrets, backend, async () => settingsWith(), m.fetchImpl);
    svc.compactTiles = false;
    const queue = new TaskQueue(1);
    const t0 = performance.now();
    const results = await Promise.all(
      pages.map((p, i) =>
        queue.add({
          key: `p${i}`,
          priority: 10 - i,
          run: () => svc.translate(p.bytes, 'image/png'),
          prepare: () => svc.prefetch(p.bytes, 'image/png'),
        }),
      ),
    );
    const total = performance.now() - t0;
    const firstDecode = (i: number) => decoded.find((d) => d.len === pages[i].bytes.length)!.at;
    // Page 2 was decoded while page 1 was in the model; page 3 while page 2 was.
    expect(firstDecode(1)).toBeLessThan(m.calls[0].done!);
    expect(firstDecode(2)).toBeLessThan(m.calls[1].done!);
    expect(results.map((r) => !!r.result.page.timings.prefetched)).toEqual([false, true, true]);
    // Each picture decoded once (prepared ahead, then used).
    for (const i of [1, 2]) expect(decoded.filter((d) => d.len === pages[i].bytes.length)).toHaveLength(1);
    // Three model calls of 400 ms each and little else on the way.
    expect(total).toBeLessThan(3 * 400 + 2500);
  });
});

describe('cache size', () => {
  it('measures the cache, drops the least recently used pages past the cap, measures old records once', async () => {
    const db = memoryDb();
    const m = mock(() => '{}');
    const svc = new TranslateService(db, secrets, napiBackend, async () => settingsWith({ cacheMaxMb: 50 }), m.fetchImpl);
    svc.compactTiles = false;
    const keys: string[] = [];
    for (let i = 0; i < 3; i++) keys.push((await svc.translate(await artOnly(i), 'image/png')).result.key);
    const usage = await svc.cacheUsage();
    expect(usage).toMatchObject({ results: 3, maxMb: 50 });
    expect(usage.usedBytes).toBeGreaterThan(0);
    // A record from an older version: no size record yet.
    const old = structuredClone(db.map.get(`results/${keys[0]}`)) as StoredResult;
    db.map.delete(`kv/cache:${keys[0]}`);
    delete old.size;
    db.map.set(`results/${keys[0]}`, old);
    expect((await svc.cacheUsage()).usedBytes).toBe(usage.usedBytes);
    expect(db.map.has(`kv/cache:${keys[0]}`)).toBe(true);
    // Used again: the first page is now the most recent.
    await new Promise((r) => setTimeout(r, 5));
    await svc.translate(await artOnly(0), 'image/png');
    const one = (db.map.get(`kv/cache:${keys[1]}`) as { size: number }).size;
    // A cap that holds about two pages: the least recently used one (page 2) goes.
    const dropped = await svc.pruneCache(365, (usage.usedBytes - one / 2) / 1048576);
    expect(dropped).toBe(1);
    expect(db.map.has(`results/${keys[1]}`)).toBe(false);
    expect(db.map.has(`kv/cache:${keys[1]}`)).toBe(false);
    expect(db.map.has(`results/${keys[0]}`)).toBe(true);
    // The cache cleared from the settings: the size records go too.
    for (const k of [...db.map.keys()]) if (k.startsWith('results/')) db.map.delete(k);
    expect((await svc.cacheUsage()).results).toBe(0);
    expect([...db.map.keys()].some((k) => k.startsWith('kv/cache:'))).toBe(false);
  });

  it('pictures are re-stored as lossless WebP in the background: smaller, every pixel the same', async () => {
    const page = await makeMangaPage();
    const m = mock(() => mangaAnswer(page.bubbles));
    const svc = new TranslateService(memoryDb(), secrets, napiBackend, async () => settingsWith(), m.fetchImpl);
    svc.compactDelayMs = 0;
    const { result } = await svc.translate(page.bytes, 'image/png');
    await svc.compactIdle();
    const after = (await svc.getResult(result.key))!;
    expect(after.mime).toBe('image/webp');
    expect(after.size!).toBeLessThan(result.size!);
    const pixels = async (bytes: Uint8Array) => {
      const img = await loadImage(Buffer.from(bytes));
      const c = createCanvas(img.width, img.height);
      c.getContext('2d').drawImage(img, 0, 0);
      return c.getContext('2d').getImageData(0, 0, img.width, img.height).data;
    };
    for (const layer of ['rendered', 'cleaned'] as const) {
      for (const [i, t] of after[layer].entries()) {
        const a = await pixels(result[layer][i].bytes);
        const b = await pixels(t.bytes);
        expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
      }
    }
  });
});
