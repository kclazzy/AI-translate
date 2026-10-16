import { describe, expect, it } from 'vitest';
import { AppError } from '../src/errors';
import { OpenAICompatibleProvider } from '../src/llm/openai';
import { configFromPreset } from '../src/llm/presets';
import { CONTEXT_LEVELS, estimateTokens, fitRequest, parseContextError } from '../src/translate/budget';
import { emptyContext, entityKey, mergeContext, type TranslationContext } from '../src/translate/context';
import { contextData } from '../src/translate/prompt';
import { DEFAULT_PROFILES } from '../src/translate/profiles';
import { translateBlocks } from '../src/translate/translator';
import { jsonResponse } from './helpers';

/** A series context as it looks after a long chapter: every list at its limit, long lines. */
function bigContext(): TranslationContext {
  const ctx = emptyContext('s', 's');
  ctx.entities = Array.from({ length: 300 }, (_, i) => ({ source: `Term number ${i} of the long series`, target: `Термин номер ${i} длинной серии`, kind: 'term' as const, locked: false }));
  ctx.summaries = Array.from({ length: 8 }, (_, i) => `Страница ${i}: `.padEnd(400, 'длинный пересказ событий '));
  ctx.recentLines = Array.from({ length: 16 }, (_, i) => ({ src: `Line ${i} `.padEnd(300, 'long english dialogue '), dst: `Реплика ${i} `.padEnd(300, 'длинная реплика ') }));
  return ctx;
}

const input = (context?: TranslationContext) => ({ sourceLang: 'en', targetLang: 'ru', profile: DEFAULT_PROFILES[0], glossary: [], translateSfx: true, context });

/** Ollama stand-in with a fixed window: refuses a prompt that does not fit, like the real server. */
function ollama(numCtx: number, answer: (body: any) => string, opts: { refuseAll?: boolean } = {}) {
  const bodies: any[] = [];
  const fetchImpl = async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    const prompt = body.messages.reduce((n: number, m: { content: string }) => n + estimateTokens(m.content), 0);
    if (opts.refuseAll || prompt + body.options.num_predict > body.options.num_ctx) {
      return jsonResponse({ error: { code: 400, message: `request (${prompt + 200} tokens) exceeds the available context size (${numCtx} tokens), try increasing it`, type: 'exceed_context_size_error', n_prompt_tokens: prompt + 200, n_ctx: numCtx } }, 400);
    }
    return jsonResponse({ message: { content: answer(body) }, done_reason: 'stop', prompt_eval_count: prompt, eval_count: 50 });
  };
  const provider = new OpenAICompatibleProvider({ ...configFromPreset('ollama', 'qwen3.5:9b'), numCtx }, fetchImpl as any);
  return { provider, bodies };
}

const answerAll = (body: any) => {
  const user = body.messages[body.messages.length - 1].content as string;
  const ids = [...user.matchAll(/"id":"(b\d+)"/g)].map((m) => m[1]);
  return JSON.stringify({ translations: ids.map((id) => ({ id, text: `перевод ${id}` })) });
};

