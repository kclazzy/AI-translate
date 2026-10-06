import { useEffect, useRef, useState } from 'react';
import { sniffImageMime, type StageEvent, type StoredResult } from '@ait/core';
import { flattenTiles } from '../files';
import { usePlatform } from '../platform';
import { ErrorBox, Progress, useAction, useObjectUrl } from '../ui';

const STAGE_LABEL: Partial<Record<StageEvent['stage'], string>> = {
  decoding: 'Открываю изображение',
  detecting: 'Ищу текст',
  ocr: 'Распознаю текст',
  translating: 'Перевожу',
  cleaning: 'Убираю оригинальный текст',
  rendering: 'Вписываю перевод',
};

function TileImg({ bytes }: { bytes: Uint8Array }) {
  const url = useObjectUrl(bytes);
  return url ? <img src={url} alt="" style={{ display: 'block', width: '100%' }} /> : null;
}

/** Translate a single image (screenshot, saved page, shared picture). Main flow on phones. */
export function QuickPanel({ onEdit, sharedFile }: { onEdit: (key: string) => void; sharedFile?: File | null }) {
  const platform = usePlatform();
  const [result, setResult] = useState<StoredResult | null>(null);
  const [stage, setStage] = useState<StageEvent | null>(null);
  const [showOriginal, setShowOriginal] = useState(false);
  const [name, setName] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const ctrl = useRef<AbortController | null>(null);

  const translate = useAction(async (file: File) => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const mime = sniffImageMime(bytes) ?? file.type;
    setName(file.name || 'image.png');
    setResult(null);
    ctrl.current = new AbortController();
    const { result: r } = await platform.service.translate(bytes, mime, { title: file.name, seriesKey: 'quick', signal: ctrl.current.signal, onStage: setStage });
    setResult(r);
    setStage(null);
  });

  useEffect(() => {
    if (sharedFile) void translate.run(sharedFile);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sharedFile]);

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const f = [...(e.clipboardData?.files ?? [])].find((x) => x.type.startsWith('image/'));
      if (f) void translate.run(f);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  });

  const save = useAction(async () => {
    if (!result) return;
    const files = await flattenTiles(platform.backend, { name, width: result.page.width, height: result.page.height, tiles: result.rendered }, 'image/png');
    for (const f of files) await platform.saveFile(f.name.replace(/(\.\w+)$/, '-ru$1'), f.bytes, 'image/png');
  });

  const busy = translate.busy;
  return (
    <div>
      <div className="ait-panel">
        <h2>Перевести изображение</h2>
        <p className="ait-hint" style={{ marginTop: -6 }}>Скриншот, страница манги или фото. Можно вставить из буфера обмена (Ctrl+V).</p>
        <div className="ait-row" style={{ marginTop: 12, alignItems: 'center' }}>
          <button className="ait-bubble-btn" style={{ flex: '0 0 auto' }} disabled={busy} onClick={() => input.current?.click()}>
            {busy ? 'Перевожу…' : 'Выбрать картинку'}
          </button>
          <input ref={input} type="file" accept="image/*" hidden onChange={(e) => e.target.files?.[0] && void translate.run(e.target.files[0])} />
          {busy ? <button className="ait-btn" style={{ flex: '0 0 auto' }} onClick={() => ctrl.current?.abort()}>Отмена</button> : null}
        </div>
        {busy && stage ? <div style={{ marginTop: 14 }}><Progress value={stage.progress ?? 0.3} label={STAGE_LABEL[stage.stage] ?? 'Работаю'} /></div> : null}
        <ErrorBox error={translate.error} onRetry={translate.error && input.current?.files?.[0] ? () => void translate.run(input.current!.files![0]) : undefined} />
      </div>
      {result ? (
        <div className="ait-panel">
          <div className="ait-row" style={{ alignItems: 'center', marginBottom: 12 }}>
            <button className={`ait-btn ${showOriginal ? 'active' : ''}`} style={{ flex: '0 0 auto' }} onClick={() => setShowOriginal((v) => !v)}>
              {showOriginal ? 'Показан оригинал' : 'Показать оригинал'}
            </button>
            <button className="ait-btn" style={{ flex: '0 0 auto' }} onClick={() => onEdit(result.key)}>Править</button>
            <button className="ait-btn" style={{ flex: '0 0 auto' }} onClick={() => void save.run()}>Сохранить картинку</button>
            <span className="ait-muted" style={{ flex: '1 1 auto', textAlign: 'right', fontSize: 13 }}>
              Блоков: {result.page.blocks.length} · {((result.page.timings.totalMs ?? 0) / 1000).toFixed(1)} с
            </span>
          </div>
          <ErrorBox error={save.error} />
          <div style={{ border: '1px solid var(--rule)', borderRadius: 8, overflow: 'hidden' }}>
            {showOriginal ? <TileImg bytes={result.original.bytes} /> : result.rendered.map((t) => <TileImg key={t.y} bytes={t.bytes} />)}
          </div>
          {result.page.blocks.length === 0 ? <p className="ait-hint">Текст не найден. Попробуйте качество «Максимум» или инструмент «Ручной OCR» в редакторе.</p> : null}
        </div>
      ) : null}
    </div>
  );
}
