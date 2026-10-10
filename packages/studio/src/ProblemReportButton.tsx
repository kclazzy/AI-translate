import { useState } from 'react';
import { encodeTiles, renderTiles, type PageResult, type StyleDefaults, type TiledImage } from '@ait/core';
import { tr } from '@ait/core/i18n';
import { usePlatform } from './platform';
import { buildProblemReport, type ProblemReportInput } from './problemReport';
import { ErrorBox, toast, useAction } from './ui';

type Parts = Omit<ProblemReportInput, 'version' | 'platform' | 'settings' | 'comment' | 'includeUrl' | 'backend'>;

/**
 * «Сообщить о проблеме»: a short form (what is wrong, page address or not) that saves / shares a
 * zip for the developer — original, result, cleaned picture, page data, settings without keys.
 */
export function ProblemReportButton({ parts, small, where }: { parts: () => Promise<Parts>; small?: boolean; where: string }) {
  const platform = usePlatform();
  const [open, setOpen] = useState(false);
  const [comment, setComment] = useState('');
  const [withUrl, setWithUrl] = useState(false);
  const [hasUrl, setHasUrl] = useState(false);
  const save = useAction(async () => {
    const p = await parts();
    const { name, bytes } = await buildProblemReport({ ...p, settings: await platform.loadSettings(), version: platform.version, platform: `${platform.kind} / ${where}`, backend: platform.backend, comment, includeUrl: withUrl });
    await platform.saveFile(name, bytes, 'application/zip');
    toast(tr('Файл сохранён: {0}. Пришлите его разработчику.', name));
    setOpen(false);
    setComment('');
  });
  const toggle = () => {
    if (!open) void parts().then((p) => setHasUrl(!!p.sourceUrl), () => setHasUrl(false));
    setOpen(!open);
  };
  return (
    <span className="ait-report" style={{ position: 'relative', display: 'inline-block' }}>
      <button className={`ait-btn ${small ? 'small' : ''}`} style={{ flex: '0 0 auto' }} data-testid="problem-report" aria-expanded={open} onClick={toggle} title={tr('Сохранить файл для разработчика: картинка, результат и ответы модели (без ключей API)')}>
        {tr('Сообщить о проблеме')}
      </button>
      {open ? (
        <div className="ait-panel" role="dialog" aria-label={tr('Сообщить о проблеме')} style={{ position: 'absolute', zIndex: 30, top: '100%', left: 0, marginTop: 6, width: 300, maxWidth: '80vw', display: 'grid', gap: 8, boxShadow: '0 4px 16px rgba(0,0,0,.2)' }}>
          <textarea className="ait-input" rows={3} maxLength={2000} placeholder={tr('Что не так?')} aria-label={tr('Что не так?')} value={comment} onChange={(e) => setComment(e.target.value)} />
          {hasUrl ? (
            <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input type="checkbox" checked={withUrl} onChange={(e) => setWithUrl(e.target.checked)} />
              {tr('включить адрес страницы')}
            </label>
          ) : null}
          <small className="ait-muted">{tr('Ключей API в файле нет. Картинка страницы в нём есть.')}</small>
          <button className="ait-btn small" data-testid="problem-report-save" disabled={save.busy} onClick={() => void save.run()}>
            {save.busy ? tr('Собираю файл…') : tr('Сохранить файл')}
          </button>
          <ErrorBox error={save.error} />
        </div>
      ) : null}
    </span>
  );
}

/** The pictures of a page open in the editor, with the edits made so far. */
export async function editorReportParts(backend: Parameters<typeof renderTiles>[0], page: PageResult, original: TiledImage, cleaned: TiledImage, defaults: StyleDefaults, extra?: { original?: { bytes: Uint8Array; mime: string }; sourceUrl?: string }): Promise<Parts> {
  const rendered = await encodeTiles(backend, renderTiles(backend, cleaned, page.blocks, defaults).tiles, 'image/png');
  // Without the bytes of the original file: its decoded pixels (lossless), as one picture.
  let orig = extra?.original;
  if (!orig) {
    try {
      const c = backend.createCanvas(original.width, original.height);
      original.drawRegion(c.getContext('2d'), 0, 0, original.width, original.height, original.width, original.height);
      orig = { bytes: await backend.encode(c, 'image/png'), mime: 'image/png' };
    } catch {
      orig = undefined; // too big for one canvas: the report goes without it
    }
  }
  return { page, original: orig, rendered, cleaned: await encodeTiles(backend, cleaned.tiles, 'image/png'), edited: true, ...(extra?.sourceUrl ? { sourceUrl: extra.sourceUrl } : {}) };
}
