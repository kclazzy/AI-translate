/**
 * Разговорник: finds recurring expressions (なるほど, 대박, "No way") in the page's original text and
 * turns them into hints for the model. Hints only: the model picks a variant when it fits the scene,
 * nothing is ever replaced in the translation.
 */
import { detectScript } from '../../languages';
import { findGlossaryHits, type GlossaryEntry } from '../glossary';
import { sanitizeLine } from '../parse';
import type { HonorificsPolicy } from '../profiles';
import { builtinEntries, type BookEntry, type LoadedBook } from './books';
import type { PhraseCategory, PhraseVariant } from './types';

/** An expression the user added (Studio → «Свои выражения», or «Запомнить» after an edit). */
export interface UserPhrase {
  id: string;
  /** Source language (ja, ko, zh, en). */
  source: string;
  src: string[];
  variants: { text: string; when: string }[];
  note?: string;
}

/** The phrasebook part of the settings. */
export interface PhrasebookSettings {
  enabled: boolean;
  /** Ids of entries switched off. */
  disabled: string[];
  /** Genre sets switched on (e.g. 'cultivation'). */
  genres: string[];
  user: UserPhrase[];
}

export const DEFAULT_PHRASEBOOK: PhrasebookSettings = { enabled: true, disabled: [], genres: [], user: [] };

/** At most this many expressions go to the model per page. */
export const PHRASES_PER_PAGE = 8;
/** A «standalone» expression must be at least this share of the bubble's letters. */
export const STANDALONE_SHARE = 0.6;
/** Languages the phrasebooks cover. */
export const PHRASEBOOK_SOURCES = ['ja', 'ko', 'zh', 'en'] as const;

export interface PhraseMatch {
  entry: BookEntry;
  /** The spelling found (as written in the entry). */
  matched: string;
  /** Ids of the blocks it was found in. */
  blocks: string[];
  /** Variants for the profile's honorifics setting. */
  variants: PhraseVariant[];
  /** The expression is (almost) the whole bubble. */
  whole: boolean;
}

export interface PhraseOptions {
  sourceLang: string;
  targetLang: string;
  honorifics?: HonorificsPolicy;
  settings?: PhrasebookSettings;
  glossary?: GlossaryEntry[];
  /** Books to use instead of the built-in ones (tests). */
  books?: LoadedBook[];
}

const base = (lang: string) => lang.split('-')[0].toLowerCase();
const isLatinLang = (lang: string) => base(lang) === 'en';

// ---- normalisation ---------------------------------------------------------------------------------

/** Long-vowel marks and tildes are dropped on both sides: うそー = うそ, なるほどぉ～ ≈ なるほどぉ. */
const LONG = /[ー～〜~ーｰ]+/g;

/** Text as compared for CJK and Korean: NFKC, lower case, no spaces, punctuation or long-vowel marks. */
export function normalizeCjk(s: string): string {
  return s.normalize('NFKC').toLowerCase().replace(LONG, '').replace(/[\s\p{P}\p{S}]+/gu, '');
}

/** Text as compared for English: NFKC, lower case, punctuation → space, single spaces. */
export function normalizeLatin(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[’‘`´]/g, "'")
    .replace(/[^\p{L}\p{N}'\s-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeForMatch(s: string, lang: string): string {
  return isLatinLang(lang) ? normalizeLatin(s) : normalizeCjk(s);
}

/** Letters and digits only: what the «most of the bubble» share is counted on. */
const letterCount = (s: string) => s.replace(/[^\p{L}\p{N}]/gu, '').length;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

interface Form {
  raw: string;
  norm: string;
  len: number;
  latin: boolean;
  re?: RegExp;
}

/** Whole-word pattern for an English spelling, made on first use. */
function wordRe(f: Form): RegExp {
  return (f.re ??= new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(f.norm)}(?![\\p{L}\\p{N}])`, 'gu'));
}

const formCache = new WeakMap<BookEntry, Form[]>();

function formsOf(entry: BookEntry): Form[] {
  let f = formCache.get(entry);
  if (!f) {
    const latin = isLatinLang(entry.source);
    const seen = new Set<string>();
    f = [];
    for (const raw of entry.src) {
      const norm = normalizeForMatch(raw, entry.source);
      if (!norm || seen.has(norm)) continue;
      seen.add(norm);
      f.push({ raw, norm, len: letterCount(norm), latin });
    }
    formCache.set(entry, f);
  }
  return f;
}

// ---- which entries apply ---------------------------------------------------------------------------

