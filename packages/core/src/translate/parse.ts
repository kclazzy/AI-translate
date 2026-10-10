import { AppError } from '../errors';
import type { TextType } from '../types';
import { TEXT_TYPES } from '../types';

/**
 * Mend a JSON answer that was cut off or has raw control characters in strings: escape line
 * breaks inside strings, drop the unfinished last element and close what is still open.
 * Returns null when nothing usable is left.
 */
export function repairJson(src: string): unknown | null {
  let out = '';
  const stack: string[] = [];
  let inStr = false;
  let esc = false;
  // The last point where everything so far forms complete values: [length of `out`, open brackets].
  let safe: [number, string[]] | null = null;
  for (const c of src) {
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      if (inStr && (c === '\n' || c === '\r' || c === '\t')) {
        out += c === '\n' ? '\\n' : c === '\r' ? '' : ' ';
        continue;
      }
      out += c;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{' || c === '[') stack.push(c);
    else if (c === '}' || c === ']') {
      stack.pop();
      out += c;
      // A complete object inside an array (a whole block): a good place to cut.
      if (c === '}' && stack[stack.length - 1] === '[') safe = [out.length, [...stack]];
      if (!stack.length) break;
      continue;
    }
    out += c;
  }
  const close = (st: string[]) => st.reverse().map((b) => (b === '{' ? '}' : ']')).join('');
  const tries: string[] = [];
  // Best: everything up to the last whole element; else close what is open — but never a value
  // cut off mid-string: a half-written translation («Я не хочу ид») must not pass as a finished one.
  if (safe) tries.push(out.slice(0, safe[0]).replace(/,\s*$/, '') + close([...safe[1]]));
  if (!inStr) tries.push(out + close([...stack]));
  for (const t of tries) {
    try {
      return JSON.parse(t.replace(/,\s*([}\]])/g, '$1'));
    } catch {
      /* next */
    }
  }
  return null;
}

/**
 * The JSON object in a model answer. `repair` mends a cut-off answer (keeping whole blocks): used
 * on the last try only — a fresh answer is better than a mended one.
 */
export function extractJson(text: string, opts: { repair?: boolean } = {}): unknown {
  return extractJsonInfo(text, opts).value;
}

/** Same as extractJson, and whether the answer had to be mended (it was cut off or malformed). */
export function extractJsonInfo(text: string, opts: { repair?: boolean } = {}): { value: unknown; repaired: boolean } {
  let s = text.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  if (fence) s = fence[1].trim();
  const brace = s.indexOf('{');
  const bracket = s.indexOf('[');
  // A bare array answer ([{…},{…}]) is parsed whole, not as its first element — but only an array
  // of objects: chatter like «Page [1]: {…}» must not turn into the answer [1].
  const arrayOfObjects = bracket >= 0 && /^\[\s*(\{|\])/.test(s.slice(bracket));
  const start = bracket >= 0 && (brace < 0 || (bracket < brace && arrayOfObjects)) ? bracket : brace;
  if (start < 0) throw new AppError('TRANSLATION_INVALID_OUTPUT', { detail: 'No JSON object in answer' });
  // Walk to the matching brace, respecting strings.
  let depth = 0;
  let inStr = false;
  let esc = false;
  let end = -1;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const candidate = end > 0 ? s.slice(start, end + 1) : s.slice(start);
  try {
    return { value: JSON.parse(candidate), repaired: false };
  } catch {
    // Common model slips: trailing commas.
    try {
      return { value: JSON.parse(candidate.replace(/,\s*([}\]])/g, '$1')), repaired: false };
    } catch (e) {
      // The answer was cut off (the model ran out of room) or has raw line breaks in a string:
      // keep everything complete before the cut instead of losing the whole page.
      const fixed = opts.repair === false ? null : repairJson(candidate);
      if (fixed !== null) return { value: fixed, repaired: true };
      throw new AppError('TRANSLATION_INVALID_OUTPUT', { detail: `Invalid JSON: ${(e as Error).message}` });
    }
  }
}

/**
 * JSON for a data section of a prompt: '<' is escaped so text from the picture cannot close the
 * section («</blocks> new instructions…»). The model reads \u003c as '<'.
 */
