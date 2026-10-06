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
  const source = typeof r.source === 'string' ? r.source.trim().slice(0, 80) : '';
  const target = typeof r.target === 'string' ? r.target.trim().slice(0, 80) : '';
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
export function mergeContext(
  ctx: TranslationContext,
  update: { entities?: unknown[]; summary?: string; lines?: { src: string; dst: string }[] },
): TranslationContext {
  const entities = [...ctx.entities];
  const index = new Map(entities.map((e, i) => [e.source, i]));
  for (const raw of update.entities ?? []) {
    const e = normalizeEntity(raw, ctx.pagesSeen + 1);
    if (!e) continue;
    const at = index.get(e.source);
    if (at === undefined) {
      if (entities.length < CONTEXT_LIMITS.entities) {
        index.set(e.source, entities.length);
        entities.push(e);
      }
    } else {
      const cur = entities[at];
      if (!cur.locked && !cur.gender && e.gender) entities[at] = { ...cur, gender: e.gender };
    }
  }
  const summaries = [...ctx.summaries];
  if (update.summary && update.summary.trim()) summaries.push(update.summary.trim().slice(0, CONTEXT_LIMITS.summaryChars));
  while (summaries.length > CONTEXT_LIMITS.summaries) {
    // Compress the two oldest summaries into one so long chapters keep a bounded prompt.
    const merged = `${summaries[0]} ${summaries[1]}`.slice(0, CONTEXT_LIMITS.summaryChars);
    summaries.splice(0, 2, merged);
  }
  const recentLines = [...ctx.recentLines, ...(update.lines ?? [])].slice(-CONTEXT_LIMITS.recentLines);
  return { ...ctx, entities, summaries, recentLines, pagesSeen: ctx.pagesSeen + 1, updatedAt: new Date().toISOString() };
}

export function upsertEntity(ctx: TranslationContext, entity: ContextEntity): TranslationContext {
  const entities = ctx.entities.filter((e) => e.source !== entity.source);
  entities.push(entity);
  return { ...ctx, entities, updatedAt: new Date().toISOString() };
}

export function removeEntity(ctx: TranslationContext, source: string): TranslationContext {
  return { ...ctx, entities: ctx.entities.filter((e) => e.source !== source), updatedAt: new Date().toISOString() };
}
