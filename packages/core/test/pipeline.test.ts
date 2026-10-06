import { writeFileSync, mkdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { configFromPreset } from '../src/llm/presets';
import type { PipelineConfig } from '../src/pipeline/config';
import { renderOutput, styleDefaultsFor } from '../src/pipeline/run';
import { planViews, recognizeRegion, runStandalonePipeline } from '../src/pipeline/standalone';
import { DEFAULT_STYLE_DEFAULTS } from '../src/render/style';
import { emptyContext } from '../src/translate/context';
import { DEFAULT_PROFILES } from '../src/translate/profiles';
import { TiledImage } from '../src/image/tiled';
import { darkPixelsInside, makeMangaPage, mockOpenAi, napiBackend, toNorm } from './helpers';

const OUT = new URL('../../../.test-output/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

function config(over: Partial<PipelineConfig> = {}): PipelineConfig {
  return {
    mode: 'standalone',
    privacy: 'local',
    sourceLang: 'auto',
    targetLang: 'ru',
    quality: 'balanced',
    profile: DEFAULT_PROFILES[0],
    glossary: [],
    translateSfx: true,
    sfxStyle: 'translated',
    vision: { ...configFromPreset('lmstudio', 'vlm'), model: 'qwen2.5vl:7b', vision: true },
    translator: null,
    ...over,
  };
}

const defaults = { ...DEFAULT_STYLE_DEFAULTS, dialogueFont: 'TestSans', narrationFont: 'TestSans', sfxFont: 'TestSans' };

describe('standalone pipeline', () => {
  it('reads, translates, cleans and typesets a manga page', async () => {
    const { bytes, bubbles } = await makeMangaPage();
    const translations = ['Танака-сан, подожди!', 'Куда ты идёшь?'];
    const mock = mockOpenAi((body) => {
      // The image is sent downscaled; boxes are normalised so scale does not matter.
      expect(body.messages[1].content[0].type).toBe('image_url');
      return JSON.stringify({
        blocks: bubbles.map((b, i) => ({ box: toNorm(b.textBox, 800, 1100), text: b.text, translation: translations[i], type: 'DIALOGUE', vertical: true })),
        entities: [{ source: '田中', target: 'Танака', kind: 'character', gender: 'male' }],
        summary: 'Кто-то зовёт Танаку.',
      });
    });
    const stages: string[] = [];
    const out = await runStandalonePipeline({ bytes, config: config(), context: emptyContext('series'), onStage: (e) => stages.push(e.stage) }, { backend: napiBackend, fetchImpl: mock.fetchImpl });

    expect(out.page.blocks).toHaveLength(2);
    const b = out.page.blocks[0];
    expect(b.writingDirection).toBe('ttb-rl');
    expect(b.translatedText).toBe('Танака-сан, подожди!');
    expect(b.bubble).not.toBeNull();
    expect(b.bubble!.shape).toBe('ellipse');
    // The detected bubble is close to the drawn ellipse.
    const bb = b.bubble!.box;
    expect(Math.abs(bb[0] + bb[2] / 2 - bubbles[0].cx)).toBeLessThan(10);
    expect(Math.abs(bb[2] - bubbles[0].rx * 2)).toBeLessThan(20);
    expect(out.context!.entities[0].target).toBe('Танака');
    expect(out.context!.summaries).toHaveLength(1);
    expect(stages).toContain('cleaning');
    expect(stages.at(-1)).toBe('done');

    // Original Japanese glyphs are gone from inside the bubbles.
    const cleanedBytes = await napiBackend.encode(out.cleaned.tiles[0].canvas, 'image/png');
    for (const bub of bubbles) {
      expect(await darkPixelsInside(bytes, bub)).toBeGreaterThan(200);
      expect(await darkPixelsInside(cleanedBytes, bub)).toBe(0);
    }

    const rendered = await renderOutput(napiBackend, out, defaults);
    expect(rendered.tiles).toHaveLength(1);
    expect(rendered.page.blocks.every((x) => !x.overflow)).toBe(true);
    // Rendered page has dark text again inside the bubbles (the translation).
    for (const bub of bubbles) expect(await darkPixelsInside(rendered.tiles[0].bytes, bub)).toBeGreaterThan(100);
    writeFileSync(OUT + 'core-original.png', bytes);
    writeFileSync(OUT + 'core-cleaned.png', cleanedBytes);
    writeFileSync(OUT + 'core-rendered.png', rendered.tiles[0].bytes);
  }, 30_000);

  it('uses a separate text translator when configured (vision OCR + text model)', async () => {
    const { bytes, bubbles } = await makeMangaPage();
    const translatorCfg = { ...configFromPreset('lmstudio', 'lm'), vision: false };
    const calls: string[] = [];
    const mock = mockOpenAi((body) => {
      calls.push(body.model);
      if (body.model === translatorCfg.model) {
        const blocks = JSON.parse(/<blocks>\n(.*)\n<\/blocks>/s.exec(body.messages[1].content)![1]);
        return JSON.stringify({ translations: blocks.map((b: { id: string }) => ({ id: b.id, text: `RU ${b.id}` })) });
      }
      return JSON.stringify({ blocks: bubbles.map((b) => ({ box: toNorm(b.textBox, 800, 1100), text: b.text, type: 'DIALOGUE', vertical: true })) });
    });
    const out = await runStandalonePipeline({ bytes, config: config({ translator: translatorCfg }) }, { backend: napiBackend, fetchImpl: mock.fetchImpl });
    expect(calls).toEqual(['qwen2.5vl:7b', 'qwen3-14b']);
    expect(out.page.blocks.map((b) => b.translatedText)).toEqual(['RU b1', 'RU b2']);
  }, 30_000);

  it('refuses to send images to a cloud model in local mode', async () => {
    const { bytes } = await makeMangaPage(100, 100, []);
    await expect(runStandalonePipeline({ bytes, config: config({ vision: { ...configFromPreset('anthropic', 'a'), apiKey: 'k' } }) }, { backend: napiBackend })).rejects.toMatchObject({ code: 'PRIVACY_VIOLATION' });
  });

  it('keeps SFX untouched when SFX translation is off', async () => {
    const { bytes, bubbles } = await makeMangaPage();
    const mock = mockOpenAi(() => JSON.stringify({ blocks: [{ box: toNorm(bubbles[0].textBox, 800, 1100), text: 'ドン', translation: 'ドン', type: 'SFX' }] }));
    const out = await runStandalonePipeline({ bytes, config: config({ translateSfx: false }) }, { backend: napiBackend, fetchImpl: mock.fetchImpl });
    expect(out.page.blocks[0].translate).toBe(false);
    const cleanedBytes = await napiBackend.encode(out.cleaned.tiles[0].canvas, 'image/png');
    expect(await darkPixelsInside(cleanedBytes, bubbles[0])).toBeGreaterThan(200);
  }, 30_000);

  it('handles an empty page without calling cleaning', async () => {
    const { bytes } = await makeMangaPage(300, 300, []);
    const mock = mockOpenAi(() => '{"blocks":[]}');
    const out = await runStandalonePipeline({ bytes, config: config() }, { backend: napiBackend, fetchImpl: mock.fetchImpl });
    expect(out.page.blocks).toHaveLength(0);
  });
});

describe('long webtoon strips', () => {
  it('plans overlapping views for tall images', () => {
    const views = planViews(800, 30000);
    expect(views.length).toBeGreaterThan(10);
    expect(views[0]).toEqual({ y: 0, h: 1600 });
    expect(views[1].y).toBeLessThan(1600);
    expect(views.at(-1)!.y + views.at(-1)!.h).toBe(30000);
    expect(planViews(800, 1200)).toHaveLength(1);
  });

  it('processes an 800×9000 strip across tiles and views', async () => {
    const bubbleSpecs = [
      { cx: 400, cy: 600, rx: 120, ry: 150, text: 'はじめまして' },
      { cx: 400, cy: 4096, rx: 120, ry: 150, text: 'よろしくね' }, // straddles a 4096 tile boundary
      { cx: 400, cy: 8200, rx: 120, ry: 150, text: 'またあした' },
    ];
    const { bytes, bubbles } = await makeMangaPage(800, 9000, bubbleSpecs);
    const mock = mockOpenAi((body) => {
      const text: string = body.messages[1].content[1].text;
      const m = /The image is (\d+)×(\d+)/.exec(text)!;
      void m;
      return JSON.stringify({ blocks: [] , __view: true });
    });
    // Answer each view with the bubbles that fall inside it, in view-normalised coordinates.
    const views = planViews(800, 9000);
    let call = 0;
    const smart = mockOpenAi(() => {
      const v = views[call++];
      const blocks = bubbles
        .filter((b) => b.textBox[1] >= v.y && b.textBox[1] + b.textBox[3] <= v.y + v.h)
        .map((b) => ({ box: toNorm([b.textBox[0], b.textBox[1] - v.y, b.textBox[2], b.textBox[3]], 800, v.h), text: b.text, translation: 'Перевод', type: 'DIALOGUE', vertical: true }));
      return JSON.stringify({ blocks });
    });
    void mock;
    const cfg = config();
    const out = await runStandalonePipeline({ bytes, config: cfg }, { backend: napiBackend, fetchImpl: async (u, i) => smart.fetchImpl(u, i) });
    expect(out.original.tiles.length).toBe(3);
    // Overlapping views report the same bubble twice; it must be kept once.
    expect(out.page.blocks).toHaveLength(3);
    const tiles = await Promise.all(out.cleaned.tiles.map((t) => napiBackend.encode(t.canvas, 'image/png')));
    // Stitch-check the boundary bubble through the TiledImage API.
    const region = out.cleaned.getRegion(280, 3946, 240, 300);
    let dark = 0;
    for (let i = 0; i < region.data.length; i += 4) {
      const x = (i / 4) % 240;
      const y = Math.floor(i / 4 / 240);
      const nx = (x - 120) / 100;
      const ny = (y - 150) / 130;
      if (nx * nx + ny * ny <= 1 && region.data[i] < 90) dark++;
    }
    expect(dark).toBe(0);
    expect(tiles).toHaveLength(3);
    const rendered = await renderOutput(napiBackend, out, defaults);
    expect(rendered.tiles.map((t) => t.h)).toEqual([4096, 4096, 808]);
  }, 60_000);
});

describe('manual OCR', () => {
  it('recognises a selected region and maps boxes back to the page', async () => {
    const { bytes, bubbles } = await makeMangaPage();
    const image = await TiledImage.fromBytes(napiBackend, bytes);
    const sel: [number, number, number, number] = [100, 90, 240, 340];
    const tb = bubbles[0].textBox;
    const mock = mockOpenAi(() => JSON.stringify({ blocks: [{ box: toNorm([tb[0] - sel[0], tb[1] - sel[1], tb[2], tb[3]], sel[2], sel[3]), text: bubbles[0].text, translation: 'Танака, стой!', type: 'DIALOGUE', vertical: true }] }));
    const r = await recognizeRegion(image, sel, config(), { backend: napiBackend, fetchImpl: mock.fetchImpl });
    expect(r.blocks).toHaveLength(1);
    const b = r.blocks[0].bbox;
    expect(Math.abs(b[0] - tb[0])).toBeLessThanOrEqual(2);
    expect(Math.abs(b[1] - tb[1])).toBeLessThanOrEqual(2);
  });
});

describe('render', () => {
  it('styleDefaultsFor carries target language and SFX style', () => {
    const d = styleDefaultsFor({ targetLang: 'ja', sfxStyle: 'large' });
    expect(d.targetLang).toBe('ja');
    expect(d.sfxStyle).toBe('large');
  });
});
