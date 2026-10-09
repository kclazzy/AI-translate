import { AppError, toAppError } from '../errors';

export interface RetryOptions {
  retries?: number;
  baseMs?: number;
  maxMs?: number;
  signal?: AbortSignal;
  onRetry?: (attempt: number, err: AppError, delayMs: number) => void;
  /** Override the default "retry only retryable errors" rule. */
  shouldRetry?: (err: AppError) => boolean;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new AppError('CANCELLED'));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new AppError('CANCELLED'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Exponential backoff with full jitter; honours Retry-After from rate limits. */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const retries = opts.retries ?? 3;
  const base = opts.baseMs ?? 600;
  const max = opts.maxMs ?? 10_000;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (raw) {
      const err = toAppError(raw);
      // Out of memory: the same request fails the same way; the service retries it lighter instead.
      const retry = err.code !== 'OUT_OF_MEMORY' && (opts.shouldRetry ? opts.shouldRetry(err) : err.retryable);
      if (!retry || attempt >= retries || err.code === 'CANCELLED') throw err;
      const exp = Math.min(max, base * 2 ** attempt);
      const delay = err.retryAfterMs ? Math.min(max * 3, err.retryAfterMs) : Math.round(exp / 2 + Math.random() * exp / 2);
      opts.onRetry?.(attempt + 1, err, delay);
      await sleep(delay, opts.signal);
    }
  }
}

/** Combine an optional caller signal with a timeout. */
export function timeoutSignal(ms: number, parent?: AbortSignal): { signal: AbortSignal; dispose: () => void } {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new DOMException('timeout', 'TimeoutError')), ms);
  const onAbort = () => ctrl.abort(parent?.reason);
  if (parent) {
    if (parent.aborted) ctrl.abort(parent.reason);
    else parent.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: ctrl.signal,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', onAbort);
    },
  };
}
