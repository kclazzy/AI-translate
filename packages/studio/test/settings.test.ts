import { describe, expect, it } from 'vitest';
import { defaultSettings, migrateSettings, type AppSettings } from '@ait/core';
import { readSettingsFile, sanitizeSettings, sanitizeUrl, settingsToFile } from '../src/settingsFile';
import { redactSettings } from '../src/report';
import { safeFileName } from '../src/platform';
import { psdTooBig, maxCanvasPixels } from '../src/psd';

function withSecrets(): AppSettings {
  const s = defaultSettings();
  s.providers = [
    { ...s.providers[0], id: 'openai', apiKey: 'sk-provider', baseUrl: 'https://user:pass@api.example.com/v1?key=q-secret#frag' },
  ];
  s.engine = { ...s.engine, url: 'http://admin:pw@192.168.1.5:8765/?token=e-secret', token: 'tok-engine' };
  s.crossCheck = {
    enabled: true,
    judge: 'main',
    mode: 'report',
    checkers: [
      { id: 'c1', kind: 'libre', enabled: true, url: 'https://lt:pw@libre.example.com/?api_key=l-secret' },
      { id: 'c2', kind: 'deepl', enabled: true, apiKey: 'deepl-secret' } as never,
    ],
  };
  return s;
}

const SECRETS = ['sk-provider', 'user:pass', 'q-secret', 'admin:pw', 'e-secret', 'tok-engine', 'lt:pw', 'l-secret', 'deepl-secret'];

describe('sanitizeSettings', () => {
  it('drops every key and token and cleans every address', () => {
    for (const text of [JSON.stringify(sanitizeSettings(withSecrets())), settingsToFile(withSecrets(), '1'), JSON.stringify(redactSettings(withSecrets()))]) {
      for (const secret of SECRETS) expect(text).not.toContain(secret);
    }
    const clean = sanitizeSettings(withSecrets());
    expect(clean.providers[0].baseUrl).toBe('https://api.example.com/v1');
    expect(clean.engine.url).toBe('http://192.168.1.5:8765/');
    expect(clean.crossCheck?.checkers[0].url).toBe('https://libre.example.com/');
  });

  it('leaves plain addresses alone', () => {
    expect(sanitizeUrl('http://127.0.0.1:11434/v1')).toBe('http://127.0.0.1:11434/v1');
    expect(sanitizeUrl('https://api.openai.com/v1/')).toBe('https://api.openai.com/v1/');
  });
});

