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
