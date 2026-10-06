import { useEffect, useState } from 'react';
import { tilesToImage, TiledImage, type AppSettings, type PageResult, type Project, type ProjectPage } from '@ait/core';
import { usePlatform } from '../platform';
import { loadOriginalImage, rerenderProjectPage, type ProjectStore } from '../projects';
import { ErrorBox } from '../ui';
import { Editor } from './Editor';

interface Loaded {
  page: PageResult;
  original: TiledImage;
  cleaned: TiledImage;
}

/** Edit a page that lives in the translation cache (opened from the page overlay or history). */
export function CachedPageEditor({ resultKey, settings, onClose }: { resultKey: string; settings: AppSettings; onClose?: () => void }) {
  const platform = usePlatform();
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [title, setTitle] = useState('');
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const r = await platform.service.getResult(resultKey);
      if (!r) throw new Error('Перевод не найден в кэше — переведите страницу ещё раз');
      const original = await TiledImage.fromBytes(platform.backend, r.original.bytes, r.original.mime);
      const cleaned = await tilesToImage(platform.backend, r.page.width, r.page.height, r.cleaned);
      if (!cancelled) {
        setData({ page: r.page, original, cleaned });
        setTitle(r.title || r.sourceUrl || '');
      }
    })().catch((e) => !cancelled && setError(e));
    return () => {
      cancelled = true;
    };
  }, [platform, resultKey]);
  if (error) return <ErrorBox error={error} />;
  if (!data) return <p className="ait-muted">Загрузка страницы…</p>;
  return (
    <Editor
      key={resultKey}
      title={title}
      page={data.page}
      original={data.original}
      cleaned={data.cleaned}
      settings={settings}
      onClose={onClose}
      onSave={async (page, cleaned, pixels) => {
        await platform.service.saveEdited(resultKey, page, pixels ? cleaned : undefined);
        platform.notifyResultChanged?.(resultKey);
      }}
    />
  );
}

/** Edit one page of a project. */
export function ProjectPageEditor({ store, project, page, settings, onClose, onSaved }: { store: ProjectStore; project: Project; page: ProjectPage; settings: AppSettings; onClose: () => void; onSaved: (p: Project) => void }) {
  const platform = usePlatform();
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const a = await store.assets(project.id, page.id);
      if (!a || !page.result) throw new Error('Страница ещё не переведена');
      const original = await loadOriginalImage(platform.backend, a);
      const cleaned = await tilesToImage(platform.backend, page.result.width, page.result.height, a.cleaned ?? []);
      if (!cancelled) setData({ page: page.result, original, cleaned });
    })().catch((e) => !cancelled && setError(e));
    return () => {
      cancelled = true;
    };
  }, [platform, store, project.id, page]);
  if (error) return <ErrorBox error={error} />;
  if (!data) return <p className="ait-muted">Загрузка страницы…</p>;
  return (
    <Editor
      key={page.id}
      title={page.name}
      page={data.page}
      original={data.original}
      cleaned={data.cleaned}
      settings={settings}
      onClose={onClose}
      onSave={async (result, cleaned, pixels) => {
        const fresh = (await store.get(project.id)) ?? project;
        onSaved(await rerenderProjectPage(store, platform.backend, settings, fresh, page, result, pixels ? cleaned : undefined));
      }}
    />
  );
}
