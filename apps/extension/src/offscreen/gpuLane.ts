/**
 * One video card, three users: the local model (Ollama), the text detector and LaMa. Run together
 * they slow each other down (and push the model out of video memory), so they take turns: a model
 * request holds the card for as long as it runs, the detector and LaMa run between requests. The
 * model goes first when both wait (it is what the user waits for).
 *
 * A turn never holds the card for ever: a WebGPU call that stops answering (a driver that gave up)
 * or a local server that hangs would otherwise stop every picture after it. Past its time limit the
 * turn ends with GpuTimeout and the card goes to the next one; whatever the stuck call does later
 * is ignored. Waiting for a turn ends when the caller's signal aborts (a cancelled picture).
 */
type Waiter = { priority: number; seq: number; go: () => void };

let busy = false;
let seq = 0;
const waiting: Waiter[] = [];

function next(): void {
  if (busy || !waiting.length) return;
  waiting.sort((a, b) => b.priority - a.priority || a.seq - b.seq);
  const w = waiting.shift()!;
  busy = true;
  w.go();
}

export const GPU_MODEL = 2;
export const GPU_NETS = 1;
/** The model's check of pages already shown: after the pages the reader waits for and their nets. */
export const GPU_REVIEW = 0.5;

/** One detector or LaMa run (the session is loaded already). */
export const NETS_LIMIT_MS = 15_000;
/** A detector or LaMa run that loads its session first (shaders compiled on the card). */
export const NETS_LOAD_LIMIT_MS = 60_000;
/** One request to the local model: loading it from disk and a long answer fit easily. */
export const MODEL_LIMIT_MS = 240_000;

export class GpuTimeout extends Error {
  constructor(readonly limitMs: number) {
    super(`The video card did not answer in ${Math.round(limitMs / 1000)} s`);
    this.name = 'GpuTimeout';
  }
}

export interface GpuTurn {
  /** The turn ends after this long, with GpuTimeout (the card goes on to the next one). */
  limitMs?: number;
  /** Stop waiting for the turn (and the turn itself) when this aborts. */
  signal?: AbortSignal | null;
}

/** Run `fn` when the card is free (higher priority first, then in order of arrival). */
export async function onGpu<T>(priority: number, fn: () => Promise<T>, turn: GpuTurn = {}): Promise<T> {
  const { signal, limitMs } = turn;
  if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
  await new Promise<void>((go, stop) => {
    const w: Waiter = {
      priority,
      seq: seq++,
      go: () => {
        signal?.removeEventListener('abort', onAbort);
        go();
      },
    };
    const onAbort = () => {
      const i = waiting.indexOf(w);
      if (i >= 0) waiting.splice(i, 1);
      stop(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    waiting.push(w);
    next();
  });
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    busy = false;
    next();
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const stops: Promise<never>[] = [];
    if (limitMs) stops.push(new Promise<never>((_, stop) => (timer = setTimeout(() => stop(new GpuTimeout(limitMs)), limitMs))));
    if (signal) stops.push(new Promise<never>((_, stop) => signal.addEventListener('abort', (onAbort = () => stop(signal.reason ?? new DOMException('Aborted', 'AbortError'))), { once: true })));
    const work = fn();
    // A late failure of the abandoned call must not surface as an unhandled rejection.
    work.catch(() => undefined);
    return await (stops.length ? Promise.race([work, ...stops]) : work);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
    release();
  }
}

/** Run `fn` with a time limit but without taking the card (work on the processor). */
export async function withLimit<T>(fn: () => Promise<T>, limitMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = fn();
  work.catch(() => undefined);
  try {
    return await Promise.race([work, new Promise<never>((_, stop) => (timer = setTimeout(() => stop(new GpuTimeout(limitMs)), limitMs)))]);
  } finally {
    clearTimeout(timer);
  }
}

/** Waiting for the card or holding it right now (for tests and the ⓘ line). */
export function gpuState(): { busy: boolean; waiting: number } {
  return { busy, waiting: waiting.length };
}

/** A request to a model running on this computer (Ollama, LM Studio): the generation itself. */
export function isLocalGeneration(url: string, init?: RequestInit): boolean {
  if ((init?.method ?? 'GET').toUpperCase() !== 'POST') return false;
  try {
    const u = new URL(url);
    const local = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/.test(u.hostname);
    return local && /\/(api\/chat|api\/generate|v1\/chat\/completions)$/.test(u.pathname);
  } catch {
    return false;
  }
}

/** fetch that holds the card while a local model generates. */
export function gpuFetch(base: typeof fetch = fetch, limitMs = MODEL_LIMIT_MS, priority = GPU_MODEL): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!isLocalGeneration(url, init)) return base(input, init);
    // The request itself is stopped too when its time is up (a server that never answers).
    const ctrl = new AbortController();
    const outer = init?.signal;
    const follow = () => ctrl.abort(outer?.reason);
    if (outer?.aborted) ctrl.abort(outer.reason);
    else outer?.addEventListener('abort', follow, { once: true });
    // The whole answer is read inside the turn: the model works until the body ends.
    return onGpu(
      priority,
      async () => {
        const res = await base(input, { ...init, signal: ctrl.signal });
        const body = await res.arrayBuffer();
        return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
      },
      { limitMs, signal: outer },
    ).catch((e: unknown) => {
      if (e instanceof GpuTimeout) {
        ctrl.abort(e);
        // Reported like any request that took too long (the job may try again).
        throw new DOMException(e.message, 'TimeoutError');
      }
      throw e;
    }).finally(() => outer?.removeEventListener('abort', follow));
  }) as typeof fetch;
}

/**
 * Sessions of the detector and LaMa are let go after this long without work (video memory for the
 * model). Not sooner: a page that takes long (a slow model) would otherwise load and compile them
 * again on every page, which made each page slower still.
 */
export const IDLE_RELEASE_MS = 300_000;

let workWaiting: () => boolean = () => false;
/** Tell the lane how to see that pictures are still waiting or in work (the job queue). */
export function setWorkWaiting(fn: () => boolean): void {
  workWaiting = fn;
}

/**
 * Call `release` after IDLE_RELEASE_MS without use — but never while pictures still wait in the
 * queue (a slow page between two runs is no reason to load and compile the session again).
 * Returns a function that cancels it.
 */
export function releaseWhenIdle(release: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    timer = setTimeout(() => {
      if (workWaiting()) arm();
      else release();
    }, IDLE_RELEASE_MS);
  };
  arm();
  return () => clearTimeout(timer);
}
