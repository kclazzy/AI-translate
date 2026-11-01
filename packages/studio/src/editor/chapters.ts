import type { HistoryEntry } from '@ait/core';

/**
 * The history as folders for the editor: site → chapter → pages. A chapter is the page of a site the
 * pictures were translated on (its address without #…); its pages go in the order they were first
 * translated, each once. Pictures opened in the studio itself (no address) are a folder each, under
 * a site with no name. Newest first at both levels; failed pages are left out.
 */

export interface ChapterFolder {
  url: string;
  title: string;
  /** Result keys, in reading order. */
  keys: string[];
  /** Pictures in it (a strip glued from several counts as all of them). */
  pages: number;
  /** When a page of it was last translated. */
  last: string;
}

export interface SiteFolder {
  /** Host name; '' for pictures opened in the studio. */
  site: string;
  chapters: ChapterFolder[];
  last: string;
}

function place(url: string | undefined): { site: string; chapter: string } | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    u.hash = '';
    return { site: u.hostname, chapter: u.href };
  } catch {
    return null;
  }
}

export function groupHistory(entries: HistoryEntry[]): SiteFolder[] {
  const sites = new Map<string, Map<string, ChapterFolder>>();
  const done = entries.filter((e) => e.status === 'done').sort((a, b) => a.date.localeCompare(b.date));
  for (const e of done) {
    const at = place(e.url);
    const site = at?.site ?? '';
    const id = at?.chapter ?? `key:${e.key}`;
    const chapters = sites.get(site) ?? new Map<string, ChapterFolder>();
    sites.set(site, chapters);
    const c = chapters.get(id) ?? { url: at?.chapter ?? '', title: '', keys: [], pages: 0, last: e.date };
    chapters.set(id, c);
    if (!c.keys.includes(e.key)) {
      c.keys.push(e.key);
      c.pages += Math.max(1, e.pages || 1);
    }
    if (e.title) c.title = e.title;
    if (e.date > c.last) c.last = e.date;
  }
  const byLast = <T extends { last: string }>(a: T, b: T) => b.last.localeCompare(a.last);
  return [...sites.entries()]
    .map(([site, m]) => {
      const chapters = [...m.values()].map((c) => ({ ...c, title: c.title || c.url.replace(/^https?:\/\//, '').replace(/\/$/, '') })).sort(byLast);
      return { site, chapters, last: chapters[0].last };
    })
    .sort((a, b) => (a.site === '' ? 1 : b.site === '' ? -1 : byLast(a, b)));
}
