export type ProviderKind = 'openai-compatible' | 'anthropic';

/** User-facing provider configuration (stored in settings; apiKey stored encrypted by the app). */
export interface ProviderConfig {
  id: string;
  label: string;
  kind: ProviderKind;
  /** Preset this config was created from, e.g. 'lmstudio', 'ollama', 'openai'. */
  preset: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
  /** Whether the model accepts images. */
  vision: boolean;
  /** JSON output mode the endpoint supports. */
  jsonMode: 'json_object' | 'none';
  /** USD per 1M tokens, used for the cost estimate in the debug panel. */
  priceInput?: number;
  priceOutput?: number;
  timeoutMs?: number;
  maxOutputTokens?: number;
  temperature?: number;
  /** Ask reasoning models (Qwen3, R1…) to answer without a long thinking phase. Default: on for local servers. */
  noThinking?: boolean;
  /** Ollama: minutes to keep the model in video memory after a request (set from settings). */
  keepAliveMin?: number;
  /** Ollama: context window (tokens). Bigger needs more video memory. */
  numCtx?: number;
  /** Ollama: never change num_ctx between requests (changing it reloads the model). Always true now; kept for settings. */
  fixedCtx?: boolean;
}

export type ContentPart = { type: 'text'; text: string } | { type: 'image'; mime: string; base64: string };

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string | ContentPart[];
}

export interface CompletionRequest {
  system: string;
  messages: ChatMessage[];
  json?: boolean;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

export interface CompletionResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  model: string;
  /** Generation speed reported by the server (Ollama), tokens per second. */
  tokensPerSecond?: number;
  /** The answer hit the output limit (finish_reason "length", stop_reason "max_tokens"): it is cut off. */
  truncated?: boolean;
  /**
   * Prompt tokens served from the provider's prompt cache (Anthropic cache_read_input_tokens,
   * OpenAI prompt_tokens_details.cached_tokens). Already included in inputTokens; billed at ~10% of the input price.
   */
  cachedInputTokens?: number;
  /** Prompt tokens written to the cache (Anthropic cache_creation_input_tokens). Already included in inputTokens; billed at 125%. */
  cacheWriteTokens?: number;
}

export interface LlmProvider {
  readonly config: ProviderConfig;
  complete(req: CompletionRequest): Promise<CompletionResult>;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
