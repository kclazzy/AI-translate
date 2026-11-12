/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from 'vitest';
import { configFromPreset } from '../src/llm/presets';
import { runStandalonePipeline } from '../src/pipeline/standalone';
import type { TextDetector } from '../src/pipeline/detect';
import { DEFAULT_PROFILES } from '../src/translate/profiles';
import { makeMangaPage, mockOpenAi, napiBackend } from './helpers';

describe('the text detector on the processor of a computer with a video card', () => {
  const run = async (detect: TextDetector) => {
    const { bytes } = await makeMangaPage();
    const mock = mockOpenAi(() => JSON.stringify({ blocks: [], entities: [], summary: '' }));
    const out = await runStandalonePipeline(
      { bytes, config: { mode: 'standalone', privacy: 'local', sourceLang: 'en', targetLang: 'ru', quality: 'balanced', profile: DEFAULT_PROFILES[0], glossary: [], translateSfx: false, vision: { ...configFromPreset('lmstudio', 'vlm'), vision: true }, translator: null, detector: true } as any },
      { backend: napiBackend, fetchImpl: mock.fetchImpl, detect },
    );
    return out.page.timings;
  };

  it('says in the page timings (journal, analysis pack) why the card was not used', async () => {
    const t = await run(async () => ({ boxes: [], ep: 'wasm', epWhy: 'ConvInteger is not supported on WebGPU', runMs: 900 }));
    expect(t).toMatchObject({ detectorEp: 'wasm', detectorEpWhy: 'ConvInteger is not supported on WebGPU' });
  });

  it('says nothing when it ran on the card', async () => {
    const t = await run(async () => ({ boxes: [], ep: 'webgpu', runMs: 30 }));
    expect(t.detectorEp).toBe('webgpu');
    expect(t.detectorEpWhy).toBeUndefined();
  });
});
