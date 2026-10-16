/**
 * One video card, three users: the local model (Ollama), the text detector and LaMa. Run together
 * they slow each other down (and push the model out of video memory), so they take turns: a model
 * request holds the card for as long as it runs, the detector and LaMa run between requests. The
 * model goes first when both wait (it is what the user waits for).
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

/** Run `fn` when the card is free (higher priority first, then in order of arrival). */
export async function onGpu<T>(priority: number, fn: () => Promise<T>): Promise<T> {
  await new Promise<void>((go) => {
    waiting.push({ priority, seq: seq++, go });
    next();
  });
  try {
    return await fn();
  } finally {
    busy = false;
    next();
  }
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
export function gpuFetch(base: typeof fetch = fetch): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!isLocalGeneration(url, init)) return base(input, init);
    // The whole answer is read inside the turn: the model works until the body ends.
    return onGpu(GPU_MODEL, async () => {
      const res = await base(input, init);
      const body = await res.arrayBuffer();
      return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
    });
  }) as typeof fetch;
}

/** Sessions of the detector and LaMa are let go after this long without work (video memory for the model). */
export const IDLE_RELEASE_MS = 90_000;
