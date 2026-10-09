import { tr } from './i18n';
/**
 * Errors carry a stable code so every client can show a human message
 * instead of "Internal server error".
 */
export type ErrorCode =
  | 'OCR_FAILED'
  | 'OUT_OF_MEMORY'
  | 'DETECTION_FAILED'
  | 'PROVIDER_UNAVAILABLE'
  | 'INVALID_API_KEY'
  | 'RATE_LIMITED'
  | 'IMAGE_TOO_LARGE'
  | 'UNSUPPORTED_FORMAT'
  | 'TRANSLATION_FAILED'
  | 'TRANSLATION_INVALID_OUTPUT'
  | 'IMAGE_FETCH_FAILED'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'PRIVACY_VIOLATION'
  | 'ENGINE_UNAVAILABLE'
  | 'ENGINE_UNAUTHORIZED'
  | 'NOT_CONFIGURED'
  | 'NO_TEXT_FOUND'
  | 'SETUP_NEEDED'
  | 'DISABLED'
  | 'UNKNOWN';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly detail?: string;

  constructor(code: ErrorCode, opts: { message?: string; retryable?: boolean; retryAfterMs?: number; detail?: string; cause?: unknown } = {}) {
    super(opts.message ?? code);
    this.name = 'AppError';
    this.code = code;
    this.retryable = opts.retryable ?? DEFAULT_RETRYABLE.has(code);
    this.retryAfterMs = opts.retryAfterMs;
    this.detail = opts.detail;
    if (opts.cause !== undefined) (this as { cause?: unknown }).cause = opts.cause;
  }

  toJSON(): SerializedError {
    return { code: this.code, message: this.message, retryable: this.retryable, retryAfterMs: this.retryAfterMs, detail: this.detail };
  }
}

export interface SerializedError {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
  detail?: string;
}

const DEFAULT_RETRYABLE = new Set<ErrorCode>(['PROVIDER_UNAVAILABLE', 'RATE_LIMITED', 'TIMEOUT', 'TRANSLATION_INVALID_OUTPUT', 'IMAGE_FETCH_FAILED', 'ENGINE_UNAVAILABLE']);

export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err && typeof err === 'object' && 'code' in err && typeof (err as SerializedError).code === 'string' && 'retryable' in err) {
    const e = err as SerializedError;
    return new AppError(e.code, { message: e.message, retryable: e.retryable, retryAfterMs: e.retryAfterMs, detail: e.detail });
  }
  if (err instanceof DOMException && err.name === 'AbortError') return new AppError('CANCELLED');
  if (err instanceof Error && err.name === 'AbortError') return new AppError('CANCELLED');
  if (err instanceof Error && err.name === 'TimeoutError') return new AppError('TIMEOUT');
  const message = err instanceof Error ? err.message : String(err);
  return new AppError('UNKNOWN', { message, retryable: false });
}

type Lang = 'ru' | 'en';

const MESSAGES: Record<ErrorCode, Record<Lang, string>> = {
  OUT_OF_MEMORY: { ru: 'Модели не хватило видеопамяти.', en: 'The model ran out of video memory.' },
  OCR_FAILED: { ru: 'Не удалось распознать текст. Попробовать ещё раз?', en: 'Could not recognise the text. Try again?' },
  DETECTION_FAILED: { ru: 'Не удалось найти текст на изображении.', en: 'Could not find text in the image.' },
  PROVIDER_UNAVAILABLE: { ru: 'Сервис перевода сейчас недоступен. Попробовать ещё раз?', en: 'The translation service is unavailable. Try again?' },
  INVALID_API_KEY: { ru: 'Ключ API не подошёл. Проверьте его в настройках.', en: 'The API key was rejected. Check it in Settings.' },
  RATE_LIMITED: { ru: 'Слишком много запросов к модели. Подождите немного.', en: 'Too many requests to the model. Wait a moment.' },
  IMAGE_TOO_LARGE: { ru: 'Изображение слишком большое для обработки.', en: 'The image is too large to process.' },
  UNSUPPORTED_FORMAT: { ru: 'Этот формат файла не поддерживается.', en: 'This file format is not supported.' },
  TRANSLATION_FAILED: { ru: 'Не удалось перевести текст. Попробовать ещё раз?', en: 'Translation failed. Try again?' },
  TRANSLATION_INVALID_OUTPUT: { ru: 'Модель вернула некорректный ответ. Попробовать ещё раз?', en: 'The model returned an invalid answer. Try again?' },
  IMAGE_FETCH_FAILED: { ru: 'Не удалось получить изображение со страницы.', en: 'Could not fetch the image from the page.' },
  TIMEOUT: { ru: 'Модель отвечает слишком долго. Попробовать ещё раз?', en: 'The model took too long. Try again?' },
  CANCELLED: { ru: 'Отменено.', en: 'Cancelled.' },
  PRIVACY_VIOLATION: { ru: 'Включён локальный режим: этот провайдер отправил бы данные наружу.', en: 'Local mode is on: this provider would send data outside your device.' },
  ENGINE_UNAVAILABLE: { ru: 'Локальный движок не отвечает. Он запущен?', en: 'The local engine is not responding. Is it running?' },
  ENGINE_UNAUTHORIZED: { ru: 'Движок отклонил токен. Введите код сопряжения в настройках.', en: 'The engine rejected the token. Enter the pairing code in Settings.' },
  NOT_CONFIGURED: { ru: 'Не выбран провайдер перевода. Откройте настройки.', en: 'No translation provider is set up. Open Settings.' },
  NO_TEXT_FOUND: { ru: 'Текст на изображении не найден.', en: 'No text was found in the image.' },
  SETUP_NEEDED: { ru: 'Для перевода на этом компьютере не хватает программы.', en: 'A program needed for local translation is missing.' },
  DISABLED: { ru: 'AI Translate выключен.', en: 'AI Translate is switched off.' },
  UNKNOWN: { ru: 'Что-то пошло не так. Попробовать ещё раз?', en: 'Something went wrong. Try again?' },
};

export function errorMessage(err: unknown, lang?: string): string {
  const e = toAppError(err);
  // Russian is the source text; tr() gives the current interface language.
  return lang === 'en' ? MESSAGES[e.code].en : tr(MESSAGES[e.code].ru);
}
