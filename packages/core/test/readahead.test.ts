/* eslint-disable @typescript-eslint/no-explicit-any */
import { createCanvas } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import { preparePage, runStandalonePipeline } from '../src/pipeline/standalone';
import { DEFAULT_PROFILES } from '../src/translate/profiles';
import { configFromPreset } from '../src/llm/presets';
import type { Box } from '../src/types';
import { mockOpenAi, napiBackend } from './helpers';

// «Распознавание»: the page prepared ahead (while the page before it was translated) has its text
// read already; translating it reads nothing again.
describe('text read ahead', () => {
  it('the prepared page brings its reading along', async () => {
    const c = createCanvas(600, 600);
    const g = c.getContext('2d') as any;
    g.fillStyle = '#fff';
    g.fillRect(0, 0, 600, 600);
    g.fillStyle = '#111';
    g.font = 'bold 30px sans-serif';
    g.fillText('HELLO', 220, 300);
    const bytes = new Uint8Array(await c.encode('png'));
    let reads = 0;
    const reader: any = async () => (reads++, { text: 'HELLO', lines: [{ box: [0, 0, 10, 10] as Box, text: 'HELLO', score: 1, vertical: false }] });
    const detect = async (img: { width: number; height: number }) => ({ boxes: [{ box: [(200 * img.width) / 600, (270 * img.height) / 600, (160 * img.width) / 600, (40 * img.height) / 600] as Box, kind: 'text_free' as const, score: 0.9 }] });
    const config: any = { mode: 'standalone', privacy: 'local', sourceLang: 'en', targetLang: 'ru', quality: 'balanced', profile: DEFAULT_PROFILES[0], glossary: [], translateSfx: true, sfxStyle: 'translated', vision: { ...configFromPreset('lmstudio', 'llm'), vision: false }, translator: null, detector: true, ocr: true };
    const deps: any = { backend: napiBackend, detect, ocr: reader };
    const prepared = await preparePage({ bytes, config, noSkip: true }, deps);
    expect(reads).toBe(1);
    const mock = mockOpenAi((body) => {
      const blocks = JSON.parse(/<blocks>\n(.*)\n<\/blocks>/s.exec(body.messages.at(-1).content)?.[1] ?? '[]');
      return JSON.stringify({ translations: blocks.map((b: any) => ({ id: b.id, text: 'ПРИВЕТ' })), entities: [], summary: '' });
    });
    const out = await runStandalonePipeline({ bytes, config, noSkip: true, prepared }, { ...deps, fetchImpl: mock.fetchImpl });
    expect(reads).toBe(1);
    expect(out.page.blocks.map((b) => b.translatedText)).toEqual(['ПРИВЕТ']);
    expect(out.page.debug?.steps?.some((s) => s.includes('read ahead'))).toBe(true);
  }, 60000);
});
