import { describe, expect, it } from 'vitest';
import { aiModeOf, aiModesAvailable, applyAiMode, configFromPreset, defaultSettings, migrateSettings, type AppSettings } from '../src';

const base = (): AppSettings => {
  const d = defaultSettings();
  return {
    ...d,
    providers: [
      { ...configFromPreset('ollama', 'qwen3.5:9b'), id: 'ol', vision: true },
      { ...configFromPreset('gemini', 'gemini-2.5-flash'), id: 'gm', vision: true },
    ],
    visionProviderId: 'ol',
    translationProviderId: null,
    privacy: 'local',
    pipeline: 'standalone',
    engine: { ...d.engine, url: 'http://127.0.0.1:8765' },
  };
};
const apply = (s: AppSettings, m: Parameters<typeof applyAiMode>[1]) => ({ ...s, ...applyAiMode(s, m)! });

describe('three AI modes', () => {
  it('tells the mode and switches in one step, remembering the server of each mode', () => {
    let s = base();
    expect(aiModeOf(s)).toBe('ollama');
    expect(aiModesAvailable(s)).toEqual({ ollama: true, cloud: true, ocr: true, engine: true });
    s = apply(s, 'cloud');
    expect(aiModeOf(s)).toBe('cloud');
    expect(s.visionProviderId).toBe('gm');
    // Pictures may leave the computer now (they could not with «only this computer»).
    expect(s.privacy).toBe('cloud');
    s = apply(s, 'engine');
    expect(aiModeOf(s)).toBe('engine');
    s = apply(s, 'ollama');
    expect(s.pipeline).toBe('standalone');
    expect(s.visionProviderId).toBe('ol');
    expect(apply(s, 'cloud').visionProviderId).toBe('gm');
    expect(migrateSettings(s).modeProviders).toEqual({ ollama: 'ol', cloud: 'gm' });
  });

  it('a mode without a server or engine address cannot be switched to', () => {
    const s = { ...base(), providers: [base().providers[0]], engine: { ...base().engine, url: '' } };
    expect(aiModesAvailable(s)).toEqual({ ollama: true, cloud: false, ocr: true, engine: false });
    expect(applyAiMode(s, 'cloud')).toBeNull();
  });
});

describe('the recognition mode', () => {
  it('switches the detector on, uses any server as the translator, and comes back', () => {
    let s: AppSettings = { ...base(), detectorMode: 'off' };
    s = apply(s, 'ocr');
    expect(aiModeOf(s)).toBe('ocr');
    expect(s.readMode).toBe('ocr');
    expect(s.detectorMode).toBe('browser');
    expect(s.visionProviderId).toBe('ol');
    s = apply(s, 'cloud');
    expect(aiModeOf(s)).toBe('cloud');
    expect(s.readMode).toBe('vision');
    s = apply(s, 'ocr');
    expect(s.visionProviderId).toBe('ol');
  });
});
