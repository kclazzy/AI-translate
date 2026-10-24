import { AppError } from '../errors';
import { estimateCost } from '../llm/presets';
import { isBrowserTranslator, translateWithBrowser } from '../llm/browserTranslator';
import type { ChatMessage, CompletionResult, LlmProvider } from '../llm/types';
import type { TextType, Usage } from '../types';
import { withRetry } from '../util/retry';
import { applyForbiddenFixes, findGlossaryHits, findViolations, type GlossaryHit } from './glossary';
import { isDegenerate, parseTranslationAnswer, tameRuns } from './parse';
import { isAllCaps, sentenceCase, unshout } from './caseNorm';
import { learnCharacters, namesIn } from './names';
import { continuesNext } from './continuation';
import { sfxVariants } from './sfx';
import { completeFitted, CONTEXT_LEVELS, estimateTokens, fitRequest, growRoom, SAFETY, windowOf } from './budget';
import { buildSystemPrompt, contextData, glossaryExtra, phrasebookData, repairInstruction, textTranslateInstruction, type BlockForTranslation, type PromptInput } from './prompt';

export interface TranslateBlocksResult {
  /** lowConfidence: the translation came from an answer that was cut off or had to be mended. */
  translations: Map<string, { text: string; type?: TextType; lowConfidence?: boolean }>;
  entities: unknown[];
  summary: string;
  usage: Usage[];
}

