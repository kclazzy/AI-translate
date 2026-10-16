import { useEffect, useRef, useState } from 'react';
import { cropRows, pageForSpan, shiftBlock, tilesToImage, TiledImage, type AppSettings, type PageResult, type TextBlock, type Project, type ProjectPage } from '@ait/core';
import { usePlatform } from '../platform';
import { cropProjectPage, loadOriginalImage, rerenderProjectPage, type ProjectStore } from '../projects';
import { ErrorBox } from '../ui';
import { Editor } from './Editor';
import { confirmLeave } from './guard';
import { tr } from '@ait/core/i18n';

interface Loaded {
  page: PageResult;
  original: TiledImage;
  cleaned: TiledImage;
}

interface Segment {
  key: string;
  y: number;
  h: number;
  pageId: string;
  usage: PageResult['usage'];
}

/** A picture cut out of a glued strip is edited in its strip (the whole bubble is there). */
async function editableKey(service: ReturnType<typeof usePlatform>['service'], key: string): Promise<string> {
  const r = await service.getResult(key);
  return r?.strip?.parent ?? key;
}

/** A picture of the chapter that is not in the whole-chapter strip, and why. */
export interface Skipped {
  /** Its number in the chapter (1-based). */
  n: number;
  why: 'missing' | 'width' | 'window';
}

/**
 * Pixels of one whole-chapter strip (original + cleaned copies are held, ≈ 8 bytes a pixel): about
 * 45 pages of 800×1100. A longer chapter opens as the part around the page the user opened.
 */
export const STACK_MAX_PIXELS = 40_000_000;

/**
 * Stack several cached pages of one width into one tall page (whole-chapter editing). The width is
 * the one of `mainKey` (the page the user opened), so that page is always in the strip. The sizes
 * are read first and the pictures decoded one at a time, so a 300-page chapter never sits in memory.
 */
async function loadStack(platform: ReturnType<typeof usePlatform>, keys: string[], mainKey = keys[0]): Promise<Loaded & { segments: Segment[]; title: string; skipped: Skipped[] }> {
  type Meta = { key: string; n: number; width: number; height: number; pageId: string; usage: PageResult['usage']; title: string };
  const metas: Meta[] = [];
  const skipped: Skipped[] = [];
  for (const [i, k] of keys.entries()) {
    const r = await platform.service.getResult(k);
    if (r) metas.push({ key: r.key, n: i + 1, width: r.page.width, height: r.page.height, pageId: r.page.pageId, usage: r.page.usage, title: r.title || r.sourceUrl || '' });
    else skipped.push({ n: i + 1, why: 'missing' });
  }
  if (!metas.length) throw new Error(tr('Перевод не найден в кэше — переведите страницу ещё раз'));
  const mainAt = Math.max(0, metas.findIndex((x) => x.key === mainKey));
  const width = metas[mainAt].width;
  for (const x of metas) if (x.width !== width) skipped.push({ n: x.n, why: 'width' });
  // The pages of this width, the opened one and its neighbours while they fit.
  const same = metas.filter((x) => x.width === width);
  let lo = same.findIndex((x) => x.key === metas[mainAt].key);
  let hi = lo;
  let px = width * same[lo].height;
  for (let grew = true; grew; ) {
    grew = false;
    for (const side of [1, -1]) {
      const j = side > 0 ? hi + 1 : lo - 1;
      if (j < 0 || j >= same.length || px + width * same[j].height > STACK_MAX_PIXELS) continue;
      px += width * same[j].height;
      if (side > 0) hi = j;
      else lo = j;
      grew = true;
    }
  }
  for (const [j, x] of same.entries()) if (j < lo || j > hi) skipped.push({ n: x.n, why: 'window' });
  skipped.sort((a, b) => a.n - b.n);
  const chosen = same.slice(lo, hi + 1);
  const segments: Segment[] = [];
  let y = 0;
  for (const m of chosen) {
    segments.push({ key: m.key, y, h: m.height, pageId: m.pageId, usage: m.usage });
    y += m.height;
  }
  const original = new TiledImage(platform.backend, width, y);
  const cleaned = new TiledImage(platform.backend, width, y);
  const blocks = [];
  let first: PageResult | undefined;
  for (const [i, m] of chosen.entries()) {
    const s = segments[i];
    const r = await platform.service.getResult(m.key);
    if (!r) continue;
    first ??= r.page;
    const o = await platform.backend.decode(r.original.bytes, r.original.mime);
    for (const t of original.tiles) if (t.y < s.y + s.h && t.y + t.h > s.y) t.canvas.getContext('2d').drawImage(o.source, 0, 0, o.width, o.height, 0, s.y - t.y, width, s.h);
    o.close?.();
    for (const c of r.cleaned) {
      const img = await platform.backend.decode(c.bytes, 'image/png');
      for (const t of cleaned.tiles) if (t.y < s.y + c.y + c.h && t.y + t.h > s.y + c.y) t.canvas.getContext('2d').drawImage(img.source, 0, s.y + c.y - t.y);
      img.close?.();
    }
    // A block repeated in this picture only because its text crosses the seam belongs to its neighbour:
    // in the strip the neighbour's own block is there, so the copy is left out.
    blocks.push(...r.page.blocks.filter((b) => chosen.length === 1 || !(b as TextBlock & { continued?: boolean }).continued).map((b) => ({ ...shiftBlock(b, -s.y), id: `${i}:${b.id}` })));
  }
  const page: PageResult = { ...first!, height: y, blocks, usage: chosen.flatMap((m) => m.usage) };
  return { page, original, cleaned, segments, skipped, title: chosen[0].title };
}

