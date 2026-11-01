import { chapterPlace, type HistoryEntry } from '@ait/core';
import { tr } from '@ait/core/i18n';

/**
 * The history as folders for the editor: one folder per series (the site's title of it, see core
 * series.ts), its chapters by number; a chapter's pages in the order they were first translated,
 * each once. Pictures opened in the studio itself (no address) are a folder of their own, last.
 * Series newest first; failed pages are left out.
 */

export interface ChapterFolder {
  url: string;
  title: string;
  /** The chapter's number on the site, when the address or the title gives it. */
  number?: number;
  /** Result keys of the translated pages, in reading order. */
  keys: string[];
  /** The latest history record of each page (failed ones too when asked for), in reading order. */
  entries: HistoryEntry[];
  /** Pictures in it (a strip glued from several counts as all of them). */
  pages: number;
  /** When a page of it was last translated. */
  last: string;
}

export interface SeriesFolder {
  key: string;
  name: string;
  /** Host name; '' for pictures opened in the studio. */
  site: string;
  chapters: ChapterFolder[];
  last: string;
}

const STUDIO = '';

export function groupHistory(entries: HistoryEntry[], opts: { failed?: boolean } = {}): SeriesFolder[] {
  const series = new Map<string, SeriesFolder & { byId: Map<string, ChapterFolder & { latest: Map<string, HistoryEntry> }> }>();
  const taken = entries.filter((e) => e.status === 'done' || opts.failed).sort((a, b) => a.date.localeCompare(b.date));
  for (const e of taken) {
    let url = '';
    let site = '';
    try {
      const u = new URL(e.url ?? '');
      u.hash = '';
      url = u.href;
      site = u.hostname;
    } catch {
      /* a picture opened in the studio */
    }
    const place = url ? chapterPlace(url, e.title) : null;
    const key = place?.series ?? STUDIO;
    const s = series.get(key) ?? { key, name: '', site, chapters: [], last: e.date, byId: new Map() };
    series.set(key, s);
    if (place?.name) s.name = place.name;
    const id = url || `key:${e.key}`;
    const c = s.byId.get(id) ?? { url, title: '', number: place?.number, keys: [], entries: [], latest: new Map<string, HistoryEntry>(), pages: 0, last: e.date };
    s.byId.set(id, c);
    // Reading order: the order pages were first seen; each page shows its latest record.
    if (!c.latest.has(e.key)) c.entries.push(e);
    c.latest.set(e.key, e);
    if (e.status === 'done' && !c.keys.includes(e.key)) {
      c.keys.push(e.key);
      c.pages += Math.max(1, e.pages || 1);
    }
    if (e.title) c.title = e.title;
    if (e.date > c.last) c.last = e.date;
    if (e.date > s.last) s.last = e.date;
  }
  const byNumber = (a: ChapterFolder, b: ChapterFolder) => (a.number ?? Infinity) - (b.number ?? Infinity) || a.last.localeCompare(b.last);
  return [...series.values()]
    .map(({ byId, ...s }) => ({
      ...s,
      name: s.key === STUDIO ? tr('Открытые в студии') : s.name || s.site,
      chapters: [...byId.values()].map(({ latest, ...c }) => ({ ...c, entries: c.entries.map((x) => latest.get(x.key)!), title: c.title || c.url.replace(/^https?:\/\//, '').replace(/\/$/, '') })).sort(byNumber),
    }))
    .sort((a, b) => (a.key === STUDIO ? 1 : b.key === STUDIO ? -1 : b.last.localeCompare(a.last)));
}
