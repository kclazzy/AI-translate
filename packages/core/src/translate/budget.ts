import { AppError } from '../errors';
import { tr } from '../i18n';
/**
 * Token budget of one request to a model with a fixed context window (Ollama's num_ctx).
 *
 * A request is the system prompt + the message (data sections, instruction) + pictures + the room
 * left for the answer. Ollama refuses a request whose input does not fit ("request (8285 tokens)
 * exceeds the available context size (8192 tokens)"), and an answer that does not fit is cut off.
 * Before sending, the request is measured with a rough, slightly pessimistic estimate and the
 * least important data is trimmed until it fits (see CONTEXT_LEVELS); the answer room is capped
 * to what is left. The window itself is never changed (that reloads the model).
 */

/** Rough token count of a text: CJK ≈ 1 token per character, Cyrillic ≈ 2.5 characters, Latin ≈ 3.5. Errs high. */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let cyr = 0;
  let other = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if ((c >= 0x3040 && c <= 0x30ff) || (c >= 0x3400 && c <= 0x9fff) || (c >= 0xac00 && c <= 0xd7af) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xff00 && c <= 0xffef)) cjk++;
    else if (c >= 0x0400 && c <= 0x04ff) cyr++;
    else other++;
  }
  return Math.ceil(cjk * 1.1 + cyr / 2.5 + other / 3.3) + 8;
}

/**
 * Tokens of one picture for the vision model. Qwen-style models: one token per patch² pixels
 * after merging (28 px for Qwen2.5-VL, 32 px for Qwen3-VL / Qwen3.5; 28 errs high for both).
 */
export function imageTokens(width: number, height: number, patch = 28): number {
  return Math.ceil(width / patch) * Math.ceil(height / patch) + 4;
}

/**
 * How much of the learned series context goes into a request, from the full set (0) to none.
 * Trimmed in order of importance: old names first, then the story so far, then recent lines.
 */
export interface ContextLevel {
  /** Names and terms: the ones on this page first, then the most recently learned. */
  names: number;
  /** Only names found in this page's text (or the recent lines) — never "recent" ones. */
  relevantOnly: boolean;
  summaries: number;
  lines: number;
  phrasebook: boolean;
}

export const CONTEXT_LEVELS: ContextLevel[] = [
  { names: 50, relevantOnly: false, summaries: 3, lines: 8, phrasebook: true },
  { names: 25, relevantOnly: false, summaries: 2, lines: 6, phrasebook: true },
  { names: 12, relevantOnly: true, summaries: 1, lines: 3, phrasebook: false },
  { names: 0, relevantOnly: true, summaries: 0, lines: 0, phrasebook: false },
];

/** Reading the text only (no translation): the names help spelling, the story does not. */
export const OCR_LEVEL: ContextLevel = { names: 25, relevantOnly: false, summaries: 0, lines: 0, phrasebook: false };

/** The part of the window kept free: the estimate is rough and the chat template adds tokens. */
export const SAFETY = 0.06;
/** The least room an answer gets; below it the request is trimmed (a page answer is rarely shorter). */
export const MIN_ANSWER = 1024;

export interface Fit {
  /** Index into CONTEXT_LEVELS. */
  level: number;
  /** Answer room that fits the window. */
  maxTokens: number;
  inputTokens: number;
}

/**
 * Choose the fullest context level whose request fits the window with `wantOut` answer room
 * (or at least MIN_ANSWER). `inputAt(level)` is the estimated input for that level.
 * Returns null when not even the smallest request fits — the caller reports CONTEXT_TOO_LONG.
 * No window (cloud models): the full level and the wanted room.
 */
export function fitRequest(numCtx: number | undefined, wantOut: number, inputAt: (level: number) => number, from = 0): Fit | null {
  if (!numCtx) return { level: from, maxTokens: wantOut, inputTokens: inputAt(from) };
  const usable = Math.floor(numCtx * (1 - SAFETY));
  // First the fullest level that leaves the wanted room, then the fullest that leaves the minimum.
  for (const need of [wantOut, Math.min(wantOut, MIN_ANSWER)]) {
    for (let level = from; level < CONTEXT_LEVELS.length; level++) {
      const input = inputAt(level);
      if (input + need <= usable) return { level, maxTokens: Math.min(wantOut, usable - input), inputTokens: input };
    }
  }
  return null;
}

