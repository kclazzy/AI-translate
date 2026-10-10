import type { PhraseCategory, PhraseEntry, PhraseVariant } from './types';
import jaRu from './ja-ru.json';
import koRu from './ko-ru.json';
import zhRu from './zh-ru.json';
import enRu from './en-ru.json';
import zhRuCultivation from './zh-ru-cultivation.json';

/**
 * An entry ready for matching: the book's languages and genre are carried by every entry, so user
 * entries and entries of several books can sit in one list.
 */
export interface BookEntry extends PhraseEntry {
  /** Source language (ja, ko, zh, en). */
  source: string;
  /** Target language (ru). */
  target: string;
  /** Genre set the entry belongs to ('cultivation'); active only when that genre is switched on. */
  genre?: string;
  /** Written by the user (Studio → «Свои выражения» or learned from an edit). */
  user?: boolean;
}

export interface LoadedBook {
  source: string;
  target: string;
  genre?: string;
  title: string;
  entries: BookEntry[];
}

const CATS: PhraseCategory[] = ['interjection', 'situational', 'slang', 'address', 'term'];
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

function cleanVariant(v: unknown): PhraseVariant | null {
  if (!isObj(v)) return null;
  const text = str(v.text);
  if (!text) return null;
  const out: PhraseVariant = { text, when: str(v.when) };
  if (v.policy === 'keep' || v.policy === 'adapt') out.policy = v.policy;
  return out;
}

/**
 * One entry of a data file. Accepts the schema of types.ts and the authoring shape the data files
 * may use (`source` for `src`, `kind` for `cat`, `whole` for `standalone`, `keep: "сэмпай"` for the
 * variant kept with the honorific, `genre` per entry).
 */
export function normalizeEntry(raw: unknown, book: { source: string; target: string; genre?: string }): BookEntry | null {
  if (!isObj(raw)) return null;
  const id = str(raw.id);
  const srcRaw = raw.src ?? (Array.isArray(raw.source) || typeof raw.source === 'string' ? raw.source : undefined);
  const src = (Array.isArray(srcRaw) ? srcRaw : [srcRaw]).map(str).filter(Boolean);
  let variants = (Array.isArray(raw.variants) ? raw.variants : []).map(cleanVariant).filter((v): v is PhraseVariant => !!v);
  if (!id || !src.length || !variants.length) return null;
  const keep = str(raw.keep);
  if (keep && !variants.some((v) => v.policy)) {
    // The honorific kept as in the original («сэмпай») vs the ways to say it in Russian.
    variants = [...variants.map((v) => ({ ...v, policy: 'adapt' as const })), { text: keep, when: 'с хонорификом, как в оригинале', policy: 'keep' }];
  }
  const cat = (CATS.includes(raw.cat as PhraseCategory) ? raw.cat : CATS.includes(raw.kind as PhraseCategory) ? raw.kind : 'situational') as PhraseCategory;
  const out: BookEntry = { id, src: [...new Set(src)], cat, variants, source: book.source, target: book.target };
  if (raw.standalone === true || raw.whole === true) out.standalone = true;
  if (raw.speaker === true) out.speaker = true;
  const note = str(raw.note);
  if (note) out.note = note;
  const genre = str(raw.genre) || book.genre;
  if (genre) out.genre = genre;
  return out;
}

/** A data file: a PhraseBook object or a bare list of entries (languages then come from `fallback`). */
export function normalizeBook(raw: unknown, fallback: { source: string; target: string; genre?: string; title?: string }): LoadedBook {
  const obj = isObj(raw) ? raw : {};
  const source = str(obj.source) || fallback.source;
  const target = str(obj.target) || fallback.target;
  const genre = str(obj.genre) || fallback.genre || undefined;
  const list = Array.isArray(raw) ? raw : Array.isArray(obj.entries) ? obj.entries : [];
  const entries = list.map((e) => normalizeEntry(e, { source, target, genre })).filter((e): e is BookEntry => !!e);
  return { source, target, ...(genre ? { genre } : {}), title: str(obj.title) || fallback.title || `${source}→${target}`, entries };
}

/** Data files shipped with the app, with the languages their names promise. */
const BUILTIN: [unknown, { source: string; target: string; genre?: string; title: string }][] = [
  [jaRu, { source: 'ja', target: 'ru', title: 'Японский → русский' }],
  [koRu, { source: 'ko', target: 'ru', title: 'Корейский → русский' }],
  [zhRu, { source: 'zh', target: 'ru', title: 'Китайский → русский' }],
  [enRu, { source: 'en', target: 'ru', title: 'Английский → русский' }],
  [zhRuCultivation, { source: 'zh', target: 'ru', genre: 'cultivation', title: 'Культивация (сянься, уся)' }],
];

let loaded: LoadedBook[] | null = null;

/** The built-in phrasebooks (normalised once, on first use). */
export function builtinBooks(): LoadedBook[] {
  return (loaded ??= BUILTIN.map(([raw, meta]) => normalizeBook(raw, meta)));
}

/** All built-in entries, every book's entries in turn. */
export function builtinEntries(): BookEntry[] {
  return builtinBooks().flatMap((b) => b.entries);
}

/** Genres the built-in books know, for the switches in the Studio. */
export function builtinGenres(): string[] {
  return [...new Set(builtinEntries().map((e) => e.genre).filter((g): g is string => !!g))];
}
