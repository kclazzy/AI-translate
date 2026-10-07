import { EngineClient } from '../pipeline/engine';
import type { AppSettings } from '../settings';
import { providerById } from '../settings';
import { ollamaStatus } from './discover';
import { isOllama } from './openai';
import { isLocalUrl } from './privacy';
import type { FetchLike, ProviderConfig } from './types';
import { tr } from '../i18n';

/**
 * What is missing before a local translation can start, so the app can offer to install or
 * start it instead of failing on every picture.
 */
export type Readiness =
  | { ok: true }
  | { ok: false; need: 'ollama'; baseUrl: string }
  | { ok: false; need: 'ollama-model'; baseUrl: string; model: string }
  | { ok: false; need: 'lmstudio'; baseUrl: string }
  | { ok: false; need: 'server'; baseUrl: string; label: string }
  | { ok: false; need: 'engine'; baseUrl: string };

async function reachable(url: string, fetchImpl: FetchLike, ms = 2500): Promise<boolean> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetchImpl(url, { signal: ctrl.signal });
    return res.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

async function checkProvider(p: ProviderConfig, fetchImpl: FetchLike): Promise<Readiness> {
  if (!isLocalUrl(p.baseUrl) || p.kind !== 'openai-compatible') return { ok: true };
  if (isOllama(p)) {
    const st = await ollamaStatus(p.baseUrl, p.model, fetchImpl);
    if (st.state === 'offline') return { ok: false, need: 'ollama', baseUrl: p.baseUrl };
    if (st.state === 'missing') return { ok: false, need: 'ollama-model', baseUrl: p.baseUrl, model: p.model };
    return { ok: true };
  }
  if (await reachable(`${p.baseUrl.replace(/\/+$/, '')}/models`, fetchImpl)) return { ok: true };
  return p.preset === 'lmstudio' || /:1234\b/.test(p.baseUrl) ? { ok: false, need: 'lmstudio', baseUrl: p.baseUrl } : { ok: false, need: 'server', baseUrl: p.baseUrl, label: p.label };
}

/** Check the programs the current settings rely on (Ollama, its model, LM Studio, the engine). */
export async function checkReadiness(s: AppSettings, fetchImpl: FetchLike = (u, i) => fetch(u, i)): Promise<Readiness> {
  if (s.pipeline === 'engine') {
    if (!isLocalUrl(s.engine.url)) return { ok: true };
    try {
      await new EngineClient(s.engine.url, s.engine.token, fetchImpl).health();
      return { ok: true };
    } catch {
      return { ok: false, need: 'engine', baseUrl: s.engine.url };
    }
  }
  const seen = new Set<string>();
  for (const p of [providerById(s, s.visionProviderId), providerById(s, s.translationProviderId)]) {
    if (!p || seen.has(p.id)) continue;
    seen.add(p.id);
    const r = await checkProvider(p, fetchImpl);
    if (!r.ok) return r;
  }
  return { ok: true };
}

/** Download pages for the programs (Windows installer first; the page covers macOS and Linux). */
export const SETUP_LINKS = {
  ollamaWindows: 'https://ollama.com/download/OllamaSetup.exe',
  ollamaPage: 'https://ollama.com/download',
  lmstudio: 'https://lmstudio.ai/download',
  python: 'https://www.python.org/downloads/',
  releases: 'https://github.com/kclazzy/AI-translate/releases/latest',
};

/** One sentence for the user about what is missing. */
export function readinessText(r: Readiness): string {
  if (r.ok) return tr('Всё готово к переводу.');
  switch (r.need) {
    case 'ollama':
      return tr('Для перевода на этом компьютере нужна программа Ollama — она не установлена или не запущена.');
    case 'ollama-model':
      return tr('В Ollama нет модели {0} — её нужно скачать.', r.model);
    case 'lmstudio':
      return tr('LM Studio не запущена или её сервер выключен.');
    case 'server':
      return tr('{0} не отвечает по адресу {1}.', r.label, r.baseUrl);
    case 'engine':
      return tr('Локальный движок AI Translate не запущен.');
  }
}
