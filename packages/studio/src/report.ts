import JSZip from 'jszip';
import type { AppSettings, HistoryEntry, IdbStore } from '@ait/core';

/** Settings without anything secret: API keys, engine token, addresses with passwords. */
export function redactSettings(s: AppSettings): unknown {
  const clean = JSON.parse(JSON.stringify(s)) as AppSettings & Record<string, unknown>;
  clean.providers = clean.providers.map((p) => ({ ...p, apiKey: p.apiKey ? '[скрыто]' : undefined, baseUrl: p.baseUrl.replace(/\/\/[^/@]*@/, '//[скрыто]@') }));
  if (clean.engine) clean.engine = { ...clean.engine, token: clean.engine.token ? '[скрыто]' : '' };
  delete clean.modelCatalog;
  return clean;
}

/**
 * «Сообщить о проблеме»: one zip with what helps to understand a problem — version, browser,
 * settings without keys, recent history and model checks. No pictures, no API keys.
 */
export async function buildReport(opts: { db: IdbStore; settings: AppSettings; version: string; kind: string; history: HistoryEntry[]; note?: string }): Promise<Uint8Array> {
  const zip = new JSZip();
  const nav = typeof navigator !== 'undefined' ? navigator : undefined;
  zip.file(
    'info.json',
    JSON.stringify({ app: 'AI Translate', version: opts.version, platform: opts.kind, userAgent: nav?.userAgent, language: nav?.language, date: new Date().toISOString(), note: opts.note ?? '' }, null, 2),
  );
  zip.file('settings.json', JSON.stringify(redactSettings(opts.settings), null, 2));
  zip.file('history.json', JSON.stringify(opts.history.slice(0, 50).map((h) => ({ ...h, url: h.url ? h.url.replace(/[?#].*$/, '') : undefined })), null, 2));
  try {
    zip.file('speed.json', JSON.stringify((await opts.db.get('kv', 'speed')) ?? null, null, 2));
  } catch {
    /* none */
  }
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}
