import { describe, expect, it } from 'vitest';
import { configFromPreset } from '../src/llm/presets';
import type { PipelineConfig } from '../src/pipeline/config';
import { addAnswer, createDebug, DEBUG_LIMITS, scrubSecrets } from '../src/pipeline/debug';
import { runPipeline } from '../src/pipeline/run';
import { pipelineHash } from '../src/pipeline/config';
import { DEFAULT_PROFILES } from '../src/translate/profiles';
import { makeMangaPage, mockOpenAi, napiBackend, toNorm } from './helpers';

const KEY = 'sk-test-SECRET-1234567890abcdef';

function config(over: Partial<PipelineConfig> = {}): PipelineConfig {
  return {
    mode: 'standalone',
    privacy: 'cloud',
    sourceLang: 'auto',
    targetLang: 'ru',
    quality: 'balanced',
    profile: DEFAULT_PROFILES[0],
    glossary: [],
    translateSfx: true,
    sfxStyle: 'translated',
    vision: { ...configFromPreset('openai', 'gpt-test'), model: 'gpt-test', vision: true, apiKey: KEY },
    translator: null,
    ...over,
  };
}

describe('page debug (problem report)', () => {
  it('keeps the raw model answers, the model boxes and the steps; no secrets', async () => {
    const { bytes, bubbles } = await makeMangaPage();
    const mock = mockOpenAi((body) => {
      if (Array.isArray(body.messages[1]?.content)) {
        return JSON.stringify({
          blocks: bubbles.map((b, i) => ({ box: toNorm(b.textBox, 800, 1100), text: b.text, translation: ['Подожди!', 'Куда?'][i], type: 'DIALOGUE', vertical: true })),
          // The model echoes a key it should never have seen: it is cut out.
          summary: `debug ${KEY}`,
        });
      }
      return JSON.stringify({ blocks: [] });
    });
    const out = await runPipeline({ bytes, config: config({ qa: 'report' }) }, { backend: napiBackend, fetchImpl: mock.fetchImpl });
    const d = out.page.debug!;
    expect(d).toBeTruthy();
    expect(d.answers[0].stage).toBe('read');
    expect(d.answers[0].model).toBe('gpt-test');
    expect(d.answers[0].text).toContain('Подожди!');
    expect(d.answers.some((a) => a.stage === 'review')).toBe(true);
    expect(d.modelBlocks).toHaveLength(2);
    expect(d.modelBlocks[0].text).toBe(bubbles[0].text);
    expect(d.modelBlocks[0].translation).toBe('Подожди!');
    expect(Array.isArray(d.steps)).toBe(true);
    const json = JSON.stringify(d);
    expect(json).not.toContain(KEY);
    expect(json).not.toMatch(/authorization|bearer/i);
    // The request did carry the key: it is only kept out of the record.
    expect(JSON.stringify(mock.calls[0].headers)).toContain(KEY);
  });

  it('notes a skipped page; debug never changes the cache key', async () => {
    const { createCanvas } = await import('@napi-rs/canvas');
    const c = createCanvas(400, 600);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, 400, 600);
    const bytes = new Uint8Array(await c.encode('png'));
    const mock = mockOpenAi(() => '{"blocks":[]}');
    const out = await runPipeline({ bytes, config: config() }, { backend: napiBackend, fetchImpl: mock.fetchImpl });
    expect(out.page.skippedNoText).toBe(true);
    expect(out.page.debug?.steps?.[0]).toMatch(/skipped/);
    expect(await pipelineHash(config())).toBe(out.page.pipeline.hash);
  });

  it('limits answers and cuts long ones; scrubs tokens and URL credentials', () => {
    const d = createDebug();
    for (let i = 0; i < 12; i++) addAnswer(d, 'translate', 'm', 'x'.repeat(30_000));
    expect(d.answers).toHaveLength(DEBUG_LIMITS.answers);
    expect(d.answers[0].text.length).toBeLessThan(20_100);
    expect(scrubSecrets('Bearer abcdefghijklmnop https://u:pw@host/x sk-abcdefghijklmnopq')).toBe('Bearer *** https://***@host/x ***');
  });
});
