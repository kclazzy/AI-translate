/* eslint-disable @typescript-eslint/no-explicit-any */
import { createCanvas } from '@napi-rs/canvas';
import { afterEach, describe, expect, it } from 'vitest';
import { configFromPreset, defaultSettings, fallbackConfig, pipelineConfigFromSettings, setBrowserTranslate, TranslateService, type AppSettings, type Box } from '../src';
import { napiBackend } from './helpers';

function memoryDb() {
  const m = new Map<string, unknown>();
  const of = (s: string) => [...m.entries()].filter(([k]) => k.startsWith(`${s}/`)).map(([k, v]) => [k.slice(s.length + 1), structuredClone(v)] as [string, unknown]);
  return {
    get: async (s: string, k: string) => structuredClone(m.get(`${s}/${k}`)),
    put: async (s: string, k: string, v: unknown) => void m.set(`${s}/${k}`, structuredClone(v)),
    delete: async (s: string, k: string) => void m.delete(`${s}/${k}`),
    keys: async (s: string) => of(s).map(([k]) => k),
    keysWithPrefix: async (s: string, p: string) => of(s).map(([k]) => k).filter((k) => k.startsWith(p)),
    entries: async (s: string) => of(s),
  } as any;
}

const settings = (over: Partial<AppSettings> = {}): AppSettings =>
  ({
    ...defaultSettings(),
    providers: [{ ...configFromPreset('ollama', 'qwen3.5:9b'), id: 'ol', vision: true }],
    visionProviderId: 'ol',
    translationProviderId: null,
    twoStepTranslation: false,
    qaMode: 'off',
    sourceLang: 'en',
    targetLang: 'ru',
    saveHistory: false,
    fonts: { dialogue: 'TestSans', narration: 'TestSans', sfx: 'TestSans' },
    ...over,
  }) as AppSettings;

async function page(): Promise<Uint8Array> {
  const c = createCanvas(600, 600);
  const g = c.getContext('2d') as any;
  g.fillStyle = '#fff';
  g.fillRect(0, 0, 600, 600);
  g.fillStyle = '#111';
  g.font = 'bold 30px sans-serif';
  g.fillText('HELLO', 220, 300);
  return new Uint8Array(await c.encode('png'));
}

afterEach(() => setBrowserTranslate(null));

describe('a stand-in when the usual model does not answer', () => {
  it('the browser\'s translator translates what recognition reads; a model that sees pictures takes the usual one\'s place', () => {
    setBrowserTranslate(async (t) => t, true);
    const s = settings();
    const cfg = pipelineConfigFromSettings(s);
    const alt = fallbackConfig(cfg, s, true)!;
    expect(alt.cfg).toMatchObject({ ocr: true, detector: true, translator: null, twoStep: false });
    expect(alt.cfg.vision?.id).toBe('browser-translator');
    // No recognition here: nothing can stand in with the browser's translator.
    expect(fallbackConfig(cfg, s, false)).toBeNull();
    // Turned off.
    expect(fallbackConfig(cfg, { ...s, fallbackProviderId: 'off' }, true)).toBeNull();
    // A cloud model that reads pictures, chosen as the stand-in.
    const cloud = { ...configFromPreset('gemini', 'gemini-2.5-flash'), id: 'gm', vision: true };
    const s2 = settings({ providers: [...s.providers, cloud], fallbackProviderId: 'gm' });
    const alt2 = fallbackConfig(pipelineConfigFromSettings(s2), s2, false)!;
    expect(alt2.cfg.ocr).toBeFalsy();
    expect(alt2.cfg.vision?.id).toBe('gm');
  });

  it('Ollama not running: the page is translated by the stand-in, marked, and not cached as the usual result', async () => {
    setBrowserTranslate(async (texts: string[]) => texts.map(() => 'ПРИВЕТ'), true);
    let calls = 0;
    const down = async () => {
      calls++;
      throw new TypeError('Failed to fetch');
    };
    const svc = new TranslateService(memoryDb(), { get: async () => undefined } as any, napiBackend, async () => settings(), down as any);
    svc.compactTiles = false;
    svc.detector = async (img: { width: number; height: number }) => ({ boxes: [{ box: [(200 * img.width) / 600, (270 * img.height) / 600, (160 * img.width) / 600, (40 * img.height) / 600] as Box, kind: 'text_free' as const, score: 0.9 }] }) as any;
    svc.reader = (async () => ({ text: 'HELLO', lines: [{ box: [0, 0, 10, 10] as Box, text: 'HELLO', score: 1, vertical: false }] })) as any;
    const { result } = await svc.translate(await page(), 'image/png');
    expect(calls).toBeGreaterThan(0);
    expect(result.page.fallback?.reason).toBe('PROVIDER_UNAVAILABLE');
    expect(result.page.blocks.map((b) => b.translatedText)).toEqual(['ПРИВЕТ']);
    expect(result.key.endsWith(':fb')).toBe(true);
  }, 60000);

  it('the stand-in failing too: the usual model\'s error is the one shown', async () => {
    const down = async () => {
      throw new TypeError('Failed to fetch');
    };
    const svc = new TranslateService(memoryDb(), { get: async () => undefined } as any, napiBackend, async () => settings(), down as any);
    svc.compactTiles = false;
    await expect(svc.translate(await page(), 'image/png')).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  }, 60000);
});
