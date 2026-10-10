import { migrateSettings, type AppSettings } from '@ait/core';

/** An address without anything secret: no `user:password@`, no query string or fragment (`?key=…`). */
export function sanitizeUrl(url: string | undefined): string | undefined {
  if (typeof url !== 'string') return url;
  return url.replace(/^([a-z][\w+.-]*:\/\/)[^/?#@]*@/i, '$1').replace(/[?#].*$/s, '');
}

/**
 * Settings without anything secret: every API key and token is dropped, every address loses its
 * credentials and query string. Used for the settings file and for the problem report.
 */
export function sanitizeSettings(s: AppSettings): AppSettings {
  const clean = JSON.parse(JSON.stringify(s)) as AppSettings;
  clean.providers = (clean.providers ?? []).map(({ apiKey: _key, ...p }) => ({ ...p, baseUrl: sanitizeUrl(p.baseUrl) ?? '' }));
  if (clean.engine) clean.engine = { ...clean.engine, url: sanitizeUrl(clean.engine.url) ?? '', token: '' };
  // Left by an older version (the cross-check with other translators was removed).
  delete (clean as { crossCheck?: unknown }).crossCheck;
  delete clean.modelCatalog;
  delete clean.modelChecks;
  return clean;
}

/**
 * Settings as a file, to move them to another computer: models, profiles, glossary, presets…
 * Never the API keys or the engine token (they stay in this browser's secret store).
 */
export function settingsToFile(s: AppSettings, version: string): string {
  return JSON.stringify({ app: 'AI Translate', kind: 'settings', version, date: new Date().toISOString(), settings: sanitizeSettings(s) }, null, 2);
}

export interface SettingsImport {
  settings: AppSettings;
  /** Secret-store names to delete before the settings are applied (keys that must not follow a new address). */
  dropSecrets: string[];
  /** Addresses that are new or differ from this computer's, for the user to look at. */
  changed: string[];
}

const sameUrl = (a: string | undefined, b: string | undefined) => (a ?? '').trim().replace(/\/+$/, '').toLowerCase() === (b ?? '').trim().replace(/\/+$/, '').toLowerCase();

/**
 * Read a settings file (untrusted: it may come from anyone). Keys are kept in the secret store by
 * provider id, so a file that reuses an id with another address would send this
 * computer's key there: such ids lose their stored key, and the engine token is kept only when the
 * engine address is the same.
 */
export function readSettingsFile(text: string, current: AppSettings): SettingsImport {
  const j = JSON.parse(text) as { app?: string; kind?: string; settings?: unknown };
  if (!j || j.app !== 'AI Translate' || j.kind !== 'settings' || !j.settings || typeof j.settings !== 'object' || Array.isArray(j.settings)) throw new Error('not a settings file');
  const next = migrateSettings(j.settings);
  const dropSecrets: string[] = [];
  const changed: string[] = [];
  next.providers = next.providers.map(({ apiKey: _key, ...p }) => {
    const here = current.providers.find((x) => x.id === p.id);
    if (!here || !sameUrl(here.baseUrl, p.baseUrl)) {
      dropSecrets.push(`provider:${p.id}`);
      changed.push(`${p.label || p.id}: ${sanitizeUrl(p.baseUrl)}`);
    }
    return p;
  });
  const sameEngine = sameUrl(current.engine.url, next.engine.url);
  if (!sameEngine) changed.push(`engine: ${sanitizeUrl(next.engine.url)}`);
  const settings: AppSettings = { ...next, engine: { ...next.engine, token: sameEngine ? current.engine.token : '' }, modelChecks: current.modelChecks, modelCatalog: current.modelCatalog };
  return { settings, dropSecrets, changed };
}

/** Read a settings file; the engine token of this computer is kept for the same engine address. */
export function settingsFromFile(text: string, current: AppSettings): AppSettings {
  return readSettingsFile(text, current).settings;
}
