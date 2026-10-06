import { AppError } from '../errors';
import type { FetchLike } from './types';

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
  return 'сервер модели';
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
export async function httpError(res: Response, provider: string, url = '', model = ''): Promise<AppError> {
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
          ? 'Ollama отклоняет запросы расширения. Задайте переменную OLLAMA_ORIGINS=chrome-extension://*,moz-extension://* (setx в командной строке) и перезапустите Ollama.'
          : `${name} отклоняет запросы расширения (HTTP 403). Включите CORS в настройках сервера.`,
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
    const pull = name === 'Ollama' && model ? ` Скачайте её в Настройки → Локальные модели или выполните: ollama pull ${model}` : name === 'LM Studio' ? ' Загрузите модель в LM Studio и проверьте её имя в настройках.' : ' Проверьте адрес API и имя модели в настройках.';
    return new AppError('PROVIDER_UNAVAILABLE', { retryable: false, detail: `Модель «${model || '?'}» не найдена на сервере (${provider}).${pull}` });
  }
  if (res.status >= 500 || res.status === 529) {
    const vision = /image|vision|multimodal/i.test(msg) ? ' Похоже, модель не умеет читать изображения: выберите модель, читающую картинки (например qwen3.5 — Настройки → Локальные модели).' : '';
    const memory = /memory|out of memory|cuda|vram/i.test(msg) ? ' Не хватает видеопамяти: закройте другие модели или выберите модель поменьше.' : '';
    return new AppError('PROVIDER_UNAVAILABLE', { detail: `${provider} вернул ошибку ${res.status}: ${msg}.${vision}${memory}` });
  }
  return new AppError('TRANSLATION_FAILED', { detail: `${provider} HTTP ${res.status}: ${msg}`, retryable: false });
}

export async function safeFetch(fetchImpl: FetchLike, url: string, init: RequestInit, provider: string): Promise<Response> {
  try {
    return await fetchImpl(url, init);
  } catch (e) {
    const name = (e as Error)?.name;
    if (name === 'AbortError') {
      const reason = (init.signal as AbortSignal | undefined)?.reason;
      if (reason instanceof DOMException && reason.name === 'TimeoutError') throw new AppError('TIMEOUT', { detail: `${provider} не ответил вовремя. Первая загрузка модели может занимать минуту — попробуйте ещё раз.` });
      throw new AppError('CANCELLED');
    }
    if (name === 'TimeoutError') throw new AppError('TIMEOUT', { detail: provider });
    const { local, host, port } = hostPort(url);
    const server = serverName(url);
    const detail = local
      ? `Нет связи с ${server} по адресу ${host}:${port}. ${server === 'Ollama' ? 'Запустите Ollama (значок в трее) и проверьте, что OLLAMA_ORIGINS=chrome-extension://* задан и Ollama перезапущена.' : server === 'LM Studio' ? 'В LM Studio откройте Developer → Start Server и включите CORS.' : 'Проверьте, что сервер запущен.'}`
      : `Нет связи с ${provider} (${host}). Проверьте интернет и адрес API.`;
    throw new AppError('PROVIDER_UNAVAILABLE', { detail });
  }
}

export function joinUrl(base: string, path: string): string {
  return base.replace(/\/+$/, '') + '/' + path.replace(/^\/+/, '');
}
