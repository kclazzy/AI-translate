/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from 'vitest';
import { checkForUpdate, checkVisionModel, configFromPreset, defaultSettings, gpuShare, TranslateService, guessVramGb, MODEL_TIERS, ollamaDelete, ollamaLoaded, ollamaUnloadAll, OpenAICompatibleProvider, pickAsset, pipelineConfigFromSettings, tierForVram } from '../src';
import { TaskQueue } from '../src/util/queue';
import { jsonResponse, napiBackend } from './helpers';

describe('model tiers', () => {
  it('picks the largest model that fits the video memory', () => {
    expect(tierForVram(2).model).toBe('qwen3.5:0.8b');
    expect(tierForVram(5).model).toBe('qwen3.5:2b-q4_K_M');
    expect(tierForVram(8).model).toBe('qwen3.5:4b-q8_0');
    expect(tierForVram(12).model).toBe('qwen3.5:9b-q4_K_M');
    expect(tierForVram(24).model).toBe('qwen3.5:9b-q8_0');
    expect(tierForVram(1).model).toBe(MODEL_TIERS[0].model);
    // Every model leaves room for the picture and the answer.
    for (const t of MODEL_TIERS) expect(t.sizeGb).toBeLessThan(t.vramGb * 0.85);
  });
  it('recognises video cards from the WebGL renderer string', () => {
    expect(guessVramGb('ANGLE (NVIDIA, NVIDIA GeForce RTX 5070 (0x00002F04) Direct3D11 vs_5_0 ps_5_0, D3D11)')).toBe(12);
    expect(guessVramGb('ANGLE (NVIDIA, NVIDIA GeForce RTX 5070 Ti Direct3D11)')).toBe(16);
    expect(guessVramGb('NVIDIA GeForce GTX 1650')).toBe(4);
    expect(guessVramGb('Intel(R) UHD Graphics 620')).toBe(2);
    expect(guessVramGb('Some Unknown GPU')).toBeUndefined();
  });
});

describe('Ollama native API', () => {
  it('turns thinking off, raises the context and sends images natively', async () => {
    let url = '';
    let body: Record<string, unknown> = {};
    const p = new OpenAICompatibleProvider(configFromPreset('ollama', 'o'), async (u, i) => {
      url = u;
      body = JSON.parse(String(i?.body));
      return jsonResponse({ message: { content: '{"ok":true}' }, prompt_eval_count: 10, eval_count: 3, model: 'qwen3.5:9b-q4_K_M' });
    });
    const r = await p.complete({ system: 's', messages: [{ role: 'user', content: [{ type: 'image', mime: 'image/png', base64: 'AAAA' }, { type: 'text', text: 'read' }] }], json: true });
    expect(url).toBe('http://localhost:11434/api/chat');
    expect(body.think).toBe(false);
    expect((body.options as { num_ctx: number }).num_ctx).toBeGreaterThanOrEqual(8192);
    expect(body.format).toBe('json');
    expect((body.messages as { images?: string[]; content: string }[])[1]).toEqual({ role: 'user', content: 'read', images: ['AAAA'] });
    expect(r).toMatchObject({ text: '{"ok":true}', inputTokens: 10, outputTokens: 3 });
  });
  it('deletes a model', async () => {
    let seen = '';
    await ollamaDelete('http://localhost:11434/v1', 'qwen3.5:0.8b', async (u, i) => {
      seen = `${i?.method} ${u} ${i?.body}`;
      return new Response(null, { status: 200 });
    });
    expect(seen).toBe('DELETE http://localhost:11434/api/delete {"model":"qwen3.5:0.8b"}');
  });
});

describe('model self-test', () => {
  const cfg = { ...configFromPreset('ollama', 'o'), vision: true };
  const answer = (content: string) => async () => jsonResponse({ message: { content } });
  it('reports a working model with what it read', async () => {
    const r = await checkVisionModel(cfg, { backend: napiBackend, fetchImpl: answer('{"text":"こんにちは！","translation":"Привет!"}') });
    expect(r).toMatchObject({ level: 'ok', read: 'こんにちは！', translation: 'Привет!', model: cfg.model });
    expect(r.message).toContain('Модель работает');
  });
  it('flags a model that misreads the picture', async () => {
    const r = await checkVisionModel(cfg, { backend: napiBackend, fetchImpl: answer('{"text":"hello"}') });
    expect(r.level).toBe('partial');
  });
  it('explains failures', async () => {
    const r = await checkVisionModel(cfg, { backend: napiBackend, fetchImpl: async () => jsonResponse({ error: 'model not found' }, 404) });
    expect(r.level).toBe('fail');
    expect(r.message).toContain('не найдена');
  });
});

