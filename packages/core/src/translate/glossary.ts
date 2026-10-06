export interface GlossaryEntry {
  id: string;
  source: string;
  target: string;
  matchMode: 'exact' | 'regex';
  caseSensitive: boolean;
  /** Translations the model must not use for this term (e.g. "Tanaka-san"). */
  forbidden: string[];
  note?: string;
  enabled: boolean;
}

export interface GlossaryHit {
  entry: GlossaryEntry;
  matched: string;
}

const MAX_REGEX_LENGTH = 200;

function buildRegex(entry: GlossaryEntry): RegExp | null {
  try {
    if (entry.matchMode === 'regex') {
      if (entry.source.length > MAX_REGEX_LENGTH) return null;
      return new RegExp(entry.source, entry.caseSensitive ? 'gu' : 'giu');
    }
    const escaped = entry.source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(escaped, entry.caseSensitive ? 'gu' : 'giu');
  } catch {
    return null;
  }
}

/** Glossary terms that occur in a source text; passed to the model as hints. */
export function findGlossaryHits(text: string, entries: GlossaryEntry[]): GlossaryHit[] {
  const hits: GlossaryHit[] = [];
  for (const entry of entries) {
    if (!entry.enabled || !entry.source) continue;
    const re = buildRegex(entry);
    if (!re) continue;
    const m = re.exec(text);
    if (m) hits.push({ entry, matched: m[0] });
  }
  return hits;
}

export interface GlossaryViolation {
  entry: GlossaryEntry;
  found: string;
}

/** Forbidden translations present in the output. */
export function findViolations(translation: string, hits: GlossaryHit[]): GlossaryViolation[] {
  const out: GlossaryViolation[] = [];
  const lower = translation.toLowerCase();
  for (const { entry } of hits) {
    for (const bad of entry.forbidden) {
      if (!bad) continue;
      const found = entry.caseSensitive ? translation.includes(bad) : lower.includes(bad.toLowerCase());
      if (found) out.push({ entry, found: bad });
    }
  }
  return out;
}

/**
 * Deterministic fix-up used when the model ignores a forbidden rule twice:
 * replaces the forbidden form with the preferred target.
 */
export function applyForbiddenFixes(translation: string, violations: GlossaryViolation[]): string {
  let out = translation;
  for (const v of violations) {
    const escaped = v.found.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(escaped, v.entry.caseSensitive ? 'g' : 'gi'), v.entry.target);
  }
  return out;
}

/** Global find & replace over translated texts (project-wide). */
export function replaceInText(text: string, find: string, replace: string, opts: { caseSensitive?: boolean; regex?: boolean; wholeWord?: boolean } = {}): { text: string; count: number } {
  if (!find) return { text, count: 0 };
  let pattern = opts.regex ? find : find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (opts.wholeWord) pattern = `(?<![\\p{L}\\p{N}])${pattern}(?![\\p{L}\\p{N}])`;
  let re: RegExp;
  try {
    re = new RegExp(pattern, opts.caseSensitive ? 'gu' : 'giu');
  } catch {
    return { text, count: 0 };
  }
  let count = 0;
  const out = text.replace(re, () => {
    count++;
    return replace;
  });
  return { text: out, count };
}
