/* eslint-disable @typescript-eslint/no-explicit-any */
import { MessageChannel } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';
import { AppError, configFromPreset, PageWorkers, runStandalonePipeline, servePages, type PageWorker } from '../src';
import { DEFAULT_PROFILES } from '../src/translate/profiles';
import { jsonResponse, makeMangaPage, napiBackend, toNorm } from './helpers';

// The page pipeline in a worker: here a message channel stands for the thread (the same messages,
// the same copying of everything that goes across).

function config(extra: Record<string, unknown> = {}): any {
  return { mode: 'standalone', privacy: 'cloud', sourceLang: 'ja', targetLang: 'ru', quality: 'balanced', profile: DEFAULT_PROFILES[0], glossary: [], translateSfx: true, sfxStyle: 'translated', vision: { ...configFromPreset('openai', 'gpt-4o'), apiKey: 'k', vision: true }, translator: null, twoStep: true, ...extra };
}

async function setup(opts: { status?: number; delayMs?: number } = {}) {
  const page = await makeMangaPage();
  const seen: { url: string; auth: string | null }[] = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    seen.push({ url, auth: new Headers(init?.headers).get('authorization') });
    if (opts.status) return new Response(JSON.stringify({ error: { message: 'nope' } }), { status: opts.status, headers: { 'content-type': 'application/json' } });
    if (opts.delayMs) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, opts.delayMs);
        init?.signal?.addEventListener('abort', () => (clearTimeout(t), reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
      });
    }
    const body = JSON.parse(String(init?.body));
    const user = JSON.stringify(body.messages.at(-1).content);
    const content = user.includes('image_url')
      ? JSON.stringify({ blocks: page.bubbles.map((b) => ({ box: toNorm(b.textBox, 800, 1100), text: b.text, type: 'DIALOGUE', vertical: true })), entities: [], summary: '' })
      : JSON.stringify({ translations: JSON.parse(/<blocks>\n(.*)\n<\/blocks>/s.exec(body.messages.at(-1).content)?.[1] ?? '[]').map((b: any) => ({ id: b.id, text: `ПЕРЕВОД ${b.id}` })), entities: [], summary: '' });
    return jsonResponse({ choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 10 }, model: body.model });
  };
  return { page, seen, fetchImpl };
}

/** A «worker» over a message channel: servePages answers on the other end. */
function channelWorker(counter?: { made: number; closed: number }): PageWorker {
  const { port1, port2 } = new MessageChannel();
  servePages(port2 as any, napiBackend);
  if (counter) counter.made++;
  const w = port1 as any;
  return {
    postMessage: (m, t) => w.postMessage(m, t),
    addEventListener: (type, fn) => w.addEventListener(type, fn),
    start: () => w.start(),
    terminate: () => {
      if (counter) counter.closed++;
      port1.close();
      port2.close();
    },
  };
}

function diff(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]);
  return d;
}

