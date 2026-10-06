import { IdbStore, migrateSettings, SecretStore, type AppSettings } from '@ait/core';

/**
 * Settings live in the extension's IndexedDB so every extension context
 * (service worker, offscreen document, popup, studio) reads the same copy.
 * Content scripts ask the background instead.
 */
export const db = new IdbStore('ai-translate', 1);
export const secrets = new SecretStore(db);

export async function loadSettings(): Promise<AppSettings> {
  return migrateSettings(await db.get('kv', 'settings'));
}

export async function saveSettings(s: AppSettings): Promise<void> {
  // API keys never go into the settings object on disk.
  const providers = s.providers.map(({ apiKey: _drop, ...rest }) => rest);
  await db.put('kv', 'settings', { ...s, providers });
  try {
    await chrome.runtime.sendMessage({ type: 'settings-changed' });
  } catch {
    /* no listener yet */
  }
}

export function hostOf(url: string | undefined): string {
  try {
    return new URL(url ?? '').hostname;
  } catch {
    return '';
  }
}
