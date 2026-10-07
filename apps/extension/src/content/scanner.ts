/** Finding translatable images on arbitrary pages (img, CSS backgrounds, canvas, lazy loading). */

export type CandidateKind = 'img' | 'background' | 'canvas';

export interface Candidate {
  el: Element;
  kind: CandidateKind;
  src?: string;
}

const UI_ATTR = 'data-ait-ui';
const URL_RE = /url\(["']?([^"')]+)["']?\)/;

export function isOurUi(el: Element | null): boolean {
  return !!el?.closest(`[${UI_ATTR}]`);
}

export function markUi(el: HTMLElement): void {
  el.setAttribute(UI_ATTR, '');
}

export function imgSrc(img: HTMLImageElement): string {
  return img.currentSrc || img.src || '';
}

function bigEnough(w: number, h: number, displayW: number, displayH: number, min: number): boolean {
  // Long webtoon strips are narrow-ish but very tall; regular pages are large in both directions.
  const natural = (w >= min && h >= min) || (w >= min * 0.8 && h >= min * 3);
  return natural && displayW >= Math.min(140, min * 0.6) && displayH >= 80;
}

export function backgroundUrl(el: Element): string | null {
  const bg = getComputedStyle(el).backgroundImage;
  if (!bg || bg === 'none') return null;
  const m = URL_RE.exec(bg);
  return m ? m[1] : null;
}

const LAZY_ATTRS = ['data-url', 'data-src', 'data-original', 'data-lazy-src', 'data-lazy', 'data-srcset'];

/**
 * Readers that load pictures as you scroll (Webtoons: <img src="placeholder" data-url="…">)
 * keep the real address in a data attribute until then. Returns it while the placeholder shows.
 */
export function lazySrc(img: HTMLImageElement): string | null {
  for (const a of LAZY_ATTRS) {
    const v = img.getAttribute(a)?.trim().split(/\s+/)[0];
    if (!v || v.startsWith('data:')) continue;
    let url: string;
    try {
      url = new URL(v, location.href).href;
    } catch {
      continue;
    }
    const cur = imgSrc(img);
    const placeholder = !cur || !img.complete || img.naturalWidth < 50 || /transparen|blank|placeholder|spacer|loading/i.test(cur);
    if (url !== cur && placeholder) return url;
  }
  return null;
}

export function asCandidate(el: Element, min: number): Candidate | null {
  if (isOurUi(el)) return null;
  if (el instanceof HTMLImageElement) {
    const lazy = lazySrc(el);
    if (lazy) {
      // Not loaded yet: judge by the size the page reserves for it (or its width/height attributes).
      const r = el.getBoundingClientRect();
      const w = Math.max(r.width, Number(el.getAttribute('width')) || 0);
      const h = Math.max(r.height, Number(el.getAttribute('height')) || 0);
      if (w < Math.min(140, min * 0.6) || h < 80) return null;
      return { el, kind: 'img', src: lazy };
    }
    const src = imgSrc(el);
    if (!src || !el.complete || src.startsWith('data:image/gif') || src.startsWith('data:image/svg')) return null;
    const r = el.getBoundingClientRect();
    if (!bigEnough(el.naturalWidth, el.naturalHeight, r.width, r.height, min)) return null;
    return { el, kind: 'img', src };
  }
  if (el instanceof HTMLCanvasElement) {
    const r = el.getBoundingClientRect();
    if (!bigEnough(el.width, el.height, r.width, r.height, min)) return null;
    return { el, kind: 'canvas' };
  }
  if (el instanceof HTMLElement) {
    const url = backgroundUrl(el);
    if (!url || url.startsWith('data:image/svg')) return null;
    const r = el.getBoundingClientRect();
    if (r.width < min || r.height < min) return null;
    return { el, kind: 'background', src: new URL(url, location.href).href };
  }
  return null;
}

/** All candidates in document order. Background images are only checked on block elements. */
export function scanPage(min: number, root: ParentNode = document): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<Element>();
  root.querySelectorAll('img, canvas').forEach((el) => {
    const c = asCandidate(el, min);
    if (c) {
      out.push(c);
      seen.add(el);
    }
  });
  let checked = 0;
  root.querySelectorAll<HTMLElement>('div, section, figure, a, span, li').forEach((el) => {
    if (checked > 4000 || seen.has(el)) return;
    if (el.offsetWidth < min || el.offsetHeight < min) return;
    checked++;
    const c = asCandidate(el, min);
    if (c && c.kind === 'background') out.push(c);
  });
  out.sort((a, b) => (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  return out;
}

/** Topmost candidate under a point, looking through transparent overlays readers put on top. */
export function candidateAt(x: number, y: number, min: number): Candidate | null {
  for (const el of document.elementsFromPoint(x, y)) {
    if (isOurUi(el)) continue;
    const c = asCandidate(el, min);
    if (c) return c;
  }
  return null;
}

/** Read inline image data when fetching by URL is impossible (blob:, same-origin canvas). */
export async function inlineData(c: Candidate): Promise<string | undefined> {
  try {
    if (c.kind === 'canvas') return (c.el as HTMLCanvasElement).toDataURL('image/png');
    if (c.kind === 'img' && c.src?.startsWith('blob:')) {
      const img = c.el as HTMLImageElement;
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext('2d')!.drawImage(img, 0, 0);
      return canvas.toDataURL('image/png');
    }
  } catch {
    /* tainted canvas: the background falls back to a screenshot */
  }
  return undefined;
}

export function viewportRect(el: Element): { x: number; y: number; width: number; height: number } | undefined {
  const r = el.getBoundingClientRect();
  const fully = r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth;
  if (!fully || r.width < 20 || r.height < 20) return undefined;
  return { x: r.left, y: r.top, width: r.width, height: r.height };
}

/**
 * The pictures of the chapter itself: readers show the pages as one column of pictures of the
 * same width (a webtoon strip, a manga reader). Banners, thumbnails of other episodes, avatars and
 * ads sit elsewhere or have other sizes. Returns the column with the most picture area.
 */
export function chapterColumn<T extends { el: Element }>(cands: T[]): T[] {
  if (cands.length <= 1) return cands;
  const groups = new Map<string, { items: T[]; area: number }>();
  for (const c of cands) {
    const r = c.el.getBoundingClientRect();
    if (r.width < 2) continue;
    // Same column: same left edge and width, to within a few pixels.
    const key = `${Math.round((r.left + scrollX) / 8)}|${Math.round(r.width / 8)}`;
    const g = groups.get(key) ?? { items: [], area: 0 };
    g.items.push(c);
    g.area += r.width * r.height;
    groups.set(key, g);
  }
  let best: { items: T[]; area: number } | null = null;
  for (const g of groups.values()) if (!best || g.area > best.area) best = g;
  return best?.items ?? cands;
}
