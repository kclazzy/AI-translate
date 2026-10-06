import { AppError, toAppError, type SerializedError } from '../errors';
import type { ImageBackend } from '../image/backend';
import { TiledImage } from '../image/tiled';
import { mergeContext, type TranslationContext } from '../translate/context';
import type { PageResult, StageEvent } from '../types';
import { timeoutSignal } from '../util/retry';
import type { FetchLike } from '../llm/types';
import { pipelineHash, type PipelineConfig } from './config';
import type { PipelineOutput, PipelineRequest } from './standalone';

export interface EngineHealth {
  status: 'ok';
  version: string;
  device: string;
  gpu: string | null;
  detectors: string[];
  ocr: string[];
  inpainters: string[];
}

interface EngineDone {
  page: PageResult;
  cleanedTiles: { y: number; h: number; assetId: string }[];
  originalAssetId?: string;
  contextUpdate?: { entities: unknown[]; summary: string; lines: { src: string; dst: string }[] };
}

/**
 * Client for the Python engine (local GPU or remote server). The engine detects, reads,
 * translates and cleans; text is typeset on the client with the shared renderer.
 */
export class EngineClient {
  constructor(public baseUrl: string, public token: string, private fetchImpl: FetchLike = (u, i) => fetch(u, i)) {}

  private url(path: string) {
    return this.baseUrl.replace(/\/+$/, '') + path;
  }

  private headers(extra: Record<string, string> = {}) {
    return { authorization: `Bearer ${this.token}`, ...extra };
  }

  private async request(path: string, init: RequestInit = {}, timeoutMs = 15_000): Promise<Response> {
    const { signal, dispose } = timeoutSignal(timeoutMs, init.signal ?? undefined);
    try {
      const res = await this.fetchImpl(this.url(path), { ...init, signal, headers: { ...this.headers(), ...(init.headers as Record<string, string>) } });
      if (res.status === 401 || res.status === 403) throw new AppError('ENGINE_UNAUTHORIZED', { retryable: false });
      if (!res.ok) {
        let err: SerializedError | undefined;
        try {
          err = ((await res.json()) as { error?: SerializedError }).error;
        } catch {
          /* not JSON */
        }
        if (err?.code) throw toAppError(err);
        throw new AppError('ENGINE_UNAVAILABLE', { detail: `HTTP ${res.status}` });
      }
      return res;
    } catch (e) {
      if (e instanceof AppError) throw e;
      const name = (e as Error)?.name;
      if (name === 'AbortError' || name === 'TimeoutError') {
        if ((init.signal as AbortSignal | undefined)?.aborted) throw new AppError('CANCELLED');
        throw new AppError('TIMEOUT', { detail: 'engine' });
      }
      throw new AppError('ENGINE_UNAVAILABLE', { detail: (e as Error)?.message });
    } finally {
      dispose();
    }
  }

  async health(signal?: AbortSignal): Promise<EngineHealth> {
    const res = await this.request('/v1/health', { signal }, 5000);
    return (await res.json()) as EngineHealth;
  }

  async asset(id: string, signal?: AbortSignal): Promise<Uint8Array> {
    const res = await this.request(`/v1/assets/${encodeURIComponent(id)}`, { signal }, 60_000);
    return new Uint8Array(await res.arrayBuffer());
  }

