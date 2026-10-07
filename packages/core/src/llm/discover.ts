import { httpError, joinUrl, safeFetch } from './http';
import type { FetchLike, ProviderConfig } from './types';
import { tr } from '../i18n';

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

/** Image-reading models for each amount of video memory (Ollama tags, Qwen3.5 family, March 2026). */
export interface ModelTier {
  vramGb: number;
  model: string;
  sizeGb: number;
  quality: string;
  /** Rough seconds per manga page on a matching card. */
  secondsPerPage: string;
}

export const MODEL_TIERS: ModelTier[] = [
  { vramGb: 2, model: 'qwen3.5:0.8b', sizeGb: 1.3, quality: tr('базовое: может путать японский в баблах'), secondsPerPage: '20–40' },
  { vramGb: 4, model: 'qwen3.5:2b-q4_K_M', sizeGb: 1.9, quality: tr('приемлемое'), secondsPerPage: '20–40' },
  { vramGb: 6, model: 'qwen3.5:4b-q4_K_M', sizeGb: 3.3, quality: tr('хорошее'), secondsPerPage: '15–30' },
  { vramGb: 8, model: 'qwen3.5:4b-q8_0', sizeGb: 5.2, quality: tr('хорошее, точнее читает мелкий текст'), secondsPerPage: '15–25' },
  // 9B Q4 leaves room on a 12 GB card for the picture and the answer; on 8 GB it would spill into RAM.
  { vramGb: 12, model: 'qwen3.5:9b-q4_K_M', sizeGb: 6.6, quality: tr('очень хорошее'), secondsPerPage: '10–20' },
  { vramGb: 16, model: 'qwen3.5:9b-q8_0', sizeGb: 10, quality: tr('лучшее для домашних видеокарт'), secondsPerPage: '10–20' },
];

export function tierForVram(vramGb: number | undefined): ModelTier {
  const v = vramGb ?? 12;
  let best = MODEL_TIERS[0];
  for (const t of MODEL_TIERS) if (t.vramGb <= v) best = t;
  return best;
}

/** Best guess of video memory from the GPU name reported by the browser (user can change it). */
export function guessVramGb(gpuName: string): number | undefined {
  const n = gpuName.toLowerCase();
  const table: [RegExp, number][] = [
    [/rtx\s*5090/, 32], [/rtx\s*5080/, 16], [/rtx\s*5070\s*ti/, 16], [/rtx\s*5070/, 12], [/rtx\s*5060\s*ti/, 16], [/rtx\s*5060/, 8], [/rtx\s*5050/, 8],
    [/rtx\s*4090/, 24], [/rtx\s*4080/, 16], [/rtx\s*4070\s*ti\s*super/, 16], [/rtx\s*4070/, 12], [/rtx\s*4060\s*ti/, 8], [/rtx\s*4060/, 8],
    [/rtx\s*3090/, 24], [/rtx\s*3080/, 10], [/rtx\s*3070/, 8], [/rtx\s*3060\s*ti/, 8], [/rtx\s*3060/, 12], [/rtx\s*3050/, 8],
    [/rtx\s*2080/, 8], [/rtx\s*2070/, 8], [/rtx\s*2060/, 6], [/gtx\s*1660/, 6], [/gtx\s*1650/, 4], [/gtx\s*1080/, 8], [/gtx\s*1070/, 8], [/gtx\s*1060/, 6], [/gtx\s*1050/, 2],
    [/rx\s*9070/, 16], [/rx\s*7900/, 20], [/rx\s*7800/, 16], [/rx\s*7700/, 12], [/rx\s*7600/, 8], [/rx\s*6700/, 12], [/rx\s*6600/, 8], [/rx\s*580|rx\s*570/, 8],
    [/arc.*b580/, 12], [/arc.*a770/, 16], [/arc.*a750/, 8],
  ];
  for (const [re, gb] of table) if (re.test(n)) return gb;
  if (/intel|uhd|iris|radeon\(tm\) graphics|vega \d/.test(n)) return 2;
  return undefined;
}


export interface OllamaModel {
  name: string;
  size?: number;
  modifiedAt?: string;
}

export type OllamaStatus = { state: 'ok'; models: string[]; list: OllamaModel[] } | { state: 'missing'; models: string[]; list: OllamaModel[] } | { state: 'offline'; detail: string } | { state: 'forbidden' };

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
  const json = (await res.json()) as { models?: { name: string; size?: number; modified_at?: string }[] };
  const list = (json.models ?? []).map((m) => ({ name: m.name, size: m.size, modifiedAt: m.modified_at }));
  const models = list.map((m) => m.name);
  return { state: models.some((m) => sameModel(m, model)) ? 'ok' : 'missing', models, list };
}

export function isSameModel(a: string, b: string): boolean {
  return sameModel(a, b);
}

/** Remove a model from Ollama (frees disk space). */
export async function ollamaDelete(baseUrl: string, model: string, fetchImpl: FetchLike = (u, i) => fetch(u, i)): Promise<void> {
  const root = origin(baseUrl);
  const res = await safeFetch(fetchImpl, `${root}/api/delete`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model }) }, 'Ollama');
  if (!res.ok && res.status !== 404) throw await httpError(res, 'Ollama', baseUrl, model);
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
  if (last?.status !== 'success') throw new Error(tr('Загрузка прервана ({0})', last?.status ?? tr('нет ответа')));
}

export interface LoadedModel {
  name: string;
  /** Bytes of video memory the model holds. */
  sizeVram: number;
  /** Total bytes the loaded model takes (video memory + system RAM). */
  size: number;
}

/** Share of a loaded model in video memory (1 = all on the GPU). Below ~0.95 it runs several times slower. */
export function gpuShare(m: LoadedModel): number {
  return m.size > 0 ? Math.min(1, m.sizeVram / m.size) : 1;
}

/** Models Ollama currently holds in memory (GET /api/ps). Empty when Ollama is not running. */
export async function ollamaLoaded(baseUrl: string, fetchImpl: FetchLike = (u, i) => fetch(u, i)): Promise<LoadedModel[]> {
  try {
    const res = await fetchImpl(`${origin(baseUrl)}/api/ps`, {});
    if (!res.ok) return [];
    const j = (await res.json()) as { models?: { name?: string; model?: string; size_vram?: number; size?: number }[] };
    return (j.models ?? []).map((m) => ({ name: m.name ?? m.model ?? '', sizeVram: m.size_vram ?? 0, size: m.size ?? m.size_vram ?? 0 }));
  } catch {
    return [];
  }
}

/** Free the video memory: ask Ollama to unload every loaded model (keep_alive 0). Returns what was unloaded. */
export async function ollamaUnloadAll(baseUrl: string, fetchImpl: FetchLike = (u, i) => fetch(u, i)): Promise<string[]> {
  const loaded = await ollamaLoaded(baseUrl, fetchImpl);
  await Promise.all(
    loaded.map((m) =>
      fetchImpl(`${origin(baseUrl)}/api/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: m.name, keep_alive: 0 }) }).catch(() => undefined),
    ),
  );
  return loaded.map((m) => m.name);
}
