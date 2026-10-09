import { migrateSettings, type AppSettings } from '@ait/core';

/**
 * Settings as a file, to move them to another computer: models, profiles, glossary, presets,
 * «Сверка»… Never the API keys or the engine token (they stay in this browser's secret store).
 */
export function settingsToFile(s: AppSettings, version: string): string {
  const clean = JSON.parse(JSON.stringify(s)) as AppSettings;
  clean.providers = clean.providers.map((p) => ({ ...p, apiKey: undefined }));
  if (clean.engine) clean.engine = { ...clean.engine, token: '' };
  if (clean.crossCheck) clean.crossCheck = { ...clean.crossCheck, checkers: clean.crossCheck.checkers.map((c) => ({ ...c, apiKey: undefined }) as typeof c) };
  delete clean.modelCatalog;
  delete clean.modelChecks;
  return JSON.stringify({ app: 'AI Translate', kind: 'settings', version, date: new Date().toISOString(), settings: clean }, null, 2);
}

/** Read a settings file; the engine token of this computer is kept. */
export function settingsFromFile(text: string, current: AppSettings): AppSettings {
  const j = JSON.parse(text) as { app?: string; kind?: string; settings?: unknown };
  if (j.app !== 'AI Translate' || j.kind !== 'settings' || !j.settings || typeof j.settings !== 'object') throw new Error('not a settings file');
  const next = migrateSettings(j.settings);
  return { ...next, engine: { ...next.engine, token: current.engine.token }, modelChecks: current.modelChecks, modelCatalog: current.modelCatalog };
}
