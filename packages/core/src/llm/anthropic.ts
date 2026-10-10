import { AppError } from '../errors';
import { timeoutSignal } from '../util/retry';
import { httpError, joinUrl, safeFetch } from './http';
import type { CompletionRequest, CompletionResult, ContentPart, FetchLike, LlmProvider, ProviderConfig } from './types';

/** Native Anthropic Messages API provider (Claude). */
export class AnthropicProvider implements LlmProvider {
  constructor(readonly config: ProviderConfig, private fetchImpl: FetchLike = (u, i) => fetch(u, i)) {}

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    if (!this.config.apiKey) throw new AppError('INVALID_API_KEY', { detail: 'Anthropic API key is empty', retryable: false });
    const messages = req.messages.map((m) => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : m.content.map(toAnthropicPart),
    }));
    // Prefilling "{" keeps Claude in JSON mode without a schema.
    if (req.json) messages.push({ role: 'assistant', content: '{' });
    const body = {
      model: this.config.model,
      system: req.system,
      messages,
      max_tokens: req.maxTokens ?? this.config.maxOutputTokens ?? 4096,
      temperature: req.temperature ?? this.config.temperature ?? 0.2,
    };
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-api-key': this.config.apiKey,
      'anthropic-version': '2023-06-01',
      // Required when calling the API directly from a browser or extension (BYOK).
      'anthropic-dangerous-direct-browser-access': 'true',
    };
    const { signal, dispose } = timeoutSignal(this.config.timeoutMs ?? 120_000, req.signal);
    try {
      const res = await safeFetch(this.fetchImpl, joinUrl(this.config.baseUrl || 'https://api.anthropic.com/v1', 'messages'), { method: 'POST', headers, body: JSON.stringify(body), signal }, this.config.label);
      if (!res.ok) throw await httpError(res, this.config.label, this.config.baseUrl, this.config.model);
      const json = (await res.json()) as { content?: { type: string; text?: string }[]; usage?: { input_tokens?: number; output_tokens?: number }; model?: string; stop_reason?: string };
      let text = (json.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
      if (req.json) text = '{' + text;
      if (!text.trim()) throw new AppError('TRANSLATION_INVALID_OUTPUT', { detail: 'Empty completion' });
      return { text, inputTokens: json.usage?.input_tokens ?? 0, outputTokens: json.usage?.output_tokens ?? 0, model: json.model ?? this.config.model, ...(json.stop_reason === 'max_tokens' ? { truncated: true } : {}) };
    } finally {
      dispose();
    }
  }
}

function toAnthropicPart(p: ContentPart): unknown {
  if (p.type === 'text') return { type: 'text', text: p.text };
  return { type: 'image', source: { type: 'base64', media_type: p.mime, data: p.base64 } };
}
