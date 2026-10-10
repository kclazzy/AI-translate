/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from 'vitest';
import { AnthropicProvider, systemBlocks } from '../src/llm/anthropic';
import { OpenAICompatibleProvider } from '../src/llm/openai';
import { configFromPreset, estimateCost } from '../src/llm/presets';
import { usageFrom } from '../src/translate/translator';

const jsonResponse = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

function capture(answer: (n: number, body: any) => unknown) {
  const bodies: any[] = [];
  const f = async (_u: string, init?: RequestInit) => {
    const b = JSON.parse(String(init?.body));
    bodies.push(b);
    return jsonResponse(answer(bodies.length, b));
  };
  return { bodies, f };
}

const longSystem = 'You translate manga dialogue faithfully. '.repeat(120); // ~4900 chars ≈ 1400 tokens
const anthropicCfg = () => ({ ...configFromPreset('anthropic', 'a'), apiKey: 'k', model: 'claude-sonnet-4-5' });
const claudeAnswer = (usage: Record<string, number>) => ({ content: [{ type: 'text', text: '"a":1}' }], usage, model: 'claude-sonnet-4-5', stop_reason: 'end_turn' });

describe('Anthropic prompt caching', () => {
  it('marks a long system prompt with cache_control', async () => {
    const { bodies, f } = capture(() => claudeAnswer({ input_tokens: 10, output_tokens: 5 }));
    await new AnthropicProvider(anthropicCfg(), f as any).complete({ system: longSystem, messages: [{ role: 'user', content: 'x' }], json: true });
    expect(bodies[0].system).toEqual([{ type: 'text', text: longSystem, cache_control: { type: 'ephemeral' } }]);
  });

  it('does not mark a short system prompt', async () => {
    const { bodies, f } = capture(() => claudeAnswer({ input_tokens: 10, output_tokens: 5 }));
    await new AnthropicProvider(anthropicCfg(), f as any).complete({ system: 'Short prompt.', messages: [{ role: 'user', content: 'x' }] });
    expect(bodies[0].system).toEqual([{ type: 'text', text: 'Short prompt.' }]);
    expect(JSON.stringify(bodies[0])).not.toContain('cache_control');
  });

  it('uses the higher Haiku minimum', () => {
    expect(JSON.stringify(systemBlocks(longSystem, 'claude-haiku-4-5'))).not.toContain('cache_control');
    expect(JSON.stringify(systemBlocks(longSystem.repeat(2), 'claude-haiku-4-5'))).toContain('cache_control');
  });

  it('parses cache read and write tokens into the result', async () => {
    const { f } = capture(() => claudeAnswer({ input_tokens: 50, output_tokens: 20, cache_read_input_tokens: 1400, cache_creation_input_tokens: 0 }));
    const r = await new AnthropicProvider(anthropicCfg(), f as any).complete({ system: longSystem, messages: [{ role: 'user', content: 'x' }], json: true });
    expect(r).toMatchObject({ inputTokens: 1450, outputTokens: 20, cachedInputTokens: 1400 });
    expect(r.cacheWriteTokens).toBeUndefined();

    const w = capture(() => claudeAnswer({ input_tokens: 50, output_tokens: 20, cache_creation_input_tokens: 1400 }));
    const r2 = await new AnthropicProvider(anthropicCfg(), w.f as any).complete({ system: longSystem, messages: [{ role: 'user', content: 'x' }], json: true });
    expect(r2).toMatchObject({ inputTokens: 1450, cacheWriteTokens: 1400 });
    expect(r2.cachedInputTokens).toBeUndefined();
  });
});

