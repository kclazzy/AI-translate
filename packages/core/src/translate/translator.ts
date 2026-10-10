import { AppError } from '../errors';
import { estimateCost } from '../llm/presets';
import type { ChatMessage, CompletionResult, LlmProvider } from '../llm/types';
import type { TextType, Usage } from '../types';
import { withRetry } from '../util/retry';
import { applyForbiddenFixes, findGlossaryHits, findViolations, type GlossaryHit } from './glossary';
import { isDegenerate, parseTranslationAnswer, tameRuns } from './parse';
import { buildSystemPrompt, contextData, glossaryExtra, phrasebookData, repairInstruction, textTranslateInstruction, type BlockForTranslation, type PromptInput } from './prompt';

export interface TranslateBlocksResult {
  /** lowConfidence: the translation came from an answer that was cut off or had to be mended. */
  translations: Map<string, { text: string; type?: TextType; lowConfidence?: boolean }>;
  entities: unknown[];
  summary: string;
  usage: Usage[];
}

/** Tokens and price of one answer (prompt-cache reads and writes priced apart, see estimateCost). */
export function usageFrom(provider: LlmProvider, res: Pick<CompletionResult, 'model' | 'inputTokens' | 'outputTokens' | 'cachedInputTokens' | 'cacheWriteTokens'>): Usage {
  const cached = res.cachedInputTokens ?? 0;
  return {
    provider: provider.config.label,
    model: res.model,
    inputTokens: res.inputTokens,
    outputTokens: res.outputTokens,
    costUsd: estimateCost(provider.config, res.inputTokens, res.outputTokens, cached, res.cacheWriteTokens ?? 0),
    ...(cached > 0 ? { cachedTokens: cached } : {}),
  };
}

/**
 * Translate one page worth of recognised blocks in a single request,
 * validate the answer and run one repair round for glossary violations.
 */
export async function translateBlocks(
  provider: LlmProvider,
  input: PromptInput,
  blocks: BlockForTranslation[],
  opts: { signal?: AbortSignal; retries?: number } = {},
): Promise<TranslateBlocksResult> {
  if (!blocks.length) return { translations: new Map(), entities: [], summary: '', usage: [] };
  const hitsByBlock = new Map<string, GlossaryHit[]>();
  const allHits = new Map<string, GlossaryHit>();
  for (const b of blocks) {
    const hits = findGlossaryHits(b.text, input.glossary);
    hitsByBlock.set(b.id, hits);
    for (const h of hits) allHits.set(h.entry.id, h);
  }
  const hintStrings: Record<string, string[]> = {};
  for (const [id, hits] of hitsByBlock) hintStrings[id] = hits.map((h) => `${h.entry.source} → ${h.entry.target}`);

  // Same system prompt for every page (cacheable prefix); this page's terms go into the message.
  const system = buildSystemPrompt(input);
  const user = textTranslateInstruction(blocks, hintStrings, contextData(input), phrasebookData(input, blocks), glossaryExtra(input, [...allHits.values()]));
  const usage: Usage[] = [];

  const retries = opts.retries ?? 2;
  // After an answer cut off at the output limit, the next try gets twice the room.
  let room = Math.min(8192, 400 + blocks.length * 160);
  return withRetry(
    async (attempt) => {
      const last = attempt >= retries;
      const messages: ChatMessage[] = [{ role: 'user', content: user }];
      const first = await provider.complete({ system, messages, json: true, signal: opts.signal, maxTokens: room });
      usage.push(usageFrom(provider, first));
      if (first.truncated && !last) {
        room = Math.min(16384, room * 2);
        throw new AppError('TRANSLATION_INVALID_OUTPUT', { retryable: true, detail: 'Answer cut off at the output limit' });
      }
      let answer = parseTranslationAnswer(first.text, blocks, last);
      // Ids whose translation comes from a cut-off or mended answer.
      const low = new Set<string>(answer.repaired || first.truncated ? answer.translations.keys() : []);
      const sources = new Map(blocks.map((b) => [b.id, b.text]));
      let problems = collectProblems(answer.translations, hitsByBlock, answer.missing, sources);
      if (problems.length) {
        messages.push({ role: 'assistant', content: first.text }, { role: 'user', content: repairInstruction(problems) });
        try {
          const second = await provider.complete({ system, messages, json: true, signal: opts.signal, maxTokens: room });
          usage.push(usageFrom(provider, second));
          const repaired = parseTranslationAnswer(second.text, blocks);
          const secondLow = !!(repaired.repaired || second.truncated);
          for (const id of repaired.translations.keys()) {
            if (secondLow) low.add(id);
            else low.delete(id);
          }
          // Keep anything the first answer had that the repair dropped.
          for (const [id, t] of answer.translations) if (!repaired.translations.has(id)) repaired.translations.set(id, t);
          answer = { ...repaired, missing: blocks.filter((b) => !repaired.translations.has(b.id)).map((b) => b.id) };
        } catch (e) {
          if (e instanceof AppError && e.code === 'CANCELLED') throw e;
          // Repair is best effort; fall through to deterministic fixes.
        }
        problems = collectProblems(answer.translations, hitsByBlock, answer.missing, sources);
      }
      // Deterministic last resort for forbidden forms.
      const translations: TranslateBlocksResult['translations'] = new Map();
      for (const [id, t] of answer.translations) {
        // Still a run of one letter: no translation is better than «Хххххх» in the bubble.
        if (isDegenerate(t.text, sources.get(id) ?? '')) continue;
        const text = tameRuns(t.text);
        const v = findViolations(text, hitsByBlock.get(id) ?? []);
        const fixed = v.length ? applyForbiddenFixes(text, v) : text;
        translations.set(id, { ...t, text: fixed, ...(low.has(id) ? { lowConfidence: true } : {}) });
      }
      return { translations, entities: answer.entities, summary: answer.summary, usage };
    },
    { retries, signal: opts.signal },
  );
}

function collectProblems(translations: Map<string, { text: string }>, hitsByBlock: Map<string, GlossaryHit[]>, missing: string[], sources?: Map<string, string>): string[] {
  const problems: string[] = [];
  if (missing.length) problems.push(`Missing translations for ids: ${missing.join(', ')}`);
  for (const [id, t] of translations) {
    const src = sources?.get(id);
    if (src && isDegenerate(t.text, src)) problems.push(`Block ${id}: "${t.text.slice(0, 24)}…" is not a translation of "${src}". Translate the word itself; a drawn-out word stays a word with a few repeated letters (e.g. "COOOME…" → the target word for "come" with one vowel drawn out, like "Иди-и-и…" in Russian).`);
    for (const v of findViolations(t.text, hitsByBlock.get(id) ?? [])) {
      problems.push(`Block ${id}: "${v.found}" is forbidden, use "${v.entry.target}" for "${v.entry.source}"`);
    }
  }
  return problems;
}
