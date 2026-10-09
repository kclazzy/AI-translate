/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from 'vitest';
import { configFromPreset, defaultSettings, TranslateService } from '../src';
import { jsonResponse, makeMangaPage, mockOpenAi, toNorm } from './helpers';
import { napiBackend } from './helpers';

const memoryDb = () => {
  const m = new Map<string, unknown>();
  return { get: async (s: string, k: string) => m.get(`${s}/${k}`), put: async (s: string, k: string, v: unknown) => void m.set(`${s}/${k}`, v), delete: async () => undefined, entries: async () => [] } as any;
};

describe('a local model that runs out of video memory', () => {
  it('is retried lighter and the page is still translated', async () => {
    const { bytes, bubbles } = await makeMangaPage();
    let fails = 2;
    const mock = mockOpenAi(() => {
      if (fails-- > 0) return jsonResponse({ error: 'CUDA error: out of memory' }, 500);
      return JSON.stringify({ blocks: bubbles.map((b) => ({ box: toNorm(b.textBox, 800, 1100), text: b.text, translation: 'ПРИВЕТ', type: 'DIALOGUE', vertical: false })), entities: [], summary: '' });
    });
    const settings = { ...defaultSettings(), providers: [{ ...configFromPreset('lmstudio', 'vlm'), id: 'v', vision: true }], visionProviderId: 'v', twoStepTranslation: false, qaMode: 'off' } as any;
    const svc = new TranslateService(memoryDb(), { get: async () => undefined } as any, napiBackend, async () => settings, mock.fetchImpl);
    const stages: string[] = [];
    const { result } = await svc.translate(bytes, 'image/png', { generic: true, onStage: (e) => e.message && stages.push(e.message) });
    expect(result.page.blocks.length).toBe(bubbles.length);
    expect(stages.filter((m) => /видеопамяти/.test(m))).toHaveLength(2);
  });

  it('is reported with its own error code', async () => {
    const { httpError } = await import('../src/llm/http');
    const e = await httpError(jsonResponse({ error: 'model requires more system memory (12.3 GiB) than is available (8.1 GiB)' }, 500), 'Ollama', 'http://127.0.0.1:11434', 'qwen');
    expect(e.code).toBe('OUT_OF_MEMORY');
  });
});

describe('models.json', () => {
  it('the file in the repository is valid and matches the built-in list', async () => {
    const { readFileSync } = await import('node:fs');
    const { validCatalog, MODEL_TIERS } = await import('../src');
    const c = JSON.parse(readFileSync(new URL('../../../models.json', import.meta.url), 'utf8'));
    expect(validCatalog(c)).toBe(true);
    expect(c.tiers.map((t: any) => t.model)).toEqual(MODEL_TIERS.map((t) => t.model));
  });

  it('a better model is offered only when it really is better', async () => {
    const { betterModel, MODEL_TIERS, setCatalog, tierForVram } = await import('../src');
    expect(betterModel('qwen3.5:4b-q4_K_M', MODEL_TIERS, 12)?.model).toBe('qwen3.5:9b-q4_K_M');
    expect(betterModel('qwen3.5:9b-q4_K_M', MODEL_TIERS, 12)).toBeUndefined();
    expect(betterModel('qwen3.5:9b-q8_0', MODEL_TIERS, 12)).toBeUndefined(); // bigger than recommended: user's choice
    expect(betterModel('qwen2.5vl:7b', MODEL_TIERS, 12)?.model).toBe('qwen3.5:9b-q4_K_M'); // older family
    // A downloaded list replaces the built-in one; a broken one is ignored.
    expect(setCatalog({ version: 1, updated: 'x', tiers: [{ vramGb: 2, model: 'next-vl:3b', sizeGb: 2, quality: 'q', secondsPerPage: '1' }], families: [] } as any)).toBe(true);
    expect(tierForVram(12).model).toBe('next-vl:3b');
    expect(setCatalog({ version: 2 } as any)).toBe(false);
    setCatalog(null);
    expect(tierForVram(12).model).toBe('qwen3.5:9b-q4_K_M');
  });
});

describe('filters chosen by the user', () => {
  it('«Только баблы» and «Только выбранный язык» leave other text as it is', async () => {
    const { runStandalonePipeline, configFromPreset, DEFAULT_PROFILES } = await import('../src');
    const { bytes, bubbles } = await makeMangaPage();
    const answer = JSON.stringify({
      blocks: [
        { box: toNorm(bubbles[0].textBox, 800, 1100), text: 'たなかさん待って', translation: 'Танака, подожди!', type: 'DIALOGUE', vertical: true },
        { box: toNorm(bubbles[1].textBox, 800, 1100), text: 'BOOM', translation: 'БУМ', type: 'SFX', vertical: false },
      ],
      entities: [],
      summary: '',
    });
    const run = async (extra: object) => {
      const mock = mockOpenAi(() => answer);
      const out = await runStandalonePipeline(
        { bytes, config: { mode: 'standalone', privacy: 'local', sourceLang: 'ja', targetLang: 'ru', quality: 'balanced', profile: DEFAULT_PROFILES[0], glossary: [], translateSfx: true, sfxStyle: 'translated', vision: { ...configFromPreset('lmstudio', 'vlm'), vision: true }, translator: null, ...extra } as any },
        { backend: napiBackend, fetchImpl: mock.fetchImpl },
      );
      return out.page.blocks.map((b) => b.translate);
    };
    expect(await run({})).toEqual([true, true]);
    expect(await run({ bubblesOnly: true })).toEqual([true, false]);
    expect(await run({ onlySourceLang: true })).toEqual([true, false]); // BOOM is not Japanese
  });
});