/** The language of the page's text when the source is «auto»: kana → ja, hangul → ko, han → zh, latin → en. */
export function phraseSourceLang(sourceLang: string, texts: string[]): string | null {
  if (sourceLang && sourceLang !== 'auto') {
    const b = base(sourceLang);
    return (PHRASEBOOK_SOURCES as readonly string[]).includes(b) ? b : null;
  }
  const script = detectScript(texts.join('\n'));
  return script === 'ja' || script === 'ko' || script === 'zh' ? script : script === 'latin' ? 'en' : null;
}

export function userEntry(p: UserPhrase): BookEntry {
  return {
    id: p.id,
    src: p.src,
    cat: 'situational',
    variants: p.variants.filter((v) => v.text).map((v) => ({ text: v.text, when: v.when })),
    ...(p.note ? { note: p.note } : {}),
    source: base(p.source),
    target: 'ru',
    user: true,
  };
}

/**
 * Entries that apply to a page in `lang` translated into `targetLang`: built-in ones (genre sets only
 * when switched on, switched-off ids left out) and the user's. A user entry with the same spelling
 * as a built-in one replaces it.
 */
export function activeEntries(lang: string, targetLang: string, settings: PhrasebookSettings = DEFAULT_PHRASEBOOK, books?: LoadedBook[]): BookEntry[] {
  const target = base(targetLang);
  if (!settings.enabled) return [];
  const disabled = new Set(settings.disabled);
  const genres = new Set(settings.genres);
  const user = settings.user.filter((u) => base(u.source) === lang && target === 'ru').map(userEntry).filter((e) => e.src.length && e.variants.length && !disabled.has(e.id));
  const userForms = new Set(user.flatMap((e) => formsOf(e).map((f) => f.norm)));
  const builtin = (books ? books.flatMap((b) => b.entries) : builtinEntries()).filter(
    (e) => e.source === lang && base(e.target) === target && !disabled.has(e.id) && (!e.genre || genres.has(e.genre)) && !formsOf(e).some((f) => userForms.has(f.norm)),
  );
  // A genre set that is switched on knows its words better than the general set: same spelling → genre wins.
  const genreForms = new Set(builtin.filter((e) => e.genre).flatMap((e) => formsOf(e).map((f) => f.norm)));
  const general = builtin.filter((e) => e.genre || !formsOf(e).some((f) => genreForms.has(f.norm)));
  return [...user, ...general];
}

/** Variants for the profile: «keep» shows the honorific kept as is, «adapt»/«drop» the Russian ways. */
export function variantsFor(entry: BookEntry, honorifics: HonorificsPolicy = 'adapt'): PhraseVariant[] {
  const want = honorifics === 'keep' ? 'keep' : 'adapt';
  const v = entry.variants.filter((x) => !x.policy || x.policy === want);
  return v.length ? v : entry.variants;
}

// ---- matching ---------------------------------------------------------------------------------------

export interface TextHit {
  entry: BookEntry;
  matched: string;
  /** Share of the bubble's letters the expression takes (0–1). */
  share: number;
  /** Where it starts in the normalised text. */
  start: number;
}

/**
 * Expressions in one text: the longest spelling wins and a stretch of text belongs to one expression
 * only («なるほどね» is not also «なるほど»). «standalone» entries count only when they are most of
 * the bubble. Spellings covered by a glossary term are left to the glossary.
 */
export function matchText(text: string, entries: BookEntry[], lang: string, glossary: GlossaryEntry[] = []): TextHit[] {
  const latin = isLatinLang(lang);
  const norm = normalizeForMatch(text, lang);
  const total = letterCount(norm);
  if (!total) return [];
  const glossaryForms = findGlossaryHits(text, glossary).map((h) => normalizeForMatch(h.matched, lang)).filter(Boolean);
  const cands: { entry: BookEntry; form: Form; start: number; end: number }[] = [];
  for (const entry of entries) {
    for (const form of formsOf(entry)) {
      if (form.len > total) continue;
      if (entry.standalone && form.len / total < STANDALONE_SHARE) continue;
      if (glossaryForms.some((g) => g.includes(form.norm) || form.norm.includes(g))) continue;
      if (!norm.includes(form.norm)) continue;
      if (latin) {
        for (const m of norm.matchAll(wordRe(form))) cands.push({ entry, form, start: m.index!, end: m.index! + m[0].length });
      } else {
        for (let i = norm.indexOf(form.norm); i >= 0; i = norm.indexOf(form.norm, i + 1)) cands.push({ entry, form, start: i, end: i + form.norm.length });
      }
    }
  }
  if (!cands.length) return [];
  cands.sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start);
  const taken: [number, number][] = [];
  const out = new Map<string, TextHit>();
  for (const c of cands) {
    if (taken.some(([s, e]) => c.start < e && s < c.end)) continue;
    taken.push([c.start, c.end]);
    const prev = out.get(c.entry.id);
    const share = c.form.len / total;
    if (!prev || share > prev.share) out.set(c.entry.id, { entry: c.entry, matched: c.form.raw, share, start: prev ? Math.min(prev.start, c.start) : c.start });
    else prev.start = Math.min(prev.start, c.start);
  }
  return [...out.values()].sort((a, b) => a.start - b.start);
}

