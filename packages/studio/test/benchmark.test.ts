import { describe, expect, it } from 'vitest';
import { benchmarkOf, compareVariants, fmtSeconds } from '../src/benchmark';

const usage = [{ provider: 'p', model: 'qwen-vl', inputTokens: 1200, outputTokens: 300, costUsd: 0 }];

describe('speed benchmark', () => {
  it('splits the page time into stages and points at the slowest one', () => {
    const b = benchmarkOf({ timings: { decodeMs: 50, detectMs: 4000, ocrMs: 0, translateMs: 1500, cleanMs: 300, renderMs: 200, totalMs: 6000 }, usage }, 6400);
    const ms = Object.fromEntries(b.rows.map((r) => [r.stage, r.ms]));
    expect(ms).toEqual({ read: 4050, translate: 1500, qa: null, erase: 300, lama: null, render: 200, total: 6400 });
    expect(b.slowest).toBe('read');
    expect(b.hint).toContain('Быстро');
    expect(b.model).toBe('qwen-vl');
    expect(b.tokens).toEqual({ input: 1200, output: 300 });
  });

  it('shows LaMa on its own line, taken out of the cleaning time', () => {
    const b = benchmarkOf({ timings: { decodeMs: 10, detectMs: 100, translateMs: 100, cleanMs: 5000, inpaintMs: 4800, qaMs: 50 } as never, usage: [] }, 5300, 'm');
    const ms = Object.fromEntries(b.rows.map((r) => [r.stage, r.ms]));
    expect(ms.erase).toBe(200);
    expect(ms.lama).toBe(4800);
    expect(ms.qa).toBe(50);
    expect(b.slowest).toBe('lama');
    expect(b.hint).toContain('WebGPU');
    expect(b.model).toBe('m');
    expect(b.tokens).toBeNull();
  });

  it('copes with a result without timings', () => {
    const b = benchmarkOf({ timings: {}, usage: [] }, 0);
    expect(b.rows.every((r) => r.ms === null)).toBe(true);
    expect(b.slowest).toBeNull();
    expect(fmtSeconds(null)).toBe('—');
  });
});

describe('speed comparison: a local and an online model, with and without «Сначала распознавание»', () => {
  const local = { id: 'ol', kind: 'openai-compatible', preset: 'ollama', baseUrl: 'http://localhost:11434/v1', model: 'qwen3.5:9b', vision: true, label: 'Ollama' } as never;
  const cloud = { id: 'gm', kind: 'openai-compatible', preset: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-flash', vision: true, label: 'Gemini' } as never;
  const text = { id: 'ds', kind: 'openai-compatible', preset: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', vision: false, label: 'DeepSeek' } as never;
  it('plans every variant there is, the local ones first', () => {
    const v = compareVariants([text, cloud, local], { keyed: new Set(['gm']), recognition: true });
    expect(v.map((x) => `${x.providerId}:${x.cascade ? 'c' : 'v'}`)).toEqual(['ol:v', 'ol:c', 'gm:v', 'gm:c']);
    expect(v.find((x) => x.providerId === 'gm')!.settings).toMatchObject({ visionProviderId: 'gm', translationProviderId: null, privacy: 'cloud', pipeline: 'standalone', readMode: 'vision' });
    expect(v.find((x) => x.providerId === 'ol')!.settings.privacy).toBe('local');
  });
  it('an online model without a key, or no recognition: those variants are left out', () => {
    expect(compareVariants([cloud, local], { keyed: new Set(), recognition: false }).map((x) => `${x.providerId}:${x.cascade ? 'c' : 'v'}`)).toEqual(['ol:v']);
  });
});