describe('pages in a background thread', () => {
  it('gives the same page as running here: the texts, the cleaned picture and the original', async () => {
    const { page, fetchImpl } = await setup();
    const here = await runStandalonePipeline({ bytes: page.bytes, config: config(), noSkip: true }, { backend: napiBackend, fetchImpl: fetchImpl as any });
    const pool = new PageWorkers(() => channelWorker(), 2, napiBackend);
    const stages: string[] = [];
    const there = await pool.run({ bytes: page.bytes, config: config(), noSkip: true, onStage: (e) => stages.push(e.stage) }, { backend: napiBackend, fetchImpl: fetchImpl as any });
    expect(there.page.blocks.map((b) => b.translatedText)).toEqual(here.page.blocks.map((b) => b.translatedText));
    expect(there.page.blocks.map((b) => b.bbox)).toEqual(here.page.blocks.map((b) => b.bbox));
    expect(there.cleaned.width).toBe(here.cleaned.width);
    expect(diff(there.cleaned.getRegion(0, 0, 800, 1100).data, here.cleaned.getRegion(0, 0, 800, 1100).data)).toBe(0);
    expect(diff(there.original.getRegion(0, 0, 800, 1100).data, here.original.getRegion(0, 0, 800, 1100).data)).toBe(0);
    // The stage events came across.
    expect(stages).toContain('detecting');
    expect(pool.broken).toBe(false);
    pool.close();
  }, 60000);

  it('the model requests go through the caller (its fetch, the key in the headers); errors keep their code', async () => {
    const { page, fetchImpl, seen } = await setup({ status: 401 });
    const pool = new PageWorkers(() => channelWorker(), 1, napiBackend);
    const err = await pool.run({ bytes: page.bytes, config: config(), noSkip: true }, { backend: napiBackend, fetchImpl: fetchImpl as any }).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe('INVALID_API_KEY');
    expect(seen[0].auth).toBe('Bearer k');
    pool.close();
  }, 60000);

  it('a cancelled page stops in the thread and its model request is cancelled too', async () => {
    const { page, fetchImpl } = await setup({ delayMs: 20000 });
    const pool = new PageWorkers(() => channelWorker(), 1, napiBackend);
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 300);
    const t0 = Date.now();
    const err = await pool.run({ bytes: page.bytes, config: config(), noSkip: true, signal: ctrl.signal }, { backend: napiBackend, fetchImpl: fetchImpl as any }).catch((e) => e);
    expect(err.code).toBe('CANCELLED');
    expect(Date.now() - t0).toBeLessThan(10000);
    pool.close();
  }, 60000);

  it('no thread can start: the page runs here, and the next ones too', async () => {
    const { page, fetchImpl } = await setup();
    let tries = 0;
    const pool = new PageWorkers(() => {
      tries++;
      throw new Error('workers are off');
    }, 2, napiBackend);
    const a = await pool.run({ bytes: page.bytes, config: config(), noSkip: true }, { backend: napiBackend, fetchImpl: fetchImpl as any });
    expect(a.page.blocks.length).toBe(2);
    expect(pool.broken).toBe(true);
    await pool.run({ bytes: page.bytes, config: config(), noSkip: true }, { backend: napiBackend, fetchImpl: fetchImpl as any });
    expect(tries).toBe(1);
  }, 60000);

  it('a thread that fails to load is given up and the page runs here', async () => {
    const { page, fetchImpl } = await setup();
    const pool = new PageWorkers(() => {
      const listeners: Record<string, ((e: any) => void)[]> = {};
      setTimeout(() => listeners.error?.forEach((f) => f({ message: 'script failed' })), 50);
      return { postMessage: () => undefined, addEventListener: (t, f) => (listeners[t] ??= []).push(f), terminate: () => undefined };
    }, 2, napiBackend);
    const out = await pool.run({ bytes: page.bytes, config: config(), noSkip: true }, { backend: napiBackend, fetchImpl: fetchImpl as any });
    expect(out.page.blocks.length).toBe(2);
    expect(pool.broken).toBe(true);
  }, 60000);

  it('two pages at once go to two threads; an idle thread is closed', async () => {
    const { page, fetchImpl } = await setup({ delayMs: 200 });
    const count = { made: 0, closed: 0 };
    const pool = new PageWorkers(() => channelWorker(count), 3, napiBackend, 300);
    const [a, b] = await Promise.all([1, 2].map(() => pool.run({ bytes: page.bytes, config: config(), noSkip: true }, { backend: napiBackend, fetchImpl: fetchImpl as any })));
    expect(a.page.blocks.length).toBe(2);
    expect(b.page.blocks.length).toBe(2);
    expect(count.made).toBe(2);
    await new Promise((r) => setTimeout(r, 800));
    expect(count.closed).toBe(2);
    expect(pool.busy).toBe(0);
  }, 60000);

  it('the detector of the calling document is asked from the thread (the same one each time)', async () => {
    const { page, fetchImpl } = await setup();
    let calls = 0;
    const detect = async (img: any) => {
      calls++;
      expect(img.data).toBeInstanceOf(Uint8ClampedArray);
      return { boxes: [] };
    };
    const pool = new PageWorkers(() => channelWorker(), 1, napiBackend);
    const out = await pool.run({ bytes: page.bytes, config: config({ detector: true }), noSkip: true }, { backend: napiBackend, fetchImpl: fetchImpl as any, detect });
    expect(calls).toBeGreaterThan(0);
    expect(out.page.blocks.length).toBe(2);
    pool.close();
  }, 60000);
});