/**
 * The expressions to hint for a page: found in any of the blocks, at most 8 (longer spellings first,
 * then those found in more blocks), listed in reading order.
 */
export function findPhrases(blocks: { id: string; text: string }[], opts: PhraseOptions): PhraseMatch[] {
  const settings = opts.settings;
  if (!settings?.enabled || !blocks.length) return [];
  if (base(opts.targetLang) !== 'ru') return [];
  const lang = phraseSourceLang(opts.sourceLang, blocks.map((b) => b.text));
  if (!lang) return [];
  const entries = activeEntries(lang, opts.targetLang, settings, opts.books);
  if (!entries.length) return [];
  const found = new Map<string, { hit: TextHit; blocks: string[]; first: number; whole: boolean }>();
  let order = 0;
  blocks.forEach((b) => {
    for (const hit of matchText(b.text, entries, lang, opts.glossary)) {
      const f = found.get(hit.entry.id);
      if (!f) found.set(hit.entry.id, { hit, blocks: [b.id], first: order++, whole: hit.share >= STANDALONE_SHARE });
      else {
        if (!f.blocks.includes(b.id)) f.blocks.push(b.id);
        if (normalizeForMatch(hit.matched, lang).length > normalizeForMatch(f.hit.matched, lang).length) f.hit = hit;
        if (hit.share >= STANDALONE_SHARE) f.whole = true;
      }
    }
  });
  const len = (s: string) => letterCount(normalizeForMatch(s, lang));
  return [...found.values()]
    .sort((a, b) => len(b.hit.matched) - len(a.hit.matched) || b.blocks.length - a.blocks.length || a.first - b.first)
    .slice(0, PHRASES_PER_PAGE)
    .sort((a, b) => a.first - b.first)
    .map((f) => ({ entry: f.hit.entry, matched: f.hit.matched, blocks: f.blocks, variants: variantsFor(f.hit.entry, opts.honorifics), whole: f.whole }));
}

// ---- the prompt section -----------------------------------------------------------------------------

export const PHRASEBOOK_HEADER =
  'PHRASEBOOK — hints for expressions on this page. Use a variant only if it fits the scene and the speaker; otherwise translate freely. Never translate these literally.';
export const PHRASEBOOK_HEADER_EARLIER =
  'PHRASEBOOK — hints for expressions seen on the previous pages of this series, in case they appear on this page. Use a variant only if it fits the scene and the speaker; otherwise translate freely. Never translate these literally.';

/** One line per expression: `- なるほど (bubble alone) → «Вот оно что» (догадка) | «Понятно» (нейтрально) — note`. */
export function phraseLine(m: PhraseMatch): string {
  const e = m.entry;
  const marks = [e.standalone ? 'bubble alone' : '', e.speaker ? 'проверь, кто говорит' : ''].filter(Boolean).map((x) => ` (${x})`).join('');
  const variants = m.variants
    .slice(0, 5)
    .map((v) => {
      const text = sanitizeLine(v.text, 80).replace(/[«»]/g, '"');
      const when = sanitizeLine(v.when, 80);
      return `«${text}»${when ? ` (${when})` : ''}`;
    })
    .join(' | ');
  const note = e.note ? ` — ${sanitizeLine(e.note, 160)}` : '';
  return `- ${sanitizeLine(m.matched, 60)}${marks} → ${variants}${note}`;
}

/** The section for the model ('' when nothing matched). */
export function phrasebookSection(matches: PhraseMatch[], header = PHRASEBOOK_HEADER): string {
  if (!matches.length) return '';
  return [header, ...matches.map(phraseLine)].join('\n');
}

/** Categories in the order the Studio shows them. */
export const PHRASE_CATEGORIES: PhraseCategory[] = ['interjection', 'situational', 'slang', 'address', 'term'];