describe('settings file import', () => {
  const file = (patch: (s: AppSettings) => void) => {
    const s = defaultSettings();
    patch(s);
    return JSON.stringify({ app: 'AI Translate', kind: 'settings', settings: s });
  };

  it('a provider id with another address loses this computer’s stored key', () => {
    const here = defaultSettings();
    here.providers = [{ ...here.providers[0], id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1' }];
    const text = file((s) => {
      s.providers = [
        { ...s.providers[0], id: 'openai', label: 'OpenAI', baseUrl: 'https://evil.example/v1', apiKey: 'planted' },
        { ...s.providers[1], id: 'ollama', baseUrl: here.providers[0].baseUrl },
      ];
    });
    const got = readSettingsFile(text, here);
    expect(got.dropSecrets).toContain('provider:openai');
    // A provider id this computer does not have yet gets no stale key either.
    expect(got.dropSecrets).toContain('provider:ollama');
    expect(got.changed.join('\n')).toContain('https://evil.example/v1');
    expect(got.settings.providers.every((p) => p.apiKey === undefined)).toBe(true);
  });

  it('keeps the key when the address is the same', () => {
    const here = defaultSettings();
    here.providers = [{ ...here.providers[0], id: 'openai', baseUrl: 'https://api.openai.com/v1' }];
    const got = readSettingsFile(file((s) => (s.providers = [{ ...s.providers[0], id: 'openai', baseUrl: 'https://api.openai.com/v1/' }])), here);
    expect(got.dropSecrets).not.toContain('provider:openai');
  });

  it('checkers with another address or kind lose their key; the engine token stays only for the same engine', () => {
    const here = defaultSettings();
    here.engine = { ...here.engine, url: 'http://127.0.0.1:8765', token: 'tok-here' };
    here.crossCheck = { enabled: true, judge: 'main', mode: 'report', checkers: [{ id: 'c1', kind: 'libre', enabled: true, url: 'http://127.0.0.1:5000' }, { id: 'c2', kind: 'deepl', enabled: true }] };
    const got = readSettingsFile(
      file((s) => {
        s.engine = { ...s.engine, url: 'https://evil.example:8765' };
        s.crossCheck = { enabled: true, judge: 'main', mode: 'report', checkers: [{ id: 'c1', kind: 'libre', enabled: true, url: 'https://evil.example' }, { id: 'c2', kind: 'deepl', enabled: true }] };
      }),
      here,
    );
    expect(got.dropSecrets).toContain('checker:c1');
    expect(got.dropSecrets).not.toContain('checker:c2');
    expect(got.settings.engine.token).toBe('');
    const same = readSettingsFile(file((s) => (s.engine = { ...s.engine, url: 'http://127.0.0.1:8765/' })), here);
    expect(same.settings.engine.token).toBe('tok-here');
  });

  it('rejects files that are not settings', () => {
    expect(() => readSettingsFile('{"app":"AI Translate","kind":"settings","settings":[]}', defaultSettings())).toThrow();
    expect(() => readSettingsFile('null', defaultSettings())).toThrow();
  });
});

describe('migrateSettings with untrusted input', () => {
  it('drops entries of the wrong shape instead of keeping them', () => {
    const s = migrateSettings({
      providers: [null, 5, { id: 'x' }, { id: 'ok', baseUrl: 'http://h', kind: 'weird', vision: 'yes', timeoutMs: 'soon' }],
      crossCheck: { checkers: 'x', mode: 'nope' },
      glossary: [{ source: 'a', target: 'b', forbidden: [1, 'c'] }, 'junk'],
      profiles: 'abc',
      seriesProfiles: { a: 'p', b: 3 },
      presets: [{ id: 'p', name: 'P', models: { a: 'm', b: 1 } }, null],
      fonts: { dialogue: 42 },
      autoTranslate: { enabled: 'yes', sites: ['a', 1] },
      engine: { url: 5, options: { detector: 'evil' } },
      theme: 'neon',
      concurrency: 1e9,
      historyDays: 'many',
      lamaMode: 'gpu',
    });
    expect(s.providers.map((p) => p.id)).toEqual(['ok']);
    expect(s.providers[0].kind).toBe('openai-compatible');
    expect(s.providers[0].vision).toBe(false);
    expect(s.providers[0].timeoutMs).toBeUndefined();
    expect(s.crossCheck?.checkers).toEqual([]);
    expect(s.crossCheck?.mode).toBe('report');
    expect(s.glossary).toHaveLength(1);
    expect(s.glossary[0].forbidden).toEqual(['c']);
    expect(s.profiles.length).toBeGreaterThan(0);
    expect(s.seriesProfiles).toEqual({ a: 'p' });
    expect(s.presets?.[0].models).toEqual({ a: 'm' });
    expect(s.presets).toHaveLength(1);
    expect(s.fonts.dialogue).toBe('');
    expect(s.autoTranslate).toEqual({ enabled: false, sites: ['a'] });
    expect(s.engine.url).toBe(defaultSettings().engine.url);
    expect(s.engine.options.detector).toBe('auto');
    expect(s.theme).toBe('system');
    expect(s.concurrency).toBe(16);
    expect(s.historyDays).toBeUndefined();
    expect(s.lamaMode).toBeUndefined();
  });

  it('keeps good stored settings as they are', () => {
    const d = defaultSettings();
    const stored = { ...d, theme: 'dark', glossary: [{ id: 'g', source: '田中', target: 'Танака', matchMode: 'exact', caseSensitive: false, forbidden: [], enabled: true }], historyDays: 7, presets: [], crossCheck: { enabled: true, checkers: [{ id: 'c', kind: 'deepl', enabled: true }], judge: 'main', mode: 'fix' } };
    const s = migrateSettings(JSON.parse(JSON.stringify(stored)));
    expect(s.theme).toBe('dark');
    expect(s.providers).toEqual(d.providers);
    expect(s.glossary[0].target).toBe('Танака');
    expect(s.historyDays).toBe(7);
    expect(s.crossCheck?.mode).toBe('fix');
    expect(s.crossCheck?.checkers[0].kind).toBe('deepl');
  });
});

describe('file names and PSD size', () => {
  it('makes titles and addresses safe file names', () => {
    expect(safeFileName('https://site.com/ch/1.png.psd')).toBe('site.com_ch_1.png.psd');
    expect(safeFileName('Глава 1: «Начало»?.txt')).toBe('Глава 1_ «Начало»_.txt');
    expect(safeFileName('../../etc/passwd')).toBe('etc_passwd');
    expect(safeFileName('a/b')).toBe('a_b');
    expect(safeFileName('///')).toBe('file');
  });

  it('refuses PSD pages the device cannot draw', () => {
    const ios = maxCanvasPixels('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', 5);
    expect(psdTooBig(800, 25000, ios)).toBe('pixels');
    expect(psdTooBig(800, 25000, maxCanvasPixels('Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 0))).toBeNull();
    expect(psdTooBig(800, 31000)).toBe('side');
  });
});