/** «№3 (другая ширина), №50–300 (вне окна)»: runs of numbers with the same reason are joined. */
function compactSkipped(list: Skipped[]): string {
  const label = (why: Skipped['why']) => (why === 'width' ? tr('другая ширина') : why === 'window' ? tr('вне окна') : tr('не переведена'));
  const out: string[] = [];
  for (let i = 0; i < list.length; ) {
    let j = i;
    while (j + 1 < list.length && list[j + 1].why === list[i].why && list[j + 1].n === list[j].n + 1) j++;
    out.push(`№${list[i].n}${j > i ? `–${list[j].n}` : ''} (${label(list[i].why)})`);
    i = j + 1;
  }
  return out.join(', ');
}

/**
 * Edit a page that lives in the translation cache (opened from the page overlay or history).
 * With `chapterKeys` the whole chapter can be edited as one long page: a bubble that crosses
 * two pictures is one bubble here, and saving cuts the result back into the pictures.
 */
export function CachedPageEditor({ resultKey, chapterKeys, settings, onClose }: { resultKey: string; chapterKeys?: string[]; settings: AppSettings; onClose?: () => void }) {
  const platform = usePlatform();
  const [data, setData] = useState<(Loaded & { segments: Segment[]; skipped: Skipped[] }) | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [title, setTitle] = useState('');
  const [whole, setWhole] = useState(false);
  /** The texts of each picture as last stored (whole chapter): unchanged pictures are not saved again. */
  const saved = useRef(new Map<string, string>());
  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    (async () => {
      const main = await editableKey(platform.service, resultKey);
      let keys = [main];
      if (whole && chapterKeys?.length) {
        keys = [];
        for (const k of chapterKeys) {
          const e = await editableKey(platform.service, k);
          if (!keys.includes(e)) keys.push(e);
        }
      }
      const loaded = await loadStack(platform, keys, main);
      saved.current = new Map(
        loaded.segments.map((sg, i) => {
          const part = pageForSpan(loaded.page, sg, i);
          return [sg.key, JSON.stringify(part.blocks.map((b) => ({ ...b, id: b.id.replace(/^\d+:/, '') })))];
        }),
      );
      if (!cancelled) {
        setData(loaded);
        setTitle(loaded.title);
      }
    })().catch((e) => !cancelled && setError(e));
    return () => {
      cancelled = true;
    };
  }, [platform, resultKey, chapterKeys, whole]);
  if (error) return <ErrorBox error={error} />;
  if (!data) return <p className="ait-muted">{tr('Загрузка страницы…')}</p>;
  const changed = async (key: string) => {
    platform.notifyResultChanged?.(key);
    // The pictures on the site show the pieces of a glued strip.
    for (const p of (await platform.service.getResult(key))?.parts ?? []) platform.notifyResultChanged?.(p);
  };
  return (
    <Editor
      key={data.segments.map((s) => s.key).join(',')}
      title={title}
      page={data.page}
      original={data.original}
      cleaned={data.cleaned}
      settings={settings}
      onClose={onClose}
      marks={data.segments.length > 1 ? data.segments.slice(1).map((s) => s.y) : undefined}
      reportSource={async () => {
        if (data.segments.length !== 1) return undefined;
        const r = await platform.service.getResult(data.segments[0].key);
        return r ? { original: r.original, sourceUrl: r.sourceUrl } : undefined;
      }}
      chapterTexts={
        chapterKeys && chapterKeys.length > 1 && data.segments.length === 1
          ? async (current) => {
              const seen: string[] = [];
              const pages: TextBlock[][] = [];
              for (const k of chapterKeys) {
                const e = await editableKey(platform.service, k);
                if (seen.includes(e)) continue;
                seen.push(e);
                pages.push(e === data.segments[0].key ? current : (await platform.service.getResult(e))?.page.blocks ?? []);
              }
              return pages;
            }
          : undefined
      }
      toolbarExtra={
        chapterKeys && chapterKeys.length > 1 ? (
          <>
            <button
              className={`ait-btn small ${whole ? 'active' : ''}`}
              aria-pressed={whole}
              onClick={() => void confirmLeave().then((ok) => ok && setWhole(!whole))}
              title={tr('Все переведённые картинки главы одной лентой')}
            >
              {tr('Глава целиком')}
            </button>
            {whole && data.skipped.length ? (
              <span className="ait-notice ait-stack-skipped" data-testid="stack-skipped" role="status">
                {data.skipped.some((x) => x.why === 'window') ? tr('Глава длинная: открыта часть вокруг этой страницы ({0} стр.). ', data.segments.length) : ''}
                {tr('Не вошли в ленту: {0}', compactSkipped(data.skipped))}
              </span>
            ) : null}
          </>
        ) : null
      }
      onSave={async (page, cleaned, pixels, rows) => {
        for (const [i, s] of data.segments.entries()) {
          const part = pageForSpan(page, s, i);
          const own: PageResult = { ...part, pageId: s.pageId, usage: s.usage, blocks: part.blocks.map((b) => ({ ...b, id: b.id.replace(/^\d+:/, '') })) };
          // A whole chapter: only the pictures whose texts or pixels changed are drawn and stored again
          // (one changed word used to re-save all of them: 18 s for 100 pages).
          const touched = !!pixels && (!rows || rows.some(([a, b]) => a < s.y + s.h && b > s.y));
          const sig = JSON.stringify(own.blocks);
          if (data.segments.length > 1 && !touched && saved.current.get(s.key) === sig) continue;
          await platform.service.saveEdited(s.key, own, touched ? cropRows(cleaned, s.y, s.h) : undefined);
          saved.current.set(s.key, sig);
          await changed(s.key);
        }
      }}
    />
  );
}

