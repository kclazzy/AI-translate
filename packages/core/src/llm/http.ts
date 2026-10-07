import { AppError } from '../errors';
import type { FetchLike } from './types';
import { tr } from '../i18n';

function hostPort(url: string): { host: string; port: string; local: boolean } {
  try {
    const u = new URL(url);
    const host = u.hostname;
    return { host, port: u.port, local: host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]' };
  } catch {
    return { host: url, port: '', local: false };
  }
}

function serverName(url: string): string {
  const { port } = hostPort(url);
  if (port === '11434') return 'Ollama';
  if (port === '1234') return 'LM Studio';
  return tr('сервер модели');
}

function shortBody(body: string): string {
  try {
    const j = JSON.parse(body) as { error?: string | { message?: string } };
    const e = typeof j.error === 'string' ? j.error : j.error?.message;
    if (e) return e.slice(0, 200);
  } catch {
    /* not JSON */
  }
  return body.slice(0, 200);
}

/** Map an HTTP failure from any provider to a stable error code with a hint the user can act on. */
export async function httpError(res: Response, providerLabel: string, url = '', model = ''): Promise<AppError> {
  const provider = tr(providerLabel);
  let body = '';
  try {
    body = await res.text();
  } catch {
    /* ignore */
  }
  const msg = shortBody(body);
  const name = serverName(url);
  const { local } = hostPort(url);
  if (res.status === 403 && local) {
    return new AppError('PROVIDER_UNAVAILABLE', {
      retryable: false,
      detail:
        name === 'Ollama'
          ? tr('Ollama отклоняет запросы расширения. Задайте переменную OLLAMA_ORIGINS=chrome-extension://*,moz-extension://* (setx в командной строке) и перезапустите Ollama.')
          : tr('{0} отклоняет запросы расширения (HTTP 403). Включите CORS в настройках сервера.', name),
    });
  }
  if (res.status === 401 || res.status === 403) return new AppError('INVALID_API_KEY', { detail: `${provider}: ${msg || `HTTP ${res.status}`}` });
  if (res.status === 429) {
    const ra = Number(res.headers.get('retry-after'));
    return new AppError('RATE_LIMITED', { detail: `${provider}: ${msg}`, retryAfterMs: Number.isFinite(ra) && ra > 0 ? ra * 1000 : undefined });
  }
  if (res.status === 413) return new AppError('IMAGE_TOO_LARGE', { detail: `${provider}: ${msg}` });
  if (res.status === 408 || res.status === 504) return new AppError('TIMEOUT', { detail: `${provider}: ${msg}` });
  if (res.status === 404 || /model .*not found|no such model|model_not_found/i.test(msg)) {
    const pull = name === 'Ollama' && model ? tr(' Скачайте её в Настройки → Локальные модели или выполните: ollama pull {0}', model) : name === 'LM Studio' ? tr(' Загрузите модель в LM Studio и проверьте её имя в настройках.') : tr(' Проверьте адрес API и имя модели в настройках.');
    return new AppError('PROVIDER_UNAVAILABLE', { retryable: false, detail: tr('Модель «{0}» не найдена на сервере ({1}).{2}', model || '?', provider, pull) });
  }
  if (res.status >= 500 || res.status === 529) {
    const vision = /image|vision|multimodal/i.test(msg) ? tr(' Похоже, модель не умеет читать изображения: выберите модель, читающую картинки (например qwen3.5 — Настройки → Локальные модели).') : '';
    const memory = /memory|out of memory|cuda|vram/i.test(msg) ? tr(' Не хватает видеопамяти: закройте другие модели или выберите модель поменьше.') : '';
    return new AppError('PROVIDER_UNAVAILABLE', { detail: tr('{0} вернул ошибку {1}: {2}.{3}{4}', provider, res.status, msg, vision, memory) });
  }
  return new AppError('TRANSLATION_FAILED', { detail: `${provider} HTTP ${res.status}: ${msg}`, retryable: false });
}

export async function safeFetch(fetchImpl: FetchLike, url: string, init: RequestInit, providerLabel: string): Promise<Response> {
  const provider = tr(providerLabel);
  try {
    return await fetchImpl(url, init);
  } catch (e) {
    const name = (e as Error)?.name;
    if (name === 'AbortError') {
      const reason = (init.signal as AbortSignal | undefined)?.reason;
      if (reason instanceof DOMException && reason.name === 'TimeoutError') throw new AppError('TIMEOUT', { detail: tr('{0} не ответил вовремя. Первая загрузка модели может занимать минуту — попробуйте ещё раз.', provider) });
      throw new AppError('CANCELLED');
    }
    if (name === 'TimeoutError') throw new AppError('TIMEOUT', { detail: provider });
    const { local, host, port } = hostPort(url);
    const server = serverName(url);
    const detail = local
      ? tr('Нет связи с {0} по адресу {1}:{2}. {3}', server, host, port, server === 'Ollama' ? tr('Запустите Ollama (значок в трее) и проверьте, что OLLAMA_ORIGINS=chrome-extension://* задан и Ollama перезапущена.') : server === 'LM Studio' ? tr('В LM Studio откройте Developer → Start Server и включите CORS.') : tr('Проверьте, что сервер запущен.'))
      : tr('Нет связи с {0} ({1}). Проверьте интернет и адрес API.', provider, host);
    throw new AppError('PROVIDER_UNAVAILABLE', { detail });
  }
}

export function joinUrl(base: string, path: string): string {
  return base.replace(/\/+$/, '') + '/' + path.replace(/^\/+/, '');
}