describe('queue position', () => {
  it('reports running, waiting with how many are ahead, and unknown', async () => {
    const q = new TaskQueue(1);
    let release!: () => void;
    const block = new Promise<void>((r) => (release = r));
    void q.add({ key: 'a', priority: 0, run: () => block });
    void q.add({ key: 'b', priority: 0, run: async () => undefined });
    void q.add({ key: 'c', priority: 5, run: async () => undefined });
    await Promise.resolve();
    expect(q.position('a')).toEqual({ state: 'running' });
    expect(q.position('c')).toEqual({ state: 'pending', ahead: 1 });
    expect(q.position('b')).toEqual({ state: 'pending', ahead: 2 });
    expect(q.position('zzz')).toEqual({ state: 'unknown' });
    release();
  });
});

describe('release assets', () => {
  it('finds the file for each edition', () => {
    const info = { assets: [{ name: 'ai-translate-desktop-v0.3.0.zip', url: 'd' }, { name: 'ai-translate-android-v0.3.0.apk', url: 'a' }, { name: 'ai-translate-ios-v0.3.0-unsigned.ipa', url: 'i' }] };
    expect(pickAsset(info, 'desktop')?.url).toBe('d');
    expect(pickAsset(info, 'android')?.url).toBe('a');
    expect(pickAsset(info, 'ios')?.url).toBe('i');
    expect(pickAsset({ assets: [] }, 'desktop')).toBeUndefined();
  });
});

describe('video memory', () => {
  it('passes keep-alive minutes to Ollama and 0 unloads right away', async () => {
    const bodies: Record<string, unknown>[] = [];
    const f = async (_u: string, i?: RequestInit) => {
      bodies.push(JSON.parse(String(i?.body)));
      return jsonResponse({ message: { content: 'ok' } });
    };
    await new OpenAICompatibleProvider({ ...configFromPreset('ollama', 'o'), keepAliveMin: 15 }, f).complete({ system: 's', messages: [{ role: 'user', content: 'x' }] });
    await new OpenAICompatibleProvider({ ...configFromPreset('ollama', 'o'), keepAliveMin: 0 }, f).complete({ system: 's', messages: [{ role: 'user', content: 'x' }] });
    expect(bodies.map((b) => b.keep_alive)).toEqual(['15m', 0]);
  });
  it('lists loaded models and unloads them all', async () => {
    const calls: string[] = [];
    const f = async (u: string, i?: RequestInit) => {
      calls.push(`${i?.method ?? 'GET'} ${u} ${i?.body ?? ''}`);
      if (u.endsWith('/api/ps')) return jsonResponse({ models: [{ name: 'qwen3.5:9b-q4_K_M', size_vram: 7e9 }] });
      return jsonResponse({});
    };
    expect(await ollamaLoaded('http://localhost:11434/v1', f)).toEqual([{ name: 'qwen3.5:9b-q4_K_M', sizeVram: 7e9, size: 7e9 }]);
    expect(await ollamaUnloadAll('http://localhost:11434/v1', f)).toEqual(['qwen3.5:9b-q4_K_M']);
    expect(calls.at(-1)).toBe('POST http://localhost:11434/api/generate {"model":"qwen3.5:9b-q4_K_M","keep_alive":0}');
    expect(await ollamaLoaded('http://localhost:11434/v1', async () => { throw new TypeError('offline'); })).toEqual([]);
  });
  it('settings decide how long the model stays loaded', () => {
    const s = defaultSettings();
    expect(pipelineConfigFromSettings(s).vision?.keepAliveMin).toBe(5);
    expect(pipelineConfigFromSettings({ ...s, gpuKeepAliveMin: 0 }).vision?.keepAliveMin).toBe(0);
  });
});

describe('update check without the GitHub API', () => {
  it('uses the releases/latest redirect when the API is rate-limited and builds the file links', async () => {
    const f = async (u: string) => {
      if (u.includes('api.github.com')) return new Response('{"message":"API rate limit exceeded"}', { status: 403 });
      if (u.endsWith('/releases/latest')) {
        const r = new Response('', { status: 200 });
        Object.defineProperty(r, 'url', { value: 'https://github.com/kclazzy/AI-translate/releases/tag/v0.4.0' });
        return r;
      }
      throw new Error(`unexpected ${u}`);
    };
    const info = await checkForUpdate('0.3.2', f);
    expect(info).toMatchObject({ latest: '0.4.0', available: true });
    expect(pickAsset(info, 'desktop')?.url).toBe('https://github.com/kclazzy/AI-translate/releases/download/v0.4.0/ai-translate-desktop-v0.4.0.zip');
    expect(pickAsset(info, 'android')?.url).toBe('https://github.com/kclazzy/AI-translate/releases/download/v0.4.0/ai-translate-android-v0.4.0.apk');
  });
});