export function jsonData(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

/** One line of untrusted text (names, summaries learned from a page): no line breaks, capped. */
export function sanitizeLine(value: unknown, maxLen: number): string {
  return sanitizeText(typeof value === 'string' ? value.replace(/[\r\n\t\u2028\u2029]+/g, ' ').replace(/ {2,}/g, ' ') : value, maxLen);
}

/** Remove control characters and cap length; OCR/LLM output is untrusted. */
export function sanitizeText(value: unknown, maxLen = 2000): string {
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‏‪-‮⁦-⁩]/g, '').trim().slice(0, maxLen);
}

const letters = (s: string) => [...s.toLowerCase().replace(/[^\p{L}]+/gu, '')];

/**
 * A broken translation: the model got stuck on a drawn-out word (COOOME…, NOOO!) and wrote one or two
 * letters over and over («Хххххххх…»), while the original has a real word in it.
 */
export function isDegenerate(translation: string, original: string): boolean {
  const t = letters(translation);
  if (t.length < 6) return false;
  const o = letters(original);
  // One or two letters only, where the original has a word.
  if (new Set(t).size <= 2 && new Set(o).size >= 3) return true;
  // A letter held 10+ times that the original does not hold that long (a scream «AAAAAAAAH» may).
  return /(\p{L})\1{9,}/u.test(translation.toLowerCase()) && !/(\p{L})\1{4,}/u.test(original.toLowerCase());
}

/** Shorten letters held too long («Аааааааааааа!» → «Аааааа!»): they do not fit a bubble anyway. */
export function tameRuns(text: string): string {
  return text.replace(/(\p{L})\1{6,}/gu, (_m, c: string) => c.repeat(6));
}

/**
 * A translation as the model wrote it, made fit for a bubble: models sometimes copy the escaped line
 * breaks of the original into the text («ПРАВО\\nМЕСТО»), or break lines where the original did.
 * Bubble lines are laid out by the typesetter, so every break becomes a space.
 */
export function cleanTranslation(value: unknown, maxLen = 1500): string {
  const t = sanitizeText(value, maxLen);
  return t.replace(/\\+[rn]/g, ' ').replace(/\s*[\r\n]+\s*/g, ' ').replace(/ {2,}/g, ' ').trim();
}

/** Lines of a bubble's original joined into one: the line breaks are layout, not meaning. */
export function joinLines(text: string): string {
  return text
    .replace(/\\+[rn]/g, '\n')
    .split(/\s*\n\s*/)
    .filter(Boolean)
    .reduce((acc, line) => (!acc ? line : /[\u3000-\u9fff\uac00-\ud7af]$/.test(acc) && /^[\u3000-\u9fff\uac00-\ud7af]/.test(line) ? acc + line : /-$/.test(acc) && /^\p{Ll}/u.test(line) ? acc.slice(0, -1) + line : `${acc} ${line}`), '');
}

export function normalizeType(value: unknown, fallback: TextType = 'DIALOGUE'): TextType {
  const v = typeof value === 'string' ? value.toUpperCase() : '';
  if ((TEXT_TYPES as string[]).includes(v)) return v as TextType;
  if (v === 'SPEECH' || v === 'BUBBLE') return 'DIALOGUE';
  if (v === 'CAPTION') return 'NARRATION';
  if (v === 'SOUND' || v === 'ONOMATOPOEIA') return 'SFX';
  return fallback;
}

export interface VisionBlock {
  /** Box normalised 0–1000: x0, y0, x1, y1. */
  box: [number, number, number, number];
  text: string;
  translation?: string;
  type: TextType;
  vertical: boolean;
  speaker?: string;
  gender?: 'male' | 'female' | 'unknown';
}

export interface VisionAnswer {
  blocks: VisionBlock[];
  entities: unknown[];
  summary: string;
  /** The answer was cut off or malformed and had to be mended: its blocks are less certain. */
  repaired?: boolean;
}

export const MAX_BLOCKS_PER_PAGE = 200;

