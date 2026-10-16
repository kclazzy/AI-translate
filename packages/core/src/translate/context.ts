import { sanitizeLine } from './parse';

export type EntityKind = 'character' | 'place' | 'term' | 'ability' | 'item' | 'organization' | 'title';

export interface ContextEntity {
  source: string;
  target: string;
  kind: EntityKind;
  gender?: 'male' | 'female' | 'other' | 'unknown';
  pronouns?: string;
  speechStyle?: string;
  note?: string;
  /** Locked by the user: the model must use it and may not change it. */
  locked: boolean;
  firstSeenPage?: number;
}

export interface TranslationContext {
  id: string;
  title: string;
  entities: ContextEntity[];
  /** Rolling summaries of previous pages, oldest first. */
  summaries: string[];
  /** Recent dialogue lines for continuity. */
  recentLines: { src: string; dst: string }[];
  styleNotes: string;
  pagesSeen: number;
  /** Pages already merged (image hash prefixes, newest last): a page translated again adds no second summary or lines. */
  mergedPages?: string[];
  updatedAt: string;
}

export const CONTEXT_LIMITS = {
  summaries: 8,
  recentLines: 16,
  entities: 300,
  summaryChars: 400,
};

export function emptyContext(id: string, title = ''): TranslationContext {
  return { id, title, entities: [], summaries: [], recentLines: [], styleNotes: '', pagesSeen: 0, updatedAt: new Date().toISOString() };
}

const KINDS: EntityKind[] = ['character', 'place', 'term', 'ability', 'item', 'organization', 'title'];

export function normalizeEntity(raw: unknown, page?: number): ContextEntity | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  // Learned from a model answer, i.e. from text on the page: untrusted, one short line each.
  const source = sanitizeLine(r.source, 80);
  const target = sanitizeLine(r.target, 80);
  if (!source || !target) return null;
  const kind = KINDS.includes(r.kind as EntityKind) ? (r.kind as EntityKind) : 'term';
  const g = r.gender;
  const gender = g === 'male' || g === 'female' || g === 'other' ? g : undefined;
  return { source, target, kind, gender, locked: false, firstSeenPage: page };
}

/**
 * Merge what the model learned from one page into the context.
 * Locked entities are never overwritten; unlocked ones keep their first translation
 * so names stay consistent across a chapter.
 */
export interface ContextUpdate {
  /** The page this came from (image hash prefix); see TranslationContext.mergedPages. */
  page?: string;
  entities?: unknown[];
  summary?: string;
  lines?: { src: string; dst: string }[];
}

/**
 * Key that treats spellings of one term as the same: case, edge punctuation and an English plural
 * (CHANTER, Chanter, Chanters → "chanter").
 */
export function entityKey(source: string): string {
  const k = source.toLowerCase().replace(/^[\s"'«»“”.,!?…:;()\[\]-]+|[\s"'«»“”.,!?…:;()\[\]-]+$/g, '').replace(/\s+/g, ' ');
  return /^[a-z][a-z' -]{3,}s$/.test(k) && !/ss$/.test(k) ? k.slice(0, -1) : k;
}

export function mergeContext(ctx: TranslationContext, update: ContextUpdate): TranslationContext {
  const entities = [...ctx.entities];
  const index = new Map(entities.map((e, i) => [entityKey(e.source), i]));
  const again = !!update.page && !!ctx.mergedPages?.includes(update.page);
  for (const raw of update.entities ?? []) {
    const e = normalizeEntity(raw, ctx.pagesSeen + 1);
    if (!e) continue;
    const at = index.get(entityKey(e.source));
    if (at === undefined) {
      if (entities.length < CONTEXT_LIMITS.entities) {
        index.set(entityKey(e.source), entities.length);
        entities.push(e);
      }
    } else {
      const cur = entities[at];
      if (!cur.locked && !cur.gender && e.gender) entities[at] = { ...cur, gender: e.gender };
    }
  }
  // The same page translated again (⟳, other settings): its story and lines are already in.
  if (again) return { ...ctx, entities, updatedAt: new Date().toISOString() };
  const summaries = [...ctx.summaries];
  const summary = sanitizeLine(update.summary, CONTEXT_LIMITS.summaryChars);
  if (summary) summaries.push(summary);
  while (summaries.length > CONTEXT_LIMITS.summaries) {
    // Compress the two oldest summaries into one so long chapters keep a bounded prompt.
    const merged = `${summaries[0]} ${summaries[1]}`.slice(0, CONTEXT_LIMITS.summaryChars);
    summaries.splice(0, 2, merged);
  }
  const lines = (update.lines ?? []).map((l) => ({ src: sanitizeLine(l.src, 300), dst: sanitizeLine(l.dst, 300) })).filter((l) => l.src && l.dst);
  const recentLines = [...ctx.recentLines, ...lines].slice(-CONTEXT_LIMITS.recentLines);
  const mergedPages = update.page ? [...(ctx.mergedPages ?? []), update.page].slice(-400) : ctx.mergedPages;
  return { ...ctx, entities, summaries, recentLines, pagesSeen: ctx.pagesSeen + 1, ...(mergedPages ? { mergedPages } : {}), updatedAt: new Date().toISOString() };
}

export function upsertEntity(ctx: TranslationContext, entity: ContextEntity): TranslationContext {
  const entities = ctx.entities.filter((e) => e.source !== entity.source);
  entities.push(entity);
  return { ...ctx, entities, updatedAt: new Date().toISOString() };
}

export function removeEntity(ctx: TranslationContext, source: string): TranslationContext {
  return { ...ctx, entities: ctx.entities.filter((e) => e.source !== source), updatedAt: new Date().toISOString() };
}
