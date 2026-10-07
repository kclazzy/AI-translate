import type { ProviderConfig } from './types';
import { AnthropicProvider } from './anthropic';
import { OpenAICompatibleProvider } from './openai';
import type { FetchLike, LlmProvider } from './types';
import { N_ } from '../i18n';

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
  /** Step-by-step: where to get the key and which model to pick (shown in Settings). */
  guide?: ProviderGuide;
}

export interface ProviderGuide {
  /** Page where the key is created. */
  keyUrl?: string;
  steps: string[];
  /** Which model to pick and why. */
  models?: string;
  /** Payment / free tier. */
  cost?: string;
  /** Anything that commonly goes wrong. */
  note?: string;
}

const FINISH = N_('Вставьте ключ в поле «Ключ API» → «Сохранить» → «Проверить подключение». Затем нажмите «Использовать для перевода» (или выберите модель в блоке «Модели»).');

const GUIDES: Record<string, ProviderGuide> = {
  lmstudio: {
    keyUrl: 'https://lmstudio.ai/download',
    steps: [N_('Установите LM Studio и скачайте в нём модель, которая понимает картинки (значок «Vision»), например Qwen3.5 VL.'), N_('Вкладка Developer → Start Server; в настройках сервера включите «Enable CORS».'), N_('Ключ не нужен. Нажмите «Проверить подключение» и выберите модель кнопкой ⟳.')],
    cost: N_('Бесплатно, всё работает на вашем компьютере.'),
  },
  ollama: {
    keyUrl: 'https://ollama.com/download',
    steps: [N_('Установите Ollama и запустите её.'), N_('Выше, в «Локальные модели», нажмите «Скачать» у модели, подобранной под вашу видеокарту.'), N_('Ключ не нужен.')],
    cost: N_('Бесплатно, всё работает на вашем компьютере.'),
  },
  anthropic: {
    keyUrl: 'https://platform.claude.com/settings/keys',
    steps: [N_('Зарегистрируйтесь в Claude Console (platform.claude.com) и пополните баланс в разделе Billing.'), N_('Settings → API keys → Create Key. Ключ начинается с «sk-ant-»; он показывается один раз — скопируйте его сразу.'), FINISH],
    models: N_('claude-haiku-4-5 — быстро и недорого; claude-sonnet-5-5 — лучше качество. Обе читают картинки.'),
    cost: N_('Платно, по предоплате; цена за страницу — доли цента.'),
    note: N_('Сервис доступен не во всех странах; нужна банковская карта, которую он принимает.'),
  },
  openai: {
    keyUrl: 'https://platform.openai.com/api-keys',
    steps: [N_('Войдите на platform.openai.com и пополните баланс (Settings → Billing). Подписка ChatGPT Plus для API не подходит.'), N_('API keys → Create new secret key. Ключ начинается с «sk-»; скопируйте его сразу.'), FINISH],
    models: N_('Нажмите ⟳ и выберите модель, которая понимает картинки; «mini» — дешевле и быстрее.'),
    cost: N_('Платно, по предоплате.'),
    note: N_('Сервис доступен не во всех странах.'),
  },
  gemini: {
    keyUrl: 'https://aistudio.google.com/apikey',
    steps: [N_('Откройте Google AI Studio (aistudio.google.com) и войдите в аккаунт Google.'), N_('Get API key → Create API key. Ключ начинается с «AIza».'), FINISH],
    models: N_('Модели «flash» — быстрые и хорошо читают картинки; «pro» — точнее, но медленнее.'),
    cost: N_('Есть бесплатный лимит запросов в день — хватит, чтобы попробовать; дальше — оплата в Google Cloud.'),
    note: N_('Сервис доступен не во всех странах; бесплатные запросы Google может использовать для улучшения своих моделей.'),
  },
  deepseek: {
    keyUrl: 'https://platform.deepseek.com/api_keys',
    steps: [N_('Зарегистрируйтесь на platform.deepseek.com и пополните баланс (Top up).'), N_('API keys → Create new API key; скопируйте ключ сразу.'), N_('Вставьте ключ → «Сохранить» → «Проверить подключение».'), N_('DeepSeek не видит картинки: в блоке «Модели» оставьте в «Читает изображение» локальную или другую модель, а DeepSeek выберите в «Переводит текст».')],
    models: N_('deepseek-chat — для перевода.'),
    cost: N_('Платно, один из самых дешёвых вариантов.'),
  },
  openrouter: {
    keyUrl: 'https://openrouter.ai/settings/keys',
    steps: [N_('Войдите на openrouter.ai (Google, GitHub или почта).'), N_('Settings → Keys → Create Key; ключ начинается с «sk-or-».'), N_('Пополните Credits (карта или криптовалюта) — либо берите бесплатные модели с пометкой «:free» (с лимитами).'), FINISH],
    models: N_('Один ключ — сотни моделей. Нажмите ⟳ и выберите модель с поддержкой изображений, например google/gemini-…-flash.'),
    cost: N_('Цены как у самих провайдеров плюс небольшая комиссия; есть бесплатные модели.'),
    note: N_('Удобный вариант, если напрямую сервисы недоступны или не принимают вашу карту.'),
  },
  custom: {
    steps: [N_('Укажите адрес сервера, который понимает /v1/chat/completions (vLLM, llama.cpp server, text-generation-webui и т. п.), например http://192.168.1.10:8000/v1.'), N_('Ключ — только если сервер его требует.'), N_('Нажмите ⟳, чтобы получить список моделей, и включите «Модель понимает изображения», если это так.')],
  },
};


/**
 * Starting points shown in Settings. Model names are defaults the user can change;
 * check each provider's model list for what is current.
 */
export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    preset: 'lmstudio',
    label: N_('LM Studio (локально)'),
    kind: 'openai-compatible',
    baseUrl: 'http://localhost:1234/v1',
    model: 'qwen3-14b',
    vision: false,
    jsonMode: 'none',
    needsKey: false,
    local: true,
    hint: N_('Запустите сервер в LM Studio (Developer → Start Server) и включите CORS.'),
  },
  {
    preset: 'ollama',
    label: N_('Ollama (локально)'),
    kind: 'openai-compatible',
    baseUrl: 'http://localhost:11434/v1',
    model: 'qwen3.5:9b-q4_K_M',
    vision: true,
    jsonMode: 'json_object',
    needsKey: false,
    local: true,
    hint: N_('Модель для чтения картинок можно скачать прямо из настроек — подберём её под вашу видеокарту.'),
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
    hint: N_('Claude: читает картинки и хорошо переводит.'),
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
    hint: N_('OpenAI GPT: читает картинки.'),
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
    hint: N_('Google Gemini: читает картинки, есть бесплатный лимит.'),
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
    hint: N_('Только текст: для распознавания нужен vision-провайдер или движок.'),
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
    hint: N_('Сотни моделей одним ключом, есть бесплатные.'),
  },
  {
    preset: 'custom',
    label: N_('Свой endpoint (OpenAI-совместимый)'),
    kind: 'openai-compatible',
    baseUrl: 'http://localhost:8000/v1',
    model: 'model',
    vision: false,
    jsonMode: 'none',
    needsKey: false,
    local: true,
    hint: N_('Любой сервер с /v1/chat/completions: vLLM, llama.cpp server, text-generation-webui.'),
  },
];

for (const p of PROVIDER_PRESETS) p.guide ??= GUIDES[p.preset];

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