/** Answer room for a retry after a cut-off answer: more, but never past the window. */
export function growRoom(numCtx: number | undefined, current: number, inputTokens: number, limit = 16384): number {
  const want = Math.min(limit, current * 2);
  if (!numCtx) return want;
  return Math.max(current, Math.min(want, Math.floor(numCtx * (1 - SAFETY)) - inputTokens));
}

/** Numbers from Ollama / llama.cpp "exceeds the available context size" errors, when present. */
export function parseContextError(msg: string): { prompt?: number; ctx?: number } | null {
  if (!/exceed[s_ ]+(the )?(available )?context|exceed_context_size|context (length|window|size) (exceeded|is too small)|n_ctx|prompt is too long|maximum context length/i.test(msg)) return null;
  const m = /\((\d+) tokens\)[^(]*\((\d+) tokens\)/.exec(msg);
  const p = /n_prompt_tokens["\s:=]+(\d+)/.exec(msg);
  const c = /n_ctx["\s:=]+(\d+)/.exec(msg);
  return { prompt: m ? +m[1] : p ? +p[1] : undefined, ctx: m ? +m[2] : c ? +c[1] : undefined };
}

/** The window of a provider whose context size we set (Ollama); undefined for the rest. */
export function windowOf(config: { preset?: string; baseUrl: string; numCtx?: number }): number | undefined {
  return config.preset === 'ollama' || /:11434(\/|$)/.test(config.baseUrl) ? config.numCtx ?? 8192 : undefined;
}

/**
 * Send one request that fits the window: `build(level, maxTokens)` makes the request for a
 * context level, `inputAt(level)` estimates its input. When the server still says the request is
 * too long (the estimate is rough), the context is trimmed further and the request sent once
 * more — never the same request twice, never more than one extra try.
 */
export async function completeFitted<R>(
  numCtx: number | undefined,
  wantOut: number,
  inputAt: (level: number) => number,
  send: (level: number, maxTokens: number) => Promise<R>,
  opts: { from?: number; onTrim?: (level: number, why: string) => void } = {},
): Promise<{ res: R; level: number; maxTokens: number; inputTokens: number }> {
  const fit = fitRequest(numCtx, wantOut, inputAt, opts.from ?? 0);
  if (!fit) throw tooLong(numCtx!, inputAt(CONTEXT_LEVELS.length - 1));
  if (fit.level > (opts.from ?? 0)) opts.onTrim?.(fit.level, `estimate ${inputAt(opts.from ?? 0)} tokens > window ${numCtx}`);
  try {
    return { res: await send(fit.level, fit.maxTokens), ...fit };
  } catch (e) {
    if (!(e instanceof AppError && e.code === 'CONTEXT_TOO_LONG') || !numCtx || fit.level >= CONTEXT_LEVELS.length - 1) throw e;
    // The estimate was low: aim at a smaller window, sized by the server's own numbers when given.
    const m = /\[(\d+)\/(\d+)\]/.exec(e.detail ?? '');
    const ratio = m ? Math.max(0.5, Math.min(0.9, +m[2] / +m[1] - 0.04)) : 0.85;
    const again = fitRequest(Math.floor(numCtx * ratio), wantOut, inputAt, fit.level + 1);
    if (!again) throw e;
    opts.onTrim?.(again.level, 'server: context too long');
    return { res: await send(again.level, again.maxTokens), ...again };
  }
}

function tooLong(numCtx: number, minimal: number): AppError {
  return new AppError('CONTEXT_TOO_LONG', {
    retryable: false,
    detail: tr('Даже без контекста серии запрос (~{0} токенов) не помещается в окно модели ({1}). Выберите качество «Быстро» или модель с большим окном.', minimal, numCtx),
  });
}
