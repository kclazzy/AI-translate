import { httpError, joinUrl, safeFetch } from './http';
import type { FetchLike, ProviderConfig } from './types';

export interface DiscoveredModel {
  id: string;
  /** true/false when the server says so; undefined when unknown. */
  vision?: boolean;
  /** Loaded into memory right now (LM Studio). */
  loaded?: boolean;
  /** Approximate size on disk, bytes (Ollama). */
  size?: number;
}

function origin(baseUrl: string): string {
  try {
    const u = new URL(baseUrl);
    return `${u.protocol}//${u.host}`;
  } catch {
    return baseUrl.replace(/\/v1\/?$/, '');
  }
}

async function getJson(fetchImpl: FetchLike, url: string, init: RequestInit, label: string): Promise<unknown | null> {
  try {
    const res = await safeFetch(fetchImpl, url, init, label);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * List models with as much detail as the server offers:
 * LM Studio (/api/v0/models: type vlm/llm, loaded state), Ollama (/api/tags + /api/show capabilities),
 * otherwise the plain OpenAI-compatible /v1/models list.
 */
export async function discoverModels(cfg: Pick<ProviderConfig, 'baseUrl' | 'apiKey' | 'label' | 'kind'>, fetchImpl: FetchLike = (u, i) => fetch(u, i)): Promise<DiscoveredModel[]> {
  const root = origin(cfg.baseUrl);
  const headers: Record<string, string> = {};
  if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;

  if (cfg.kind === 'openai-compatible') {
    // LM Studio native REST API
    const lm = (await getJson(fetchImpl, `${root}/api/v0/models`, { headers }, cfg.label)) as { data?: { id: string; type?: string; state?: string }[] } | null;
    if (lm?.data?.length && lm.data.some((m) => m.type)) {
      return lm.data
        .filter((m) => m.type !== 'embeddings')
        .map((m) => ({ id: m.id, vision: m.type === 'vlm', loaded: m.state === 'loaded' }))
        .sort((a, b) => Number(b.loaded) - Number(a.loaded) || Number(b.vision) - Number(a.vision));
    }
    // Ollama native API
    const ol = (await getJson(fetchImpl, `${root}/api/tags`, {}, cfg.label)) as { models?: { name: string; size?: number }[] } | null;
    if (ol?.models) {
      const out: DiscoveredModel[] = [];
      for (const m of ol.models.slice(0, 60)) {
        const show = (await getJson(fetchImpl, `${root}/api/show`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: m.name }) }, cfg.label)) as { capabilities?: string[]; projector_info?: unknown } | null;
        const caps = show?.capabilities;
        out.push({ id: m.name, size: m.size, vision: caps ? caps.includes('vision') : show?.projector_info ? true : undefined });
      }
      return out.sort((a, b) => Number(b.vision ?? false) - Number(a.vision ?? false));
    }
  }

  // Generic OpenAI-compatible list (also the error path that explains what is wrong).
  const res = await safeFetch(fetchImpl, joinUrl(cfg.baseUrl, 'models'), { headers }, cfg.label);
  if (!res.ok) throw await httpError(res, cfg.label, cfg.baseUrl);
  const json = (await res.json()) as { data?: { id: string }[] };
  return (json.data ?? []).map((m) => ({ id: m.id }));
}

/** Models that think before answering (Qwen3 family, DeepSeek-R1, QwQ…). */
export function isThinkingModel(model: string): boolean {
  return /qwen3|qwq|deepseek-r1|r1-distill|thinking|reason/i.test(model);
}

export const RECOMMENDED_VISION_MODEL = 'qwen2.5vl:7b';
export const RECOMMENDED_VISION_SIZE = '≈6 ГБ';

export type OllamaStatus = { state: 'ok'; models: string[] } | { state: 'missing'; models: string[] } | { state: 'offline'; detail: string } | { state: 'forbidden' };

function sameModel(a: string, b: string): boolean {
  const norm = (s: string) => (s.includes(':') ? s : `${s}:latest`);
  return norm(a) === norm(b);
}

/** Is Ollama reachable and does it have `model`? */
export async function ollamaStatus(baseUrl: string, model: string, fetchImpl: FetchLike = (u, i) => fetch(u, i)): Promise<OllamaStatus> {
  const root = origin(baseUrl);
  let res: Response;
  try {
    res = await fetchImpl(`${root}/api/tags`, {});
  } catch (e) {
    return { state: 'offline', detail: (e as Error)?.message ?? String(e) };
  }
  if (res.status === 403) return { state: 'forbidden' };
  if (!res.ok) return { state: 'offline', detail: `HTTP ${res.status}` };
  const json = (await res.json()) as { models?: { name: string }[] };
  const models = (json.models ?? []).map((m) => m.name);
  return { state: models.some((m) => sameModel(m, model)) ? 'ok' : 'missing', models };
}

export interface PullProgress {
  status: string;
  completed?: number;
  total?: number;
}

/** Download a model through Ollama's API, reporting progress from its NDJSON stream. */
export async function ollamaPull(baseUrl: string, model: string, onProgress: (p: PullProgress) => void, signal?: AbortSignal, fetchImpl: FetchLike = (u, i) => fetch(u, i)): Promise<void> {
  const root = origin(baseUrl);
  const res = await safeFetch(fetchImpl, `${root}/api/pull`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, stream: true }), signal }, 'Ollama');
  if (!res.ok) throw await httpError(res, 'Ollama', baseUrl, model);
  if (!res.body) throw new Error('Ollama returned no progress stream');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let last: PullProgress | null = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const j = JSON.parse(line) as PullProgress & { error?: string };
      if (j.error) throw new Error(j.error);
      last = j;
      onProgress(j);
    }
  }
  if (buf.trim()) {
    const j = JSON.parse(buf) as PullProgress & { error?: string };
    if (j.error) throw new Error(j.error);
    last = j;
    onProgress(j);
  }
  if (last?.status !== 'success') throw new Error(`Загрузка прервана (${last?.status ?? 'нет ответа'})`);
}