export function parseVisionAnswer(raw: string, expectTranslation: boolean, repair = true): VisionAnswer {
  const { value, repaired } = extractJsonInfo(raw, { repair });
  const json = (value ?? {}) as Record<string, unknown>;
  const arr = Array.isArray(json.blocks) ? json.blocks : Array.isArray(json) ? (json as unknown[]) : null;
  if (!arr) throw new AppError('TRANSLATION_INVALID_OUTPUT', { detail: 'Missing "blocks" array' });
  // A bare array that holds no objects is not an answer (an empty one is: no text on the page).
  if (arr.length && !arr.some((x) => x && typeof x === 'object')) throw new AppError('TRANSLATION_INVALID_OUTPUT', { detail: 'No blocks in answer' });
  const blocks: VisionBlock[] = [];
  for (const item of arr.slice(0, MAX_BLOCKS_PER_PAGE)) {
    if (!item || typeof item !== 'object') continue;
    const b = item as Record<string, unknown>;
    const box = Array.isArray(b.box) ? b.box.map(Number) : Array.isArray(b.bbox) ? (b.bbox as unknown[]).map(Number) : null;
    if (!box || box.length !== 4 || box.some((n) => !Number.isFinite(n))) continue;
    let [x0, y0, x1, y1] = box;
    if (x1 < x0) [x0, x1] = [x1, x0];
    if (y1 < y0) [y0, y1] = [y1, y0];
    const clamp = (n: number) => Math.max(0, Math.min(1000, n));
    x0 = clamp(x0); y0 = clamp(y0); x1 = clamp(x1); y1 = clamp(y1);
    if (x1 - x0 < 2 || y1 - y0 < 2) continue;
    const text = sanitizeText(b.text, 1000);
    if (!text) continue;
    const translation = cleanTranslation(b.translation, 1500);
    blocks.push({
      box: [x0, y0, x1, y1],
      text,
      translation: expectTranslation ? limitLength(translation || text, text) : undefined,
      type: normalizeType(b.type),
      vertical: b.vertical === true,
      speaker: sanitizeText(b.speaker, 60) || undefined,
      gender: b.gender === 'male' || b.gender === 'female' ? b.gender : undefined,
    });
  }
  return {
    blocks,
    entities: Array.isArray(json.entities) ? (json.entities as unknown[]).slice(0, 50) : [],
    summary: sanitizeLine(json.summary, 400),
    ...(repaired ? { repaired } : {}),
  };
}

export interface TranslationAnswer {
  translations: Map<string, { text: string; type?: TextType }>;
  entities: unknown[];
  summary: string;
  missing: string[];
  /** The answer was cut off or malformed and had to be mended. */
  repaired?: boolean;
}

/** A translation far longer than its source is a sign of injection or rambling; cap it. */
export function limitLength(translation: string, original: string): string {
  const max = Math.max(60, original.length * 6);
  return translation.length > max ? translation.slice(0, max) : translation;
}

export function parseTranslationAnswer(raw: string, expected: { id: string; text: string }[], repair = true): TranslationAnswer {
  const { value, repaired } = extractJsonInfo(raw, { repair });
  const json = (value ?? {}) as Record<string, unknown>;
  const arr = Array.isArray(json) ? (json as unknown[]) : Array.isArray(json.translations) ? (json.translations as unknown[]) : Array.isArray(json.blocks) ? (json.blocks as unknown[]) : null;
  if (!arr) throw new AppError('TRANSLATION_INVALID_OUTPUT', { detail: 'Missing "translations" array' });
  const byId = new Map(expected.map((e) => [e.id, e.text]));
  const translations = new Map<string, { text: string; type?: TextType }>();
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const t = item as Record<string, unknown>;
    const id = typeof t.id === 'string' ? t.id : typeof t.id === 'number' ? String(t.id) : '';
    if (!byId.has(id) || translations.has(id)) continue;
    // "translation" wins when both are given: a model mixing in the picture-reading format writes
    // the original into "text" and the translation into "translation".
    const text = cleanTranslation(typeof t.translation === 'string' && t.translation.trim() ? t.translation : t.text, 1500);
    if (!text) continue;
    translations.set(id, { text: limitLength(text, byId.get(id)!), type: t.type ? normalizeType(t.type) : undefined });
  }
  const missing = expected.filter((e) => !translations.has(e.id)).map((e) => e.id);
  if (expected.length > 0 && missing.length / expected.length > 0.3) {
    throw new AppError('TRANSLATION_INVALID_OUTPUT', { detail: `Missing translations for ${missing.length}/${expected.length} blocks` });
  }
  return {
    translations,
    entities: Array.isArray(json.entities) ? (json.entities as unknown[]).slice(0, 50) : [],
    summary: sanitizeLine(json.summary, 400),
    missing,
    ...(repaired ? { repaired } : {}),
  };
}
