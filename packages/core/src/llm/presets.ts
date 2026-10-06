import type { ProviderConfig } from './types';
import { AnthropicProvider } from './anthropic';
import { OpenAICompatibleProvider } from './openai';
import type { FetchLike, LlmProvider } from './types';

export interface ProviderPreset {
  preset: string;
  label: string;
  kind: ProviderConfig['kind'];
  baseUrl: string;
  model: string;
  vision: boolean;
  jsonMode: ProviderConfig['jsonMode'];
  needsKey: boolean;
  local: boolean;
  priceInput?: number;
  priceOutput?: number;
  hint: string;
}

/**
 * Starting points shown in Settings. Model names are defaults the user can change;
 * check each provider's model list for what is current.
 */
export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    preset: 'lmstudio',
    label: 'LM Studio (локально)',
    kind: 'openai-compatible',
    baseUrl: 'http://localhost:1234/v1',
    model: 'qwen3-14b',
    vision: false,
    jsonMode: 'none',
    needsKey: false,
    local: true,
    hint: 'Запустите сервер в LM Studio (Developer → Start Server) и включите CORS.',
  },
  {
    preset: 'ollama',
    label: 'Ollama (локально)',
    kind: 'openai-compatible',
    baseUrl: 'http://localhost:11434/v1',
    model: 'qwen3.5:9b-q4_K_M',
    vision: true,
    jsonMode: 'json_object',
    needsKey: false,
    local: true,
    hint: 'Модель для чтения картинок можно скачать прямо из настроек — подберём её под вашу видеокарту.',
  },
  {
    preset: 'anthropic',
    label: 'Anthropic Claude',
    kind: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    model: 'claude-haiku-4-5-20251001',
    vision: true,
    jsonMode: 'none',
    needsKey: true,
    local: false,
    priceInput: 1,
    priceOutput: 5,
    hint: 'Ключ: console.anthropic.com. Для лучшего качества выберите claude-sonnet-5-5.',
  },
  {
    preset: 'openai',
    label: 'OpenAI',
    kind: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4.1-mini',
    vision: true,
    jsonMode: 'json_object',
    needsKey: true,
    local: false,
    hint: 'Ключ: platform.openai.com.',
  },
  {
    preset: 'gemini',
    label: 'Google Gemini',
    kind: 'openai-compatible',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-2.5-flash',
    vision: true,
    jsonMode: 'json_object',
    needsKey: true,
    local: false,
    hint: 'Ключ: aistudio.google.com. Используется OpenAI-совместимый endpoint Gemini.',
  },
  {
    preset: 'deepseek',
    label: 'DeepSeek',
    kind: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    vision: false,
    jsonMode: 'json_object',
    needsKey: true,
    local: false,
    hint: 'Только текст: для распознавания нужен vision-провайдер или движок.',
  },
  {
    preset: 'openrouter',
    label: 'OpenRouter',
    kind: 'openai-compatible',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'google/gemini-2.5-flash',
    vision: true,
    jsonMode: 'json_object',
    needsKey: true,
    local: false,
    hint: 'Ключ: openrouter.ai. Доступ к сотням моделей одним ключом.',
  },
  {
    preset: 'custom',
    label: 'Свой endpoint (OpenAI-совместимый)',
    kind: 'openai-compatible',
    baseUrl: 'http://localhost:8000/v1',
    model: 'model',
    vision: false,
    jsonMode: 'none',
    needsKey: false,
    local: true,
    hint: 'Любой сервер с /v1/chat/completions: vLLM, llama.cpp server, text-generation-webui.',
  },
];

export function configFromPreset(preset: string, id?: string): ProviderConfig {
  const p = PROVIDER_PRESETS.find((x) => x.preset === preset) ?? PROVIDER_PRESETS[0];
  return {
    id: id ?? `${p.preset}-${Math.random().toString(36).slice(2, 8)}`,
    label: p.label,
    kind: p.kind,
    preset: p.preset,
    baseUrl: p.baseUrl,
    model: p.model,
    vision: p.vision,
    jsonMode: p.jsonMode,
    priceInput: p.priceInput,
    priceOutput: p.priceOutput,
  };
}

export function createProvider(config: ProviderConfig, fetchImpl?: FetchLike): LlmProvider {
  if (config.kind === 'anthropic') return new AnthropicProvider(config, fetchImpl);
  return new OpenAICompatibleProvider(config, fetchImpl);
}

export function estimateCost(config: ProviderConfig, inputTokens: number, outputTokens: number): number {
  return ((config.priceInput ?? 0) * inputTokens + (config.priceOutput ?? 0) * outputTokens) / 1_000_000;
}
