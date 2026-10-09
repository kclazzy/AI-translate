import { AppError } from '../errors';
import { timeoutSignal } from '../util/retry';
import { httpError, joinUrl, safeFetch } from './http';
import { isLocalUrl } from './privacy';
import type { CompletionRequest, CompletionResult, ContentPart, FetchLike, LlmProvider, ProviderConfig } from './types';
import { tr } from '../i18n';

/**
 * One provider for every OpenAI-compatible Chat Completions endpoint:
 * OpenAI, LM Studio, Ollama, DeepSeek, OpenRouter, Gemini (OpenAI endpoint), vLLM, custom servers.
 */
export class OpenAICompatibleProvider implements LlmProvider {
  constructor(readonly config: ProviderConfig, private fetchImpl: FetchLike = (u, i) => fetch(u, i)) {}

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    if (isOllama(this.config)) return this.completeOllama(req);
    const local = isLocalUrl(this.config.baseUrl);
    const noThinking = this.config.noThinking ?? local;
    const messages: { role: string; content: unknown }[] = [{ role: 'system', content: req.system }];
    for (const m of req.messages) {
      messages.push({ role: m.role, content: typeof m.content === 'string' ? m.content : m.content.map(toOpenAiPart) });
    }
    if (noThinking) {
      // Qwen3-style soft switch; harmless for models that do not know it.
      const last = [...messages].reverse().find((m) => m.role === 'user');
      if (last) {
        if (typeof last.content === 'string') last.content = `${last.content}\n/no_think`;
        else if (Array.isArray(last.content)) (last.content as unknown[]).push({ type: 'text', text: '/no_think' });
      }
    }
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages,
      temperature: req.temperature ?? this.config.temperature ?? 0.2,
      max_tokens: req.maxTokens ?? this.config.maxOutputTokens ?? 4096,
      stream: false,
    };
    if (req.json && this.config.jsonMode === 'json_object') body.response_format = { type: 'json_object' };
    // llama.cpp server, vLLM and LM Studio read chat-template switches; cloud APIs may reject unknown fields.
    if (noThinking && local) body.chat_template_kwargs = { enable_thinking: false };

    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.config.apiKey) headers.authorization = `Bearer ${this.config.apiKey}`;
    if (this.config.preset === 'openrouter') {
      headers['HTTP-Referer'] = 'https://github.com/kclazzy/ai-translate';
      headers['X-Title'] = 'AI Translate';
    }

    // Large local models (e.g. 27B partly in system RAM) can need minutes for one page.
    const { signal, dispose } = timeoutSignal(this.config.timeoutMs ?? (local ? 600_000 : 120_000), req.signal);
    try {
      const res = await safeFetch(this.fetchImpl, joinUrl(this.config.baseUrl, 'chat/completions'), { method: 'POST', headers, body: JSON.stringify(body), signal }, this.config.label);
      if (!res.ok) throw await httpError(res, this.config.label, this.config.baseUrl, this.config.model);
      const json = (await res.json()) as {
        choices?: { message?: { content?: string | { type: string; text?: string }[] } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
        model?: string;
      };
      const content = json.choices?.[0]?.message?.content;
      const text = stripThinking(typeof content === 'string' ? content : Array.isArray(content) ? content.map((p) => p.text ?? '').join('') : '');
      if (!text) throw new AppError('TRANSLATION_INVALID_OUTPUT', { detail: 'Empty completion' });
      return {
        text,
        inputTokens: json.usage?.prompt_tokens ?? 0,
        outputTokens: json.usage?.completion_tokens ?? 0,
        model: json.model ?? this.config.model,
      };
    } finally {
      dispose();
    }
  }

  /**
   * Ollama's native /api/chat: the only reliable way to switch thinking off for Qwen3.5
   * (a thinking model would otherwise "think" for minutes per page) and to raise the
   * context window, which defaults to 4096 tokens and is too small for a page plus prompt.
   */
  private async completeOllama(req: CompletionRequest): Promise<CompletionResult> {
    const noThinking = this.config.noThinking ?? true;
    const messages: { role: string; content: string; images?: string[] }[] = [{ role: 'system', content: req.system }];
    for (const m of req.messages) {
      if (typeof m.content === 'string') messages.push({ role: m.role, content: m.content });
      else {
        const images = m.content.filter((p) => p.type === 'image').map((p) => (p as { base64: string }).base64);
        const text = m.content.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('\n');
        messages.push({ role: m.role, content: text, ...(images.length ? { images } : {}) });
      }
    }
    const maxTokens = req.maxTokens ?? this.config.maxOutputTokens ?? 4096;
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages,
      stream: false,
      think: !noThinking,
      // How long the model stays in video memory after this page (0 = unload now).
      keep_alive: this.config.keepAliveMin === undefined ? '5m' : this.config.keepAliveMin <= 0 ? 0 : `${this.config.keepAliveMin}m`,
      // 8k tokens hold a page picture, the prompt and the answer; 16k only with plenty of video memory.
      options: { temperature: req.temperature ?? this.config.temperature ?? 0.2, num_predict: maxTokens, num_ctx: this.config.numCtx ?? 8192 },
    };
    if (req.json) body.format = 'json';
    const { signal, dispose } = timeoutSignal(this.config.timeoutMs ?? 600_000, req.signal);
    try {
      const ask = async () => {
        const res = await safeFetch(this.fetchImpl, ollamaUrl(this.config.baseUrl, 'api/chat'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal }, this.config.label);
        if (!res.ok) throw await httpError(res, this.config.label, this.config.baseUrl, this.config.model);
        return (await res.json()) as { message?: { content?: string }; prompt_eval_count?: number; eval_count?: number; eval_duration?: number; model?: string; done_reason?: string };
      };
      let json = await ask();
      // The picture and the prompt filled the context window, so the answer was cut off mid-way:
      // ask once more with a window twice as large (the memory fallback handles a card that is too small).
      const opts = body.options as { num_ctx: number; num_predict: number };
      if (json.done_reason === 'length' && (json.eval_count ?? 0) < opts.num_predict * 0.9 && opts.num_ctx < 32768) {
        opts.num_ctx *= 2;
        json = await ask();
      }
      const text = stripThinking(json.message?.content ?? '');
      if (!text) throw new AppError('TRANSLATION_INVALID_OUTPUT', { detail: tr('Модель вернула пустой ответ') });
      const tps = json.eval_count && json.eval_duration ? json.eval_count / (json.eval_duration / 1e9) : undefined;
      return { text, inputTokens: json.prompt_eval_count ?? 0, outputTokens: json.eval_count ?? 0, model: json.model ?? this.config.model, tokensPerSecond: tps };
    } finally {
      dispose();
    }
  }
}

