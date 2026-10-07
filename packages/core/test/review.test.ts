import { createCanvas } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import { compareVersions } from '../src/update';
import { qaPage } from '../src/translate/qa';
import { parseTranslationAnswer, parseVisionAnswer } from '../src/translate/parse';
import { configFromPreset, OpenAICompatibleProvider } from '../src';
import { ctxMeasurer } from '../src/render/render';
import { layoutText } from '../src/typeset/layout';
import { runEnginePipeline } from '../src/pipeline/engine';
import type { TextBlock } from '../src/types';
import { jsonResponse, napiBackend } from './helpers';
import './helpers';

const block = (id: string): TextBlock => ({ id, textType: 'DIALOGUE', originalText: 'Hello?', translatedText: 'Привет?', confidence: 1, language: 'en', bbox: [0, 0, 10, 10], polygon: [], orientation: 0, writingDirection: 'ltr', fontSizeEstimate: 12, bubble: null, translate: true }) as TextBlock;

describe('fixes from the review', () => {
  it('a broken review answer never fails a translated page', async () => {
    for (const answer of ['', '{"reviews":{"b1":1}}', 'not json at all']) {
      const p = new OpenAICompatibleProvider(configFromPreset('openai', 'o'), async () => jsonResponse({ choices: [{ message: { content: answer } }] }));
      const blocks = [block('b1')];
      await expect(qaPage(blocks, { provider: p, mode: 'fix', targetLang: 'ru', glossary: [] })).resolves.toBeDefined();
      expect(blocks[0].translatedText).toBe('Привет?');
    }
  });
  it('answers given as a bare JSON array are accepted', () => {
    const v = parseVisionAnswer('[{"box":[0,0,10,10],"text":"a"},{"box":[10,10,20,20],"text":"b"}]', false);
    expect(v.blocks.map((b) => b.text)).toEqual(['a', 'b']);
    const t = parseTranslationAnswer('[{"id":"b1","text":"А"}]', [{ id: 'b1', text: 'A' }]);
    expect(t.translations.get('b1')?.text).toBe('А');
  });
  it('a pre-release is older than the release', () => {
    expect(compareVersions('1.2.0-rc.1', '1.2.0')).toBe(-1);
    expect(compareVersions('1.2.0', '1.2.0-rc.1')).toBe(1);
    expect(compareVersions('0.4.0', '0.3.9')).toBe(1);
    expect(compareVersions('v0.3.9', '0.3.9')).toBe(0);
  });
  it('Traditional Chinese is set without spaces between characters', () => {
    const m = ctxMeasurer(createCanvas(10, 10).getContext('2d') as never);
    const r = layoutText(m, { text: '你好 世界', box: [0, 0, 400, 100], shape: 'rect', fontFamily: 'TestSans', fontSize: 20, lang: 'zh-TW' });
    expect(r.lines.map((l) => l.text).join('')).not.toMatch(/你 好/);
  });
  it('in local mode the picture is never sent to an engine on the internet', async () => {
    const config = { mode: 'engine', privacy: 'local', engine: { url: 'https://gpu.example.com', token: 't' } } as never;
    await expect(runEnginePipeline({ bytes: new Uint8Array(4), config }, { backend: napiBackend, fetchImpl: async () => jsonResponse({}) })).rejects.toMatchObject({ code: 'PRIVACY_VIOLATION' });
  });
});
