import { tr } from '../i18n';
import type { FetchLike } from './types';
import type { ModelTier } from './discover';

/**
 * Local models change every few months. The list of recommended models and the settings each
 * model family needs live in models.json in the repository; the app fetches it with the update
 * check and falls back to the list built into this version.
 */
export interface FamilyRule {
  /** Regular expression matched against the model name (case-insensitive). */
  match: string;
  /** Turn the model's "thinking" off (faster, the answer is plain JSON). */
  noThinking?: boolean;
  /** Context size for Ollama (tokens). */
  numCtx?: number;
  /** Longest side of the picture sent to the model (pixels). */
  maxSide?: number;
  /** How the model gives coordinates: 0–1000 normalised (default) or pixels of the sent picture. */
  coords?: 'norm1000' | 'pixels';
  note?: string;
}

export interface ModelCatalog {
  version: 1;
  updated: string;
  tiers: ModelTier[];
  families: FamilyRule[];
}

export const CATALOG_URL = 'https://raw.githubusercontent.com/kclazzy/AI-translate/main/models.json';

export const BUILTIN_FAMILIES: FamilyRule[] = [
  { match: 'qwen3\\.5|qwen3-vl|qwen3vl', noThinking: true, coords: 'norm1000' },
  { match: 'qwen2\\.5-?vl', noThinking: true },
  { match: 'gemma3', coords: 'norm1000' },
];

let active: ModelCatalog | null = null;

/** Accept a catalog only if it has the expected shape (a broken file must not break the app). */
export function validCatalog(x: unknown): x is ModelCatalog {
  const c = x as ModelCatalog;
  if (!c || c.version !== 1 || !Array.isArray(c.tiers) || !Array.isArray(c.families) || !c.tiers.length) return false;
  const tierOk = (t: ModelTier) => typeof t.model === 'string' && /^[\w.:\-/]+$/.test(t.model) && typeof t.vramGb === 'number' && typeof t.sizeGb === 'number' && typeof t.quality === 'string';
  const famOk = (f: FamilyRule) => {
    if (typeof f.match !== 'string') return false;
    try {
      new RegExp(f.match, 'i');
      return true;
    } catch {
      return false;
    }
  };
  return c.tiers.every(tierOk) && c.families.every(famOk);
}

export function setCatalog(c: ModelCatalog | null | undefined): boolean {
  if (c && !validCatalog(c)) return false;
  active = c ?? null;
  return true;
}

export function activeCatalog(): ModelCatalog | null {
  return active;
}

/** Settings for a model's family: from the downloaded catalog first, then the built-in rules. */
export function familyFor(model: string): FamilyRule | undefined {
  for (const list of [active?.families ?? [], BUILTIN_FAMILIES]) {
    const f = list.find((r) => new RegExp(r.match, 'i').test(model));
    if (f) return f;
  }
  return undefined;
}

export async function fetchCatalog(fetchImpl: FetchLike = (u, i) => fetch(u, i), url = CATALOG_URL): Promise<ModelCatalog | null> {
  try {
    const res = await fetchImpl(url, { cache: 'no-store' } as RequestInit);
    if (!res.ok) return null;
    const json = await res.json();
    return validCatalog(json) ? json : null;
  } catch {
    return null;
  }
}

/** Base name and size of an Ollama tag: "qwen3.5:9b-q4_K_M" → family "qwen3.5". */
const familyOf = (m: string) => m.split(':')[0].toLowerCase();

/**
 * A recommended model for this card that is better than the one in use: a newer family, or the
 * same family's recommended size for this much video memory when the current one is smaller.
 */
export function betterModel(current: string, tiers: ModelTier[], vramGb: number): ModelTier | undefined {
  let rec = tiers[0];
  for (const t of tiers) if (t.vramGb <= vramGb) rec = t;
  if (!rec || rec.model.toLowerCase() === current.toLowerCase()) return undefined;
  const cur = tiers.find((t) => t.model.toLowerCase() === current.toLowerCase());
  if (cur) return cur.vramGb < rec.vramGb ? rec : undefined;
  // Not in the list at all: an older family the list no longer recommends.
  return familyOf(current) !== familyOf(rec.model) ? rec : undefined;
}

export const catalogNote = () => tr('Список моделей обновлён');
