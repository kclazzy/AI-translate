import { useEffect, useState } from 'react';
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
  why: 'missing' | 'width';
}

/**
 * Stack several cached pages of one width into one tall page (whole-chapter editing). The width is
 * the one of `mainKey` (the page the user opened), so that page is always in the strip.
 */
async function loadStack(platform: ReturnType<typeof usePlatform>, keys: string[], mainKey = keys[0]): Promise<Loaded & { segments: Segment[]; title: string; skipped: Skipped[] }> {
  const found: { r: NonNullable<Awaited<ReturnType<typeof platform.service.getResult>>>; n: number }[] = [];
  const skipped: Skipped[] = [];
  for (const [i, k] of keys.entries()) {
    const r = await platform.service.getResult(k);
    if (r) found.push({ r, n: i + 1 });
    else skipped.push({ n: i + 1, why: 'missing' });
  }
  if (!found.length) throw new Error(tr('Перевод не найден в кэше — переведите страницу ещё раз'));
  const width = (found.find((x) => x.r.key === mainKey) ?? found[0]).r.page.width;
  for (const x of found) if (x.r.page.width !== width) skipped.push({ n: x.n, why: 'width' });
  skipped.sort((a, b) => a.n - b.n);
  const same = found.filter((x) => x.r.page.width === width).map((x) => x.r);
  const segments: Segment[] = [];
  let y = 0;
  for (const r of same) {
    segments.push({ key: r.key, y, h: r.page.height, pageId: r.page.pageId, usage: r.page.usage });
    y += r.page.height;
  }
  const original = new TiledImage(platform.backend, width, y);
  const cleaned = new TiledImage(platform.backend, width, y);
  const blocks = [];
  for (const [i, r] of same.entries()) {
    const s = segments[i];
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
    blocks.push(...r.page.blocks.filter((b) => same.length === 1 || !(b as TextBlock & { continued?: boolean }).continued).map((b) => ({ ...shiftBlock(b, -s.y), id: `${i}:${b.id}` })));
  }
  const page: PageResult = { ...same[0].page, height: y, blocks, usage: same.flatMap((r) => r.page.usage) };
  return { page, original, cleaned, segments, skipped, title: same[0].title || same[0].sourceUrl || '' };
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
                {tr('Не вошли в ленту: {0}', data.skipped.map((x) => (x.why === 'width' ? tr('№{0} (другая ширина)', x.n) : tr('№{0} (не переведена)', x.n))).join(', '))}
              </span>
            ) : null}
          </>
        ) : null
      }
      onSave={async (page, cleaned, pixels) => {
        for (const [i, s] of data.segments.entries()) {
          const part = pageForSpan(page, s, i);
          const own: PageResult = { ...part, pageId: s.pageId, usage: s.usage, blocks: part.blocks.map((b) => ({ ...b, id: b.id.replace(/^\d+:/, '') })) };
          await platform.service.saveEdited(s.key, own, pixels ? cropRows(cleaned, s.y, s.h) : undefined);
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