export function isOllama(cfg: Pick<ProviderConfig, 'preset' | 'baseUrl'>): boolean {
  return cfg.preset === 'ollama' || /:11434(\/|$)/.test(cfg.baseUrl);
}

/** Ollama's native API lives next to its OpenAI-compatible /v1. */
export function ollamaUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')}/${path}`;
}

/** Remove <think>…</think> reasoning that some local models put in the answer. */
export function stripThinking(text: string): string {
  let out = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
  // Unclosed thinking (answer cut off) or answer after a bare </think>.
  const close = out.lastIndexOf('</think>');
  if (close >= 0) out = out.slice(close + 8);
  const open = out.indexOf('<think>');
  if (open >= 0) out = out.slice(0, open);
  return out.trim();
}

function toOpenAiPart(p: ContentPart): unknown {
  if (p.type === 'text') return { type: 'text', text: p.text };
  return { type: 'image_url', image_url: { url: `data:${p.mime};base64,${p.base64}` } };
}

/** List models exposed by an OpenAI-compatible endpoint (used by Settings "Test"). */
export async function listOpenAiModels(baseUrl: string, apiKey: string | undefined, fetchImpl: FetchLike = (u, i) => fetch(u, i), signal?: AbortSignal): Promise<string[]> {
  const headers: Record<string, string> = {};
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const res = await safeFetch(fetchImpl, joinUrl(baseUrl, 'models'), { headers, signal }, baseUrl);
  if (!res.ok) throw await httpError(res, baseUrl, baseUrl);
  const json = (await res.json()) as { data?: { id: string }[] };
  return (json.data ?? []).map((m) => m.id);
}
