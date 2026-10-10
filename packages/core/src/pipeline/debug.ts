import type { LlmProvider } from '../llm/types';
import type { PageDebug } from '../types';

/**
 * What the model said for one page and what the pipeline did with it («Сообщить о проблеме со
 * страницей»). Stored with the result on this device only; never in the cache key. Only the
 * answer text is kept: no requests, headers or keys.
 */
export const DEBUG_LIMITS = { answers: 8, answerChars: 20_000, steps: 60, modelBlocks: 200 };

export type DebugStage = PageDebug['answers'][number]['stage'];

export function createDebug(): PageDebug {
  return { answers: [], modelBlocks: [], steps: [] };
}

/** Anything that looks like a secret is cut out of a model answer (an echoed key, a bearer token). */
export function scrubSecrets(text: string, secrets: (string | undefined)[] = []): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 6) out = out.split(s).join('***');
  return out
    .replace(/\b(sk|pk|rk)-[A-Za-z0-9_-]{12,}/g, '***')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, 'Bearer ***')
    .replace(/(\/\/)[^/\s:@]+:[^/\s@]+@/g, '$1***@');
}

export function addAnswer(debug: PageDebug | undefined, stage: DebugStage, model: string, text: string, kind?: string, secrets?: (string | undefined)[]): void {
  if (!debug || debug.answers.length >= DEBUG_LIMITS.answers) return;
  const clean = scrubSecrets(text, secrets);
  const cut = clean.length > DEBUG_LIMITS.answerChars;
  debug.answers.push({ stage, model, ...(kind ? { kind } : {}), text: cut ? `${clean.slice(0, DEBUG_LIMITS.answerChars)}…[cut]` : clean });
}

export function addStep(debug: PageDebug | undefined, step: string): void {
  if (!debug) return;
  debug.steps ??= [];
  if (debug.steps.length < DEBUG_LIMITS.steps) debug.steps.push(step);
}

/** The same provider, keeping every answer's text in `debug` (under `stage`). */
export function recording(provider: LlmProvider, stage: DebugStage, debug: PageDebug | undefined, kind?: string): LlmProvider {
  if (!debug) return provider;
  return {
    config: provider.config,
    async complete(req) {
      const res = await provider.complete(req);
      addAnswer(debug, stage, res.model || provider.config.model, res.text, kind ?? (req.messages.some((m) => Array.isArray(m.content) && m.content.some((c) => c.type === 'image')) ? 'vision' : 'text'), [provider.config.apiKey]);
      return res;
    },
  };
}