  /** Submit a page and follow its progress over Server-Sent Events. */
  async translatePage(bytes: Uint8Array, mime: string, config: PipelineConfig, context: TranslationContext | undefined, opts: { signal?: AbortSignal; onStage?: (e: StageEvent) => void } = {}): Promise<EngineDone> {
    const form = new FormData();
    form.append('image', new Blob([bytes as BlobPart], { type: mime || 'application/octet-stream' }), 'page');
    form.append(
      'options',
      JSON.stringify({
        sourceLang: config.sourceLang,
        targetLang: config.targetLang,
        quality: config.quality,
        privacy: config.privacy,
        profile: config.profile,
        glossary: config.glossary,
        context: context ?? null,
        translateSfx: config.translateSfx,
        sfxStyle: config.sfxStyle,
        translator: config.translator ?? config.vision,
        vision: config.vision,
        ...(config.engine?.options ?? {}),
      }),
    );
    const res = await this.request('/v1/pages/translate', { method: 'POST', body: form, signal: opts.signal }, 60_000);
    const { jobId } = (await res.json()) as { jobId: string };
    const onAbort = () => {
      void this.fetchImpl(this.url(`/v1/jobs/${jobId}`), { method: 'DELETE', headers: this.headers() }).catch(() => undefined);
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      return await this.followJob(jobId, opts);
    } finally {
      opts.signal?.removeEventListener('abort', onAbort);
    }
  }

  private async followJob(jobId: string, opts: { signal?: AbortSignal; onStage?: (e: StageEvent) => void }): Promise<EngineDone> {
    const res = await this.request(`/v1/jobs/${jobId}/events`, { signal: opts.signal, headers: { accept: 'text/event-stream' } }, 15 * 60_000);
    if (!res.body) throw new AppError('ENGINE_UNAVAILABLE', { detail: 'No event stream' });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const ev = parseSse(raw);
        if (!ev) continue;
        if (ev.event === 'stage') opts.onStage?.(ev.data as StageEvent);
        else if (ev.event === 'done') {
          void reader.cancel();
          return ev.data as EngineDone;
        } else if (ev.event === 'error') {
          void reader.cancel();
          throw toAppError(ev.data);
        }
      }
    }
    throw new AppError('ENGINE_UNAVAILABLE', { detail: 'Event stream ended early' });
  }

  async inpaint(image: Uint8Array, mask: Uint8Array, signal?: AbortSignal): Promise<Uint8Array> {
    const form = new FormData();
    form.append('image', new Blob([image as BlobPart], { type: 'image/png' }), 'image.png');
    form.append('mask', new Blob([mask as BlobPart], { type: 'image/png' }), 'mask.png');
    const res = await this.request('/v1/inpaint', { method: 'POST', body: form, signal }, 120_000);
    return new Uint8Array(await res.arrayBuffer());
  }
}

export function parseSse(raw: string): { event: string; data: unknown } | null {
  let event = 'message';
  const data: string[] = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith(':')) continue;
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  if (!data.length) return null;
  try {
    return { event, data: JSON.parse(data.join('\n')) };
  } catch {
    return null;
  }
}

export async function runEnginePipeline(req: PipelineRequest, deps: { backend: ImageBackend; fetchImpl?: FetchLike }): Promise<PipelineOutput> {
  const engine = req.config.engine;
  if (!engine?.url) throw new AppError('NOT_CONFIGURED', { retryable: false, detail: 'Engine URL is empty' });
  const client = new EngineClient(engine.url, engine.token, deps.fetchImpl);
  req.onStage?.({ stage: 'detecting' });
  const done = await client.translatePage(req.bytes, req.mime ?? 'application/octet-stream', req.config, req.context, { signal: req.signal, onStage: req.onStage });
  const original = await TiledImage.fromBytes(deps.backend, req.bytes, req.mime);
  const cleaned = new TiledImage(deps.backend, original.width, original.height);
  for (const t of done.cleanedTiles) {
    const bytes = await client.asset(t.assetId, req.signal);
    const img = await deps.backend.decode(bytes, 'image/png');
    const tile = cleaned.tiles.find((x) => x.y === t.y);
    if (tile) tile.canvas.getContext('2d').drawImage(img.source, 0, 0);
    img.close?.();
  }
  const page: PageResult = { ...done.page, pipeline: { version: 1, hash: await pipelineHash(req.config), mode: 'engine' } };
  const context = req.context && done.contextUpdate ? mergeContext(req.context, done.contextUpdate) : req.context;
  req.onStage?.({ stage: 'done', progress: 1 });
  return { page, original, cleaned, context };
}
