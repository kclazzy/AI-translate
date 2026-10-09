import { AppError } from '../errors';
import type { TextType } from '../types';
import { TEXT_TYPES } from '../types';

/** Extract the first JSON object from a model answer (tolerates code fences and chatter). */
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
  // Best: everything up to the last whole element; else close what is open.
  if (safe) tries.push(out.slice(0, safe[0]).replace(/,\s*$/, '') + close([...safe[1]]));
  if (inStr) tries.push(out + '"' + close([...stack]));
  tries.push(out + close([...stack]));
  for (const t of tries) {
    try {
      return JSON.parse(t.replace(/,\s*([}\]])/g, '$1'));
    } catch {
      /* next */
    }
  }
  return null;
}

export function extractJson(text: string): unknown {
  let s = text.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  if (fence) s = fence[1].trim();
  const brace = s.indexOf('{');
  const bracket = s.indexOf('[');
  // A bare array answer ([{…},{…}]) is parsed whole, not as its first element.
  const start = bracket >= 0 && (brace < 0 || bracket < brace) ? bracket : brace;
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
    return JSON.parse(candidate);
  } catch {
    // Common model slips: trailing commas.
    try {
      return JSON.parse(candidate.replace(/,\s*([}\]])/g, '$1'));
    } catch (e) {
      // The answer was cut off (the model ran out of room) or has raw line breaks in a string:
      // keep everything complete before the cut instead of losing the whole page.
      const fixed = repairJson(candidate);
      if (fixed !== null) return fixed;
      throw new AppError('TRANSLATION_INVALID_OUTPUT', { detail: `Invalid JSON: ${(e as Error).message}` });
    }
  }
}

/** Remove control characters and cap length; OCR/LLM output is untrusted. */
export function sanitizeText(value: unknown, maxLen = 2000): string {
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‏‪-‮⁦-⁩]/g, '').trim().slice(0, maxLen);
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
}

export const MAX_BLOCKS_PER_PAGE = 200;

export function parseVisionAnswer(raw: string, expectTranslation: boolean): VisionAnswer {
  const json = extractJson(raw) as Record<string, unknown>;
  const arr = Array.isArray(json.blocks) ? json.blocks : Array.isArray(json) ? (json as unknown[]) : null;
  if (!arr) throw new AppError('TRANSLATION_INVALID_OUTPUT', { detail: 'Missing "blocks" array' });
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
    const translation = sanitizeText(b.translation, 1500);
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
    summary: sanitizeText(json.summary, 400),
  };
}

export interface TranslationAnswer {
  translations: Map<string, { text: string; type?: TextType }>;
  entities: unknown[];
  summary: string;
  missing: string[];
}

/** A translation far longer than its source is a sign of injection or rambling; cap it. */
export function limitLength(translation: string, original: string): string {
  const max = Math.max(60, original.length * 6);
  return translation.length > max ? translation.slice(0, max) : translation;
}

export function parseTranslationAnswer(raw: string, expected: { id: string; text: string }[]): TranslationAnswer {
  const json = extractJson(raw) as Record<string, unknown>;
  const arr = Array.isArray(json) ? (json as unknown[]) : Array.isArray(json.translations) ? (json.translations as unknown[]) : Array.isArray(json.blocks) ? (json.blocks as unknown[]) : null;
  if (!arr) throw new AppError('TRANSLATION_INVALID_OUTPUT', { detail: 'Missing "translations" array' });
  const byId = new Map(expected.map((e) => [e.id, e.text]));
  const translations = new Map<string, { text: string; type?: TextType }>();
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const t = item as Record<string, unknown>;
    const id = typeof t.id === 'string' ? t.id : typeof t.id === 'number' ? String(t.id) : '';
    if (!byId.has(id) || translations.has(id)) continue;
    const text = sanitizeText(t.text ?? t.translation, 1500);
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
    summary: sanitizeText(json.summary, 400),
    missing,
  };
}
