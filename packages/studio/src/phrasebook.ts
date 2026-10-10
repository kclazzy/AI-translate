import {
  activeEntries,
  DEFAULT_PHRASEBOOK,
  matchText,
  normalizeForMatch,
  phraseSourceLang,
  shortId,
  STANDALONE_SHARE,
  type BookEntry,
  type GlossaryEntry,
  type PhraseCategory,
  type PhrasebookSettings,
  type TextBlock,
  type UserPhrase,
} from '@ait/core';

export interface PhraseFilter {
  lang: string;
  query: string;
  cat: PhraseCategory | '';
}

/** Entries of one language matching the search (spellings, translations, notes) and the category. */
export function filterEntries(entries: BookEntry[], f: PhraseFilter): BookEntry[] {
  const q = f.query.trim().toLowerCase();
  return entries.filter((e) => {
    if (e.source !== f.lang) return false;
    if (f.cat && e.cat !== f.cat) return false;
    if (!q) return true;
    return e.id.toLowerCase().includes(q) || e.src.some((s) => s.toLowerCase().includes(q)) || e.variants.some((v) => v.text.toLowerCase().includes(q) || v.when.toLowerCase().includes(q)) || (e.note ?? '').toLowerCase().includes(q);
  });
}

export const phrasebookOf = (s: { phrasebook?: PhrasebookSettings }): PhrasebookSettings => s.phrasebook ?? DEFAULT_PHRASEBOOK;

/** Switch one entry on or off. */
export function toggleEntry(pb: PhrasebookSettings, id: string, enabled: boolean): PhrasebookSettings {
  const disabled = pb.disabled.filter((x) => x !== id);
  return { ...pb, disabled: enabled ? disabled : [...disabled, id] };
}

/** «я, ты , мы» → ['я', 'ты', 'мы']: spellings typed comma-separated. */
export function splitForms(s: string): string[] {
  return [...new Set(s.split(/[,，、]/).map((x) => x.trim()).filter(Boolean))];
}

/** Something the user rewrote in a block whose original holds a phrasebook expression. */
export interface LearnSuggestion {
  blockId: string;
  /** Source language of the expression. */
  source: string;
  /** The spelling found in the original. */
  src: string;
  /** The user's new translation of the block. */
  text: string;
  /** The expression is (almost) the whole bubble: the whole translation is the user's variant. */
  whole: boolean;
}

/** Spellings already offered in this session (asked once, whatever the answer). */
const asked = new Set<string>();
const askKey = (source: string, src: string) => `${source}:${normalizeForMatch(src, source)}`;
export function markAsked(s: { source: string; src: string }): void {
  asked.add(askKey(s.source, s.src));
}
/** Tests only. */
export function resetAsked(): void {
  asked.clear();
}

/**
 * Blocks whose translation the user changed since the last save and whose original holds a
 * phrasebook expression: one suggestion per block (the expression that takes most of the bubble),
 * never twice for the same spelling in a session, nothing when the new text is already a variant.
 */
export function learnSuggestions(before: TextBlock[], after: TextBlock[], opts: { sourceLang: string; targetLang: string; phrasebook?: PhrasebookSettings; glossary?: GlossaryEntry[] }): LearnSuggestion[] {
  const pb = opts.phrasebook;
  if (!pb?.enabled || opts.targetLang.split('-')[0] !== 'ru') return [];
  const prev = new Map(before.map((b) => [b.id, b]));
  const out: LearnSuggestion[] = [];
  const cache = new Map<string, BookEntry[]>();
  for (const b of after) {
    const old = prev.get(b.id);
    const text = b.translatedText.trim();
    if (!old || !text || !b.translate || old.translatedText.trim() === text || old.originalText !== b.originalText) continue;
    const blockLang = b.language && b.language !== 'und' ? b.language : opts.sourceLang;
    const lang = phraseSourceLang(blockLang, [b.originalText]) ?? phraseSourceLang('auto', [b.originalText]);
    if (!lang) continue;
    if (!cache.has(lang)) cache.set(lang, activeEntries(lang, opts.targetLang, pb));
    const hits = matchText(b.originalText, cache.get(lang)!, lang, opts.glossary).sort((x, y) => y.share - x.share);
    const hit = hits[0];
    if (!hit || asked.has(askKey(lang, hit.matched))) continue;
    const plain = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
    if (hit.entry.variants.some((v) => plain(v.text) === plain(text))) continue;
    out.push({ blockId: b.id, source: lang, src: hit.matched, text, whole: !!hit.entry.standalone || hit.share >= STANDALONE_SHARE });
  }
  return out;
}

/** The user's variant as an entry of their own (a later one for the same spelling replaces it). */
export function rememberPhrase(pb: PhrasebookSettings, s: { source: string; src: string; text: string }, when: string): PhrasebookSettings {
  const key = normalizeForMatch(s.src, s.source);
  const user = pb.user.filter((u) => !(u.source === s.source && u.src.length === 1 && normalizeForMatch(u.src[0], u.source) === key));
  const entry: UserPhrase = { id: shortId('user:'), source: s.source, src: [s.src], variants: [{ text: s.text, when }] };
  return { ...pb, user: [...user, entry] };
}