/** Edit one page of a project. */
export function ProjectPageEditor({ store, project, page, settings, onClose, onSaved, onDirtyChange }: { store: ProjectStore; project: Project; page: ProjectPage; settings: AppSettings; onClose: () => void; onSaved: (p: Project) => void; onDirtyChange?: (dirty: boolean) => void }) {
  const platform = usePlatform();
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<unknown>(null);
  /** Bumped after a crop: the page has new pictures and a new size. A plain save does not reload. */
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let cancelled = false;
    // Never show the previous page's pictures under this page's name (a save would mix them up).
    setData(null);
    setError(null);
    (async () => {
      const a = await store.assets(project.id, page.id);
      if (!a || !page.result) throw new Error(tr('Страница ещё не переведена'));
      const original = await loadOriginalImage(platform.backend, a);
      const cleaned = await tilesToImage(platform.backend, page.result.width, page.result.height, a.cleaned ?? []);
      if (!cancelled) setData({ page: page.result, original, cleaned });
    })().catch((e) => !cancelled && setError(e));
    return () => {
      cancelled = true;
    };
    // Only another page or a crop reloads: after a save the editor keeps its own (newer) state.
  }, [platform, store, project.id, page.id, reload]); // eslint-disable-line react-hooks/exhaustive-deps
  if (error) return <ErrorBox error={error} />;
  if (!data) return <p className="ait-muted">{tr('Загрузка страницы…')}</p>;
  return (
    <Editor
      key={`${page.id}:${data.page.width}x${data.page.height}`}
      title={page.name}
      page={data.page}
      original={data.original}
      cleaned={data.cleaned}
      settings={settings}
      onClose={onClose}
      onDirtyChange={onDirtyChange}
      chapterTexts={async (current) => project.pages.map((p) => (p.id === page.id ? current : p.result?.blocks ?? []))}
      reportSource={async () => {
        const a = await store.assets(project.id, page.id);
        return a ? { original: a.original } : undefined;
      }}
      onCrop={async (rect, blocks) => {
        const fresh = (await store.get(project.id)) ?? project;
        onSaved(await cropProjectPage(store, platform.backend, settings, fresh, page, { ...data.page, blocks }, data.original, data.cleaned, rect));
        setReload((n) => n + 1);
      }}
      onSave={async (result, cleaned, pixels) => {
        const fresh = (await store.get(project.id)) ?? project;
        onSaved(await rerenderProjectPage(store, platform.backend, settings, fresh, page, result, pixels ? cleaned : undefined));
      }}
    />
  );
}
