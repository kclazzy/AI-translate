/**
 * Which series and which chapter a page of a site is, from its address and title: the series keeps
 * one translation context (names, terms), and the studio's folders go series → chapter by number.
 */

/** Query parameters that name the series itself (Webtoons title_no, Naver titleId, …). */
const SERIES_PARAMS = ['title_no', 'titleId', 'title_id', 'series_id', 'seriesId', 'comic_id', 'comicId', 'manga_id', 'mangaId'];
const CHAPTER_PARAMS = ['episode_no', 'episodeNo', 'chapter', 'chapter_no', 'ch', 'ep', 'no'];
/** A path segment that is the chapter: episode-1, chapter_12, ch12, c5, glava-3, or just a number. */
const CHAPTER_SEGMENT = /^(?:episode|ep|chapter|chap|ch|c|glava|глава|issue|vol)[-_.]?(\d+(?:\.\d+)?)$/i;
/** «глава 131», «Chapter 12», «Ch. 12.5», «Episode 2», «Ep 3», «эпизод 4», «#7». */
const CHAPTER_IN_TITLE = /(?:глава|chapter|chap\.?|ch\.?|episode|ep\.?|эпизод|серия|#)\s*(\d+(?:\.\d+)?)/i;

function parse(url: string | undefined): URL | null {
  if (!url) return null;
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** Where the chapter's segment is in the path (-1: none). */
function chapterSegment(parts: string[]): number {
  return parts.findIndex((p, i) => CHAPTER_SEGMENT.test(p) || (i >= 1 && /^\d+$/.test(p)));
}

export function seriesKeyFromUrl(url: string | undefined): string | undefined {
  const u = parse(url);
  if (!u) return undefined;
  for (const k of SERIES_PARAMS) {
    const v = u.searchParams.get(k);
    if (v) return `${u.hostname}/~${k}=${v}`;
  }
  const parts = u.pathname.split('/').filter(Boolean);
  const at = chapterSegment(parts);
  return `${u.hostname}/${(at >= 1 ? parts.slice(0, at) : parts.slice(0, 2)).join('/')}`;
}

const pretty = (slug: string) =>
  decodeURIComponent(slug)
    .replace(/[-_]+/g, ' ')
    .trim()
    .replace(/\b\p{L}/gu, (c) => c.toUpperCase());

/** The chapter's number and the series' name (title without the chapter part, else the address' slug). */
export function chapterPlace(url: string | undefined, title = ''): { series?: string; name: string; number?: number } {
  const u = parse(url);
  let number: number | undefined;
  let slug = '';
  if (u) {
    for (const k of CHAPTER_PARAMS) {
      const v = Number(u.searchParams.get(k));
      if (u.searchParams.has(k) && Number.isFinite(v)) {
        number = v;
        break;
      }
    }
    const parts = u.pathname.split('/').filter(Boolean);
    const at = chapterSegment(parts);
    if (at >= 0) {
      // A bare number in the path is often the chapter's id on the site, not its number.
      const m = CHAPTER_SEGMENT.exec(parts[at]);
      if (m) number ??= Number(m[1]);
      if (at >= 1) slug = parts[at - 1];
    }
  }
  const inTitle = CHAPTER_IN_TITLE.exec(title);
  if (number === undefined && inTitle) number = Number(inTitle[1]);
  let name = '';
  if (inTitle) {
    const rest = title.replace(inTitle[0], ' ').split(/\s[|–—-]\s|\s[|–—-]$|^[|–—-]\s|\s\|/).map((s) => s.trim().replace(/^[|–—:-]+|[|–—:-]+$/g, '').trim());
    name = rest.reduce((a, b) => (b.length > a.length ? b : a), '');
  }
  if (!name && slug) name = pretty(slug);
  if (!name) name = title.trim() || u?.hostname || '';
  return { series: seriesKeyFromUrl(url), name, number };
}