describe('token budget of a request (8285 > 8192)', () => {
  it('the full series context is trimmed: page names first, then the most recent', () => {
    const ctx = bigContext();
    const full = contextData(input(ctx), CONTEXT_LEVELS[0], ['We met Term number 3 of the long series today']);
    const names = JSON.parse(full.replace(/^<context>\n|\n<\/context>$/g, '')).names as { source: string }[];
    expect(names.length).toBe(50);
    // The term on this page is there, though it was learned first (old code sent the first 120 only).
    expect(names.some((n) => n.source === 'Term number 3 of the long series')).toBe(true);
    expect(names.some((n) => n.source === 'Term number 299 of the long series')).toBe(true);
    // Every level is smaller than the one before; the last sends nothing.
    const sizes = CONTEXT_LEVELS.map((l) => estimateTokens(contextData(input(ctx), l)));
    for (let i = 1; i < sizes.length; i++) expect(sizes[i]).toBeLessThan(sizes[i - 1]);
    expect(contextData(input(ctx), CONTEXT_LEVELS[CONTEXT_LEVELS.length - 1])).toBe('');
    expect(sizes[0]).toBeLessThan(4000);
  });

  it('chooses the fullest level that fits, and none when nothing fits', () => {
    const at = (l: number) => [9000, 6000, 4000, 2000][l];
    expect(fitRequest(8192, 2000, at)?.level).toBe(2);
    expect(fitRequest(8192, 2000, at)?.maxTokens).toBe(2000);
    expect(fitRequest(undefined, 2000, at)).toEqual({ level: 0, maxTokens: 2000, inputTokens: 9000 });
    expect(fitRequest(1024, 2000, at)).toBeNull();
  });

  it('a page with a huge series context fits an 8192 window: prompt + answer room ≤ window', async () => {
    const { provider, bodies } = ollama(8192, answerAll);
    const blocks = Array.from({ length: 12 }, (_, i) => ({ id: `b${i + 1}`, type: 'DIALOGUE' as const, text: `Line ${i} of this page with a few words` }));
    const r = await translateBlocks(provider, input(bigContext()), blocks);
    expect(r.translations.size).toBe(12);
    expect(bodies.length).toBe(1);
    for (const b of bodies) {
      const prompt = b.messages.reduce((n: number, m: { content: string }) => n + estimateTokens(m.content), 0);
      expect(prompt + b.options.num_predict).toBeLessThanOrEqual(8192);
      expect(b.options.num_ctx).toBe(8192);
    }
  });

  it('the server still refusing: one more try with less context, then a clear error — no loop', async () => {
    const { provider, bodies } = ollama(8192, answerAll, { refuseAll: true });
    const blocks = [{ id: 'b1', type: 'DIALOGUE' as const, text: 'Hello' }];
    const err = await translateBlocks(provider, input(bigContext()), blocks).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('CONTEXT_TOO_LONG');
    expect((err as AppError).retryable).toBe(false);
    expect((err as AppError).detail).toContain('окно модели');
    expect(bodies.length).toBe(2);
    // The second request is smaller than the first.
    expect(JSON.stringify(bodies[1].messages).length).toBeLessThan(JSON.stringify(bodies[0].messages).length);
  });

  it('a page too long for the window even without context is translated in halves', async () => {
    const { provider, bodies } = ollama(4096, answerAll);
    const blocks = Array.from({ length: 40 }, (_, i) => ({ id: `b${i + 1}`, type: 'DIALOGUE' as const, text: `This is a fairly long line number ${i} that the character says in the bubble, it keeps going on and on` }));
    const r = await translateBlocks(provider, input(), blocks);
    expect(r.translations.size).toBe(40);
    expect(bodies.length).toBeGreaterThan(1);
    for (const b of bodies) expect(b.options.num_ctx).toBe(4096);
  });

  it('reads both server error shapes', () => {
    expect(parseContextError('request (8285 tokens) exceeds the available context size (8192 tokens), try increasing it')).toEqual({ prompt: 8285, ctx: 8192 });
    expect(parseContextError('{"type":"exceed_context_size_error","n_prompt_tokens":9000,"n_ctx":8192}')).toEqual({ prompt: 9000, ctx: 8192 });
    expect(parseContextError('model not found')).toBeNull();
  });
});

describe('series context stays bounded and consistent', () => {
  it('the same page translated again adds no second summary or lines', () => {
    let ctx = emptyContext('s');
    const up = { page: 'abc', summary: 'Он пришёл', lines: [{ src: 'Hi', dst: 'Привет' }], entities: [{ source: 'Chanter', target: 'Заклинатель', kind: 'term' }] };
    ctx = mergeContext(ctx, up);
    ctx = mergeContext(ctx, up);
    ctx = mergeContext(ctx, { ...up, entities: [{ source: 'CHANTERS', target: 'Певуны', kind: 'term' }] });
    expect(ctx.summaries).toEqual(['Он пришёл']);
    expect(ctx.recentLines).toHaveLength(1);
    expect(ctx.pagesSeen).toBe(1);
    // CHANTER, Chanter, Chanters: one term, the first translation kept.
    expect(ctx.entities).toHaveLength(1);
    expect(ctx.entities[0].target).toBe('Заклинатель');
  });

  it('term keys ignore case, edge punctuation and an English plural', () => {
    expect(entityKey('CHANTERS!')).toBe('chanter');
    expect(entityKey('Boss')).toBe('boss');
    expect(entityKey('Mirror World')).toBe('mirror world');
  });
});