describe('OpenAI automatic prompt caching', () => {
  it('parses prompt_tokens_details.cached_tokens', async () => {
    const { bodies, f } = capture(() => ({ choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2000, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 1536 } }, model: 'gpt-4.1-mini' }));
    const r = await new OpenAICompatibleProvider({ ...configFromPreset('openai', 'o'), apiKey: 'k' }, f as any).complete({ system: longSystem, messages: [{ role: 'user', content: 'x' }] });
    expect(r).toMatchObject({ inputTokens: 2000, outputTokens: 30, cachedInputTokens: 1536 });
    expect(JSON.stringify(bodies[0])).not.toContain('cache_control');
  });

  it('leaves cachedInputTokens unset when nothing was cached', async () => {
    const { f } = capture(() => ({ choices: [{ message: { content: 'hi' } }], usage: { prompt_tokens: 20, completion_tokens: 3 } }));
    const r = await new OpenAICompatibleProvider({ ...configFromPreset('openai', 'o'), apiKey: 'k' }, f as any).complete({ system: 's', messages: [{ role: 'user', content: 'x' }] });
    expect(r.cachedInputTokens).toBeUndefined();
  });
});

describe('Ollama retry after a cut-off answer', () => {
  const cut = { message: { content: '{"blocks":[{"box":[1,2' }, done_reason: 'length', prompt_eval_count: 3000, eval_count: 4096 };
  const done = { message: { content: '{"blocks":[]}' }, done_reason: 'stop', eval_count: 10 };

  it('keeps num_ctx and doubles num_predict', async () => {
    const { bodies, f } = capture((n) => (n === 1 ? cut : done));
    const p = new OpenAICompatibleProvider({ ...configFromPreset('ollama', 'qwen3.5:9b'), numCtx: 8192, fixedCtx: true }, f as any);
    const r = await p.complete({ system: '', messages: [{ role: 'user', content: 'x' }], json: true, maxTokens: 4096 });
    expect(bodies.map((b) => b.options.num_ctx)).toEqual([8192, 8192]);
    expect(bodies.map((b) => b.options.num_predict)).toEqual([4096, 8192]);
    expect(r.text).toBe('{"blocks":[]}');
  });

  it('caps num_predict at 16384 and defaults num_ctx to 8192', async () => {
    const { bodies, f } = capture((n) => (n === 1 ? cut : done));
    const p = new OpenAICompatibleProvider(configFromPreset('ollama', 'qwen3.5:9b'), f as any);
    await p.complete({ system: '', messages: [{ role: 'user', content: 'x' }], maxTokens: 12000 });
    expect(bodies.map((b) => b.options.num_ctx)).toEqual([8192, 8192]);
    expect(bodies.map((b) => b.options.num_predict)).toEqual([12000, 16384]);
  });

  it('does not retry when num_predict is already at the cap', async () => {
    const { bodies, f } = capture(() => cut);
    const p = new OpenAICompatibleProvider({ ...configFromPreset('ollama', 'qwen3.5:9b'), numCtx: 16384 }, f as any);
    const r = await p.complete({ system: '', messages: [{ role: 'user', content: 'x' }], maxTokens: 16384 });
    expect(bodies).toHaveLength(1);
    expect(r.truncated).toBe(true);
  });
});

describe('cost with prompt caching', () => {
  const cfg = { ...configFromPreset('anthropic', 'a'), priceInput: 3, priceOutput: 15 };
  const provider = { config: cfg } as any;

  it('prices cache reads at 10 % and cache writes at 125 % of the input price', () => {
    // 1000 plain + 4000 read + 2000 written input tokens, 500 output.
    const expected = (3 * (1000 + 0.1 * 4000 + 1.25 * 2000) + 15 * 500) / 1e6;
    expect(estimateCost(cfg, 7000, 500, 4000, 2000)).toBeCloseTo(expected, 12);
    expect(estimateCost(cfg, 7000, 500)).toBeCloseTo((3 * 7000 + 15 * 500) / 1e6, 12);
  });

  it('usageFrom passes the cache counts through', () => {
    const u = usageFrom(provider, { model: 'm', inputTokens: 5000, outputTokens: 100, cachedInputTokens: 4000 });
    expect(u.cachedTokens).toBe(4000);
    expect(u.costUsd).toBeCloseTo((3 * (1000 + 400) + 15 * 100) / 1e6, 12);
    const w = usageFrom(provider, { model: 'm', inputTokens: 5000, outputTokens: 100, cacheWriteTokens: 4000 });
    expect(w.cachedTokens).toBeUndefined();
    expect(w.costUsd).toBeCloseTo((3 * (1000 + 5000) + 15 * 100) / 1e6, 12);
  });
});