/** Tokens and price of one answer (prompt-cache reads and writes priced apart, see estimateCost). */
export function usageFrom(provider: LlmProvider, res: Pick<CompletionResult, 'model' | 'inputTokens' | 'outputTokens' | 'cachedInputTokens' | 'cacheWriteTokens' | 'ms' | 'tokensPerSecond'>): Usage {
  const cached = res.cachedInputTokens ?? 0;
  return {
    provider: provider.config.label,
    model: res.model,
    inputTokens: res.inputTokens,
    outputTokens: res.outputTokens,
    costUsd: estimateCost(provider.config, res.inputTokens, res.outputTokens, cached, res.cacheWriteTokens ?? 0),
    ...(cached > 0 ? { cachedTokens: cached } : {}),
    ...(res.ms !== undefined ? { ms: res.ms } : {}),
    ...(res.tokensPerSecond ? { tps: Math.round(res.tokensPerSecond * 10) / 10 } : {}),
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
  // Lettered in capitals: normal case for the model (names keep their capital), see sentenceCase.
  const keepWords = new Set([...(input.context?.entities ?? []).map((e) => e.source), ...input.glossary.map((g) => g.source)].flatMap((w) => w.toLowerCase().split(/\s+/)));
  const shouted = new Set(blocks.filter((b) => isAllCaps(b.text)).map((b) => b.id));
  const original = new Map(blocks.map((b) => [b.id, b.text]));
  // Speech answered in capitals reads as shouting in the text list; labels of game windows stay as they are.
  const speech = new Set(blocks.filter((b) => b.type === 'DIALOGUE').map((b) => b.id));
  blocks = blocks.map((b) => (shouted.has(b.id) ? { ...b, text: sentenceCase(b.text, (w) => keepWords.has(w.toLowerCase())) } : b));
  if (isBrowserTranslator(provider.config)) {
    // The browser's translator (capitals made normal case above): line by line, the glossary's own translations kept where a line is just a term.
    const out = await translateWithBrowser(blocks.map((b) => b.text), input.sourceLang, input.targetLang, opts.signal);
    const exact = new Map(input.glossary.map((g) => [g.source.trim().toLowerCase(), g.target]));
    const translations = new Map(blocks.map((b, i) => [b.id, { text: exact.get(b.text.trim().toLowerCase()) ?? out[i] }]));
    return { translations, entities: [], summary: '', usage: [{ provider: provider.config.label, model: 'browser', inputTokens: 0, outputTokens: 0, costUsd: 0 }] };
  }
  // A line that goes on in the next speech block: translated as one sentence (continuesNext).
  blocks = blocks.map((b, i) => {
    const next = blocks[i + 1];
    const speech = (t: TextType) => t === 'DIALOGUE' || t === 'NARRATION';
    return next && speech(b.type) && next.type === b.type && continuesNext(b.text) ? { ...b, joinsNext: true } : b;
  });
  const sounds = blocks.flatMap((b) => {
    const v = b.type === 'SFX' ? sfxVariants(b.text, input.targetLang) : null;
    return v ? [`${b.text.trim()} → ${v.join(' / ')}`] : [];
  });
  const names = namesIn(blocks.map((b) => b.text), (input.context?.entities ?? []).filter((e) => e.kind === 'character').map((e) => e.source));
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
  const texts = blocks.map((b) => b.text);
  const userAt = (level: number) => {
    const lv = CONTEXT_LEVELS[level];
    return textTranslateInstruction(blocks, hintStrings, contextData(input, lv, texts), lv.phrasebook ? phrasebookData(input, blocks) : '', glossaryExtra(input, [...allHits.values()]), names, sounds);
  };
  const systemTokens = estimateTokens(system);
  const inputAt = (level: number) => systemTokens + estimateTokens(userAt(level));
  const win = windowOf(provider.config);
  const usage: Usage[] = [];

  const retries = opts.retries ?? 2;
  // After an answer cut off at the output limit, the next try gets twice the room.
  let room = Math.min(8192, 400 + blocks.length * 160);
  // A page too long for the window even without the series context: translate it in two halves
  // (in reading order, the first half's last lines go along as earlier lines of the scene).
  if (win && blocks.length >= 4) {
    const fit = fitRequest(win, room, inputAt);
    if (!fit || fit.level >= CONTEXT_LEVELS.length - 1) return translateInHalves(provider, input, blocks, opts);
  }
  // Low and steady: the same term the same way on every page (a temperature set by the user wins).
  const temperature = provider.config.temperature ?? 0.15;
  let level = 0;
  return withRetry(
    async (attempt) => {
      const last = attempt >= retries;
      const sent = await completeFitted(win, room, inputAt, (l, maxTokens) => provider.complete({ system, messages: [{ role: 'user', content: userAt(l) }], json: true, signal: opts.signal, maxTokens, temperature }), { from: level });
      level = sent.level;
      const user = userAt(level);
      const messages: ChatMessage[] = [{ role: 'user', content: user }];
      const first = sent.res;
      usage.push(usageFrom(provider, first));
      if (first.truncated && !last) {
        const more = growRoom(win, sent.maxTokens, sent.inputTokens);
        if (more <= sent.maxTokens && level < CONTEXT_LEVELS.length - 1) level++;
        room = win ? more : Math.min(16384, room * 2);
        throw new AppError('TRANSLATION_INVALID_OUTPUT', { retryable: true, detail: 'Answer cut off at the output limit' });
      }
      let answer = parseTranslationAnswer(first.text, blocks, last);
      // Ids whose translation comes from a cut-off or mended answer.
      const low = new Set<string>(answer.repaired || first.truncated ? answer.translations.keys() : []);
      const sources = original;
      let problems = collectProblems(answer.translations, hitsByBlock, answer.missing, sources);
      // The repair round re-sends the request and the first answer: only when that still fits the window.
      const repairFits = !win || sent.inputTokens + estimateTokens(first.text) + 400 + sent.maxTokens <= win * (1 - SAFETY);
      if (problems.length && repairFits) {
        messages.push({ role: 'assistant', content: first.text }, { role: 'user', content: repairInstruction(problems) });
        try {
          const second = await provider.complete({ system, messages, json: true, signal: opts.signal, maxTokens: sent.maxTokens, temperature });
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
      const targetNames = (input.context?.entities ?? []).filter((e) => e.kind === 'character' || e.kind === 'place').map((e) => e.target);
      // Deterministic last resort for forbidden forms.
      const translations: TranslateBlocksResult['translations'] = new Map();
      for (const [id, t] of answer.translations) {
        // Still a run of one letter: no translation is better than «Хххххх» in the bubble.
        if (isDegenerate(t.text, sources.get(id) ?? '')) continue;
        // The model copied the capitals: normal case (the picture shows capitals by the style anyway).
        const text = shouted.has(id) && speech.has(id) ? unshout(tameRuns(t.text), targetNames) : tameRuns(t.text);
        const v = findViolations(text, hitsByBlock.get(id) ?? []);
        const fixed = v.length ? applyForbiddenFixes(text, v) : text;
        translations.set(id, { ...t, text: fixed, ...(low.has(id) ? { lowConfidence: true } : {}) });
      }
      // Names found on the page with their spelling in the translation and the gender the words tell.
      const learned = learnCharacters(blocks.map((b) => ({ text: b.text, translation: translations.get(b.id)?.text })), input.context?.entities ?? []);
      const entities = [...learned.filter((l) => !answer.entities.some((e) => (e as { source?: string }).source?.toLowerCase() === l.source.toLowerCase() && !l.gender)), ...answer.entities];
      return { translations, entities, summary: answer.summary, usage };
    },
    { retries, signal: opts.signal },
  );
}

/** Translate a long page in two halves; the second half sees the first half's last lines as earlier lines. */
async function translateInHalves(provider: LlmProvider, input: PromptInput, blocks: BlockForTranslation[], opts: { signal?: AbortSignal; retries?: number }): Promise<TranslateBlocksResult> {
  const mid = Math.ceil(blocks.length / 2);
  const a = await translateBlocks(provider, input, blocks.slice(0, mid), opts);
  const tail = blocks.slice(Math.max(0, mid - 2), mid).map((b) => ({ src: b.text, dst: a.translations.get(b.id)?.text ?? '' })).filter((l) => l.dst);
  const ctx = input.context ? { ...input.context, recentLines: [...input.context.recentLines, ...tail] } : undefined;
  const b = await translateBlocks(provider, { ...input, context: ctx }, blocks.slice(mid), opts);
  return {
    translations: new Map([...a.translations, ...b.translations]),
    entities: [...a.entities, ...b.entities],
    summary: [a.summary, b.summary].filter(Boolean).join(' '),
    usage: [...a.usage, ...b.usage],
  };
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
