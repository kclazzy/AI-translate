import { AppError } from '../errors';
import { estimateCost } from '../llm/presets';
import type { ChatMessage, LlmProvider } from '../llm/types';
import type { TextType, Usage } from '../types';
import { withRetry } from '../util/retry';
import { applyForbiddenFixes, findGlossaryHits, findViolations, type GlossaryHit } from './glossary';
import { parseTranslationAnswer } from './parse';
import { buildSystemPrompt, repairInstruction, textTranslateInstruction, type BlockForTranslation, type PromptInput } from './prompt';

export interface TranslateBlocksResult {
  translations: Map<string, { text: string; type?: TextType }>;
  entities: unknown[];
  summary: string;
  usage: Usage[];
}

export function usageFrom(provider: LlmProvider, model: string, input: number, output: number): Usage {
  return { provider: provider.config.label, model, inputTokens: input, outputTokens: output, costUsd: estimateCost(provider.config, input, output) };
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

  const system = buildSystemPrompt(input, [...allHits.values()]);
  const user = textTranslateInstruction(blocks, hintStrings);
  const usage: Usage[] = [];

  const retries = opts.retries ?? 2;
  return withRetry(
    async (attempt) => {
      const messages: ChatMessage[] = [{ role: 'user', content: user }];
      const first = await provider.complete({ system, messages, json: true, signal: opts.signal, maxTokens: Math.min(8192, 400 + blocks.length * 160) });
      usage.push(usageFrom(provider, first.model, first.inputTokens, first.outputTokens));
      let answer = parseTranslationAnswer(first.text, blocks, attempt >= retries);
      let problems = collectProblems(answer.translations, hitsByBlock, answer.missing);
      if (problems.length) {
        messages.push({ role: 'assistant', content: first.text }, { role: 'user', content: repairInstruction(problems) });
        try {
          const second = await provider.complete({ system, messages, json: true, signal: opts.signal, maxTokens: Math.min(8192, 400 + blocks.length * 160) });
          usage.push(usageFrom(provider, second.model, second.inputTokens, second.outputTokens));
          const repaired = parseTranslationAnswer(second.text, blocks);
          // Keep anything the first answer had that the repair dropped.
          for (const [id, t] of answer.translations) if (!repaired.translations.has(id)) repaired.translations.set(id, t);
          answer = { ...repaired, missing: blocks.filter((b) => !repaired.translations.has(b.id)).map((b) => b.id) };
        } catch (e) {
          if (e instanceof AppError && e.code === 'CANCELLED') throw e;
          // Repair is best effort; fall through to deterministic fixes.
        }
        problems = collectProblems(answer.translations, hitsByBlock, answer.missing);
      }
      // Deterministic last resort for forbidden forms.
      for (const [id, t] of answer.translations) {
        const v = findViolations(t.text, hitsByBlock.get(id) ?? []);
        if (v.length) answer.translations.set(id, { ...t, text: applyForbiddenFixes(t.text, v) });
      }
      return { translations: answer.translations, entities: answer.entities, summary: answer.summary, usage };
    },
    { retries, signal: opts.signal },
  );
}

function collectProblems(translations: Map<string, { text: string }>, hitsByBlock: Map<string, GlossaryHit[]>, missing: string[]): string[] {
  const problems: string[] = [];
  if (missing.length) problems.push(`Missing translations for ids: ${missing.join(', ')}`);
  for (const [id, t] of translations) {
    for (const v of findViolations(t.text, hitsByBlock.get(id) ?? [])) {
      problems.push(`Block ${id}: "${v.found}" is forbidden, use "${v.entry.target}" for "${v.entry.source}"`);
    }
  }
  return problems;
}
