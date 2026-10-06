import { AppError } from '../errors';
import { timeoutSignal } from '../util/retry';
import { httpError, joinUrl, safeFetch } from './http';
import type { CompletionRequest, CompletionResult, ContentPart, FetchLike, LlmProvider, ProviderConfig } from './types';

/**
 * One provider for every OpenAI-compatible Chat Completions endpoint:
 * OpenAI, LM Studio, Ollama, DeepSeek, OpenRouter, Gemini (OpenAI endpoint), vLLM, custom servers.
 */
export class OpenAICompatibleProvider implements LlmProvider {
  constructor(readonly config: ProviderConfig, private fetchImpl: FetchLike = (u, i) => fetch(u, i)) {}

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const messages: unknown[] = [{ role: 'system', content: req.system }];
    for (const m of req.messages) {
      messages.push({ role: m.role, content: typeof m.content === 'string' ? m.content : m.content.map(toOpenAiPart) });
    }
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages,
      temperature: req.temperature ?? this.config.temperature ?? 0.2,
      max_tokens: req.maxTokens ?? this.config.maxOutputTokens ?? 4096,
      stream: false,
    };
    if (req.json && this.config.jsonMode === 'json_object') body.response_format = { type: 'json_object' };

    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.config.apiKey) headers.authorization = `Bearer ${this.config.apiKey}`;
    if (this.config.preset === 'openrouter') {
      headers['HTTP-Referer'] = 'https://github.com/kclazzy/ai-translate';
      headers['X-Title'] = 'AI Translate';
    }

    const { signal, dispose } = timeoutSignal(this.config.timeoutMs ?? 120_000, req.signal);
    try {
      const res = await safeFetch(this.fetchImpl, joinUrl(this.config.baseUrl, 'chat/completions'), { method: 'POST', headers, body: JSON.stringify(body), signal }, this.config.label);
      if (!res.ok) throw await httpError(res, this.config.label);
      const json = (await res.json()) as {
        choices?: { message?: { content?: string | { type: string; text?: string }[] } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
        model?: string;
      };
      const content = json.choices?.[0]?.message?.content;
      const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((p) => p.text ?? '').join('') : '';
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
  if (!res.ok) throw await httpError(res, baseUrl);
  const json = (await res.json()) as { data?: { id: string }[] };
  return (json.data ?? []).map((m) => m.id);
}