describe('history housekeeping', () => {
  it('drops entries older than the limit and beyond the maximum', async () => {
    const store = new Map<string, unknown>();
    const db = {
      entries: async () => [...store.entries()],
      delete: async (_s: string, k: string) => void store.delete(k),
    } as unknown as ConstructorParameters<typeof TranslateService>[0];
    const day = 86_400_000;
    for (let i = 0; i < 5; i++) store.set(`k${i}`, { key: `k${i}`, date: new Date(Date.now() - i * 10 * day).toISOString(), pages: 1, targetLang: 'ru', model: 'm', status: 'done' });
    const svc = new TranslateService(db, {} as never, napiBackend, async () => defaultSettings());
    expect(await svc.pruneHistory(25)).toBe(2); // 30 and 40 days old
    expect(await svc.pruneHistory(365, 2)).toBe(1); // keep the newest 2
    expect([...store.keys()].sort()).toEqual(['k0', 'k1']);
  });
});

describe('speed and the local model', () => {
  it('fast mode: smaller picture and a check without a model call, only for local models', () => {
    const s = { ...defaultSettings(), fastLocal: true, quality: 'best' as const };
    const c = pipelineConfigFromSettings(s);
    expect(c.quality).toBe('fast');
    expect(c.qa).toBe('rules');
    const cloud = { ...s, providers: [...s.providers, { ...configFromPreset('openai', 'oa') }], visionProviderId: 'oa' };
    expect(pipelineConfigFromSettings(cloud)).toMatchObject({ quality: 'best', qa: 'fix' });
  });
  it('context window follows the video memory and holds a page picture, the prompt and the answer', () => {
    // 1568 px picture (balanced) ≈ 2240 tokens + prompt + answer: more than 8 K.
    expect(pipelineConfigFromSettings({ ...defaultSettings(), gpuVramGb: 8 }).vision?.numCtx).toBe(10240);
    expect(pipelineConfigFromSettings({ ...defaultSettings(), gpuVramGb: 8, quality: 'fast' }).vision?.numCtx).toBe(8192);
    expect(pipelineConfigFromSettings({ ...defaultSettings(), gpuVramGb: 16 }).vision?.numCtx).toBe(16384);
    // Fixed per model: the provider never changes it between requests (that reloads the model).
    expect(pipelineConfigFromSettings(defaultSettings()).vision?.fixedCtx).toBe(true);
  });
  it('the same model gets the same context window for reading and for translating', () => {
    const s = defaultSettings();
    const c = pipelineConfigFromSettings({ ...s, translationProviderId: s.visionProviderId, twoStepTranslation: true });
    expect(c.translator?.numCtx).toBe(c.vision?.numCtx);
    const big = pipelineConfigFromSettings({ ...s, quality: 'best', gpuVramGb: 12, glossary: Array.from({ length: 150 }, (_, i) => ({ id: `g${i}`, source: `s${i}`, target: `t${i}`, matchMode: 'exact' as const, caseSensitive: false, forbidden: [], enabled: true })) });
    expect(big.vision?.numCtx).toBe(14336);
  });
  it('reports tokens per second and sends num_ctx to Ollama', async () => {
    let body: Record<string, any> = {};
    const p = new OpenAICompatibleProvider({ ...configFromPreset('ollama', 'o'), numCtx: 8192 }, async (_u, i) => {
      body = JSON.parse(String(i?.body));
      return jsonResponse({ message: { content: 'ok' }, eval_count: 120, eval_duration: 2e9 });
    });
    const r = await p.complete({ system: 's', messages: [{ role: 'user', content: 'x' }] });
    expect(body.options.num_ctx).toBe(8192);
    expect(r.tokensPerSecond).toBe(60);
  });
  it('knows when a model spills out of video memory', () => {
    expect(gpuShare({ name: 'm', sizeVram: 7e9, size: 7e9 })).toBe(1);
    expect(gpuShare({ name: 'm', sizeVram: 5e9, size: 10e9 })).toBe(0.5);
  });
});

describe('provider guides', () => {
  it('every cloud service says where to get the key, which model to pick and what it costs', async () => {
    const { PROVIDER_PRESETS } = await import('../src/llm/presets');
    for (const p of PROVIDER_PRESETS) {
      expect(p.guide?.steps.length, p.preset).toBeGreaterThan(0);
      if (!p.needsKey) continue;
      expect(p.guide!.keyUrl, p.preset).toMatch(/^https:\/\//);
      expect(p.guide!.cost, p.preset).toBeTruthy();
    }
  });
});
