import { AppError } from '../errors';
import type { FetchLike } from './types';

/** Map an HTTP failure from any provider to a stable error code. */
export async function httpError(res: Response, provider: string): Promise<AppError> {
  let body = '';
  try {
    body = (await res.text()).slice(0, 500);
  } catch {
    /* ignore */
  }
  const detail = `${provider} HTTP ${res.status}: ${body}`;
  if (res.status === 401 || res.status === 403) return new AppError('INVALID_API_KEY', { detail });
  if (res.status === 429) {
    const ra = Number(res.headers.get('retry-after'));
    return new AppError('RATE_LIMITED', { detail, retryAfterMs: Number.isFinite(ra) && ra > 0 ? ra * 1000 : undefined });
  }
  if (res.status === 413) return new AppError('IMAGE_TOO_LARGE', { detail });
  if (res.status === 408 || res.status === 504) return new AppError('TIMEOUT', { detail });
  if (res.status >= 500 || res.status === 529) return new AppError('PROVIDER_UNAVAILABLE', { detail });
  if (res.status === 404) return new AppError('PROVIDER_UNAVAILABLE', { detail: `${detail} (check base URL and model name)`, retryable: false });
  return new AppError('TRANSLATION_FAILED', { detail, retryable: false });
}

export async function safeFetch(fetchImpl: FetchLike, url: string, init: RequestInit, provider: string): Promise<Response> {
  try {
    return await fetchImpl(url, init);
  } catch (e) {
    const name = (e as Error)?.name;
    if (name === 'AbortError') {
      const reason = (init.signal as AbortSignal | undefined)?.reason;
      if (reason instanceof DOMException && reason.name === 'TimeoutError') throw new AppError('TIMEOUT', { detail: provider });
      throw new AppError('CANCELLED');
    }
    if (name === 'TimeoutError') throw new AppError('TIMEOUT', { detail: provider });
    throw new AppError('PROVIDER_UNAVAILABLE', { detail: `${provider}: ${(e as Error)?.message ?? e}` });
  }
}

export function joinUrl(base: string, path: string): string {
  return base.replace(/\/+$/, '') + '/' + path.replace(/^\/+/, '');
}
