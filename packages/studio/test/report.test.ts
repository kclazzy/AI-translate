import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { defaultSettings } from '@ait/core';
import { buildReport } from '../src/report';

describe('problem report', () => {
  it('never contains API keys or the engine token', async () => {
    const s = defaultSettings();
    s.providers = [...s.providers, { ...s.providers[0], id: 'c', apiKey: 'sk-secret-123', baseUrl: 'https://user:pass@api.example.com/v1' }];
    s.engine = { ...s.engine, token: 'tok-secret-456' };
    const bytes = await buildReport({ db: { get: async () => undefined } as never, settings: s, version: '0.5.0', kind: 'extension', history: [] });
    const zip = await JSZip.loadAsync(bytes);
    let all = '';
    for (const f of Object.values(zip.files)) all += await f.async('string');
    expect(all).not.toContain('sk-secret-123');
    expect(all).not.toContain('tok-secret-456');
    expect(all).not.toContain('user:pass');
    expect(Object.keys(zip.files).sort()).toEqual(['history.json', 'info.json', 'settings.json', 'speed.json']);
  });
});
