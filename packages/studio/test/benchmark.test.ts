import { describe, expect, it } from 'vitest';
import { benchmarkOf, fmtSeconds } from '../src/benchmark';

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
