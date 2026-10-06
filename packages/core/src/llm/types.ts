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
}

export interface LlmProvider {
  readonly config: ProviderConfig;
  complete(req: CompletionRequest): Promise<CompletionResult>;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
