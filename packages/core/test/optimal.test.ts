import { describe, expect, it } from 'vitest';
import { autoOptimal, defaultSettings, optimalLocalSettings, optimalProfile, optimalSettings } from '../src';

describe('«Оптимально для локальной модели»', () => {
  it('12 GB: accuracy settings on, the browser nets off; models and languages untouched', () => {
    const s = { ...defaultSettings(), gpuVramGb: 12, fastLocal: true, quality: 'fast' as const, detectorMode: 'browser' as const, lamaMode: 'browser' as const, sourceLang: 'en', bubblesOnly: true };
    const { patch, changes } = optimalLocalSettings(s);
    expect(patch).toMatchObject({ fastLocal: false, quality: 'balanced', twoStepTranslation: true, detectorMode: 'off', lamaMode: 'off', bubblesOnly: false, onlySourceLang: true, gpuKeepAliveMin: 15 });
    expect(patch).not.toHaveProperty('providers');
    expect(patch).not.toHaveProperty('sourceLang');
    expect(changes.length).toBe(Object.keys(patch).length);
    // Applied once, there is nothing left to change.
    expect(optimalLocalSettings({ ...s, ...patch }).changes).toEqual([]);
  });

  it('24 GB keeps the detector and LaMa', () => {
    const s = { ...defaultSettings(), gpuVramGb: 24, detectorMode: 'browser' as const, lamaMode: 'browser' as const };
    const { patch } = optimalLocalSettings(s);
    expect(patch).not.toHaveProperty('detectorMode');
    expect(patch).not.toHaveProperty('lamaMode');
  });
});

describe('settings follow the model', () => {
  const local = { id: 'ol', name: 'Ollama', preset: 'ollama', baseUrl: 'http://localhost:11434/v1', model: 'qwen3.5:9b', vision: true } as never;
  const cloud = { id: 'gm', name: 'Gemini', preset: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-flash', vision: true } as never;
  const base = () => ({ ...defaultSettings(), gpuVramGb: 12, providers: [local, cloud], visionProviderId: 'ol', detectorMode: 'off' as const });

  it('each way of working has its own profile', () => {
    const s = base();
    expect(optimalProfile(s)).toBe('local');
    expect(optimalProfile({ ...s, visionProviderId: 'gm' })).toBe('cloud');
    expect(optimalProfile({ ...s, readMode: 'ocr', visionProviderId: 'browser-translator' })).toBe('ocr-browser');
    expect(optimalProfile({ ...s, readMode: 'ocr' })).toBe('ocr-local');
    expect(optimalProfile({ ...s, readMode: 'ocr', visionProviderId: 'gm' })).toBe('ocr-cloud');
    expect(optimalProfile({ ...s, pipeline: 'engine' })).toBe('engine');
  });

  it('switching to a cloud model brings its settings at once; the user\'s taste stays', () => {
    const s = { ...base(), quality: 'balanced' as const, qaMode: 'rules' as const, twoStepTranslation: false, bubblesOnly: true };
    const a = autoOptimal(s, { visionProviderId: 'gm' })!;
    expect(a.patch).toMatchObject({ quality: 'best', twoStepTranslation: true, qaMode: 'fix' });
    expect(a.patch).not.toHaveProperty('bubblesOnly');
    expect(a.before).toMatchObject({ quality: 'balanced', qaMode: 'rules' });
    expect(a.changes.length).toBe(Object.keys(a.patch).length);
  });

  it('back to the local model: the review without a model, the browser nets off up to 12 GB', () => {
    const s = { ...base(), visionProviderId: 'gm', quality: 'best' as const, qaMode: 'fix' as const, lamaMode: 'browser' as const, detectorMode: 'browser' as const };
    const a = autoOptimal(s, { visionProviderId: 'ol' })!;
    expect(a.patch).toMatchObject({ quality: 'balanced', qaMode: 'rules', detectorMode: 'off', lamaMode: 'off', gpuKeepAliveMin: 15 });
  });

  it('another model of the same server counts as a switch', () => {
    const s = { ...base(), visionProviderId: 'gm', qaMode: 'rules' as const };
    const a = autoOptimal(s, { providers: [local, { ...(cloud as object), model: 'gemini-2.5-pro' } as never] });
    expect(a?.patch.qaMode).toBe('fix');
  });

  it('«Распознавание» keeps the detector on; what the switch sets itself wins', () => {
    const s = { ...base(), qaMode: 'fix' as const };
    const a = autoOptimal(s, { readMode: 'ocr', visionProviderId: 'browser-translator', detectorMode: 'browser', quality: 'fast' })!;
    expect(a.patch).not.toHaveProperty('detectorMode');
    expect(a.patch).not.toHaveProperty('quality');
    expect(a.patch.qaMode).toBe('rules');
  });

  it('nothing without a switch of model, or when turned off', () => {
    const s = base();
    expect(autoOptimal(s, { quality: 'fast' })).toBeNull();
    expect(autoOptimal({ ...s, autoOptimal: false }, { visionProviderId: 'gm' })).toBeNull();
    // Applied once: switching back and forth again finds the settings already right.
    const once = { ...s, visionProviderId: 'gm', ...autoOptimal(s, { visionProviderId: 'gm' })!.patch };
    expect(optimalSettings(once, { onlyModel: true }).changes).toEqual([]);
  });
});
