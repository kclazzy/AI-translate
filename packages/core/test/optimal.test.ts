import { describe, expect, it } from 'vitest';
import { defaultSettings, optimalLocalSettings } from '../src';

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
