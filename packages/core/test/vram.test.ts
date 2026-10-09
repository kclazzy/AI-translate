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
