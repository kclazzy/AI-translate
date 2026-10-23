import { useEffect, useState } from 'react';
import type { AppSettings } from '@ait/core';
import { tr } from '@ait/core/i18n';
import { usePlatform } from './platform';

/** Size of the Manga OCR download (int8 encoder + decoder), МБ. */
const MANGA_MB = 117;

/**
 * What the AI mode «Распознавание» needs in this browser: the text detector (finds the text) and the
 * recognition models (read it) — shown with one button that downloads whatever is missing.
 */
export function OcrModelsCard({ settings: s }: { settings: AppSettings }) {
  const platform = usePlatform();
  const korean = s.sourceLang.split('-')[0] === 'ko';
  const [have, setHave] = useState<{ det: boolean; ocr: boolean } | null>(null);
  const [pct, setPct] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let off = false;
    void (async () => {
      const det = (await platform.detector?.downloaded().catch(() => false)) ?? false;
      const ocr = (await platform.ocr?.downloaded(korean).catch(() => false)) ?? false;
      if (!off) setHave({ det, ocr });
    })();
    return () => {
      off = true;
    };
  }, [platform, korean]);
  if (!platform.ocr || !platform.detector || !have) return null;
  const japanese = s.sourceLang.split('-')[0] === 'ja';
  if (have.det && have.ocr)
    return (
      <span style={{ display: 'grid', gap: 6 }}>
        <small className="ait-badge ok" data-testid="ocr-ready">{tr('Модели распознавания готовы')}</small>
        {japanese ? <MangaOcrOffer /> : null}
      </span>
    );
  const mb = (have.det ? 0 : 45) + (have.ocr ? 0 : korean ? 23 : 31);
  const run = async () => {
    setErr(null);
    try {
      setPct(0);
      // The two downloads as one bar: the detector first (when missing), then the readers.
      const detShare = have.det ? 0 : 45 / mb;
      if (!have.det) await platform.detector!.download((p) => setPct(p * detShare));
      if (!have.ocr) await platform.ocr!.download((p) => setPct(detShare + p * (1 - detShare)), korean);
      setHave({ det: true, ocr: true });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setPct(null);
    }
  };
  return (
    <div className="ait-notice" data-testid="ocr-models" style={{ display: 'grid', gap: 6 }}>
      <span>{tr('Для распознавания в браузере нужно один раз скачать нейросети: поиск текста и чтение строк (~{0} МБ).', mb)}</span>
      {pct !== null ? (
        <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span className="ait-progress" style={{ flex: 1, minWidth: 120 }} role="progressbar" aria-label={tr('Скачивание моделей распознавания')} aria-valuenow={Math.round(pct * 100)} aria-valuemin={0} aria-valuemax={100}>
            <i style={{ width: `${Math.round(pct * 100)}%` }} />
          </span>
          <small className="ait-muted">{Math.round(pct * 100)}%</small>
        </span>
      ) : (
        <button className="ait-bubble-btn" style={{ justifySelf: 'start' }} onClick={() => void run()}>
          {tr('Скачать (~{0} МБ)', mb)}
        </button>
      )}
      {err ? <small style={{ color: 'var(--err)' }}>{tr('Не удалось скачать: {0}', err)}</small> : null}
    </div>
  );
}

/**
 * Japanese manga: Manga OCR (as in Koharu) reads a whole bubble at once — vertical columns, small
 * kana, furigana left out — far better than the line reader. Optional, downloaded once.
 */
export function MangaOcrOffer() {
  const platform = usePlatform();
  const manga = platform.ocr?.manga;
  const [have, setHave] = useState<boolean | null>(null);
  const [pct, setPct] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let off = false;
    void manga?.downloaded().then((v) => !off && setHave(v), () => !off && setHave(false));
    return () => {
      off = true;
    };
  }, [manga]);
  if (!manga || have === null) return null;
  if (have)
    return (
      <span style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }} data-testid="manga-ocr-ready">
        <small className="ait-badge ok">{tr('Японский: Manga OCR готов')}</small>
        <button className="ait-btn small danger" onClick={async () => { await manga.remove(); setHave(false); }}>{tr('Удалить')}</button>
      </span>
    );
  const run = async () => {
    setErr(null);
    try {
      setPct(0);
      await manga.download(setPct);
      setHave(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setPct(null);
    }
  };
  return (
    <div className="ait-notice" data-testid="manga-ocr" style={{ display: 'grid', gap: 6 }}>
      <span>{tr('Для японской манги: Manga OCR читает пузырь целиком — вертикальный текст, мелкую кану — намного точнее построчного чтения. Работает на процессоре.')}</span>
      {pct !== null ? (
        <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span className="ait-progress" style={{ flex: 1, minWidth: 120 }} role="progressbar" aria-label={tr('Скачивание Manga OCR')} aria-valuenow={Math.round(pct * 100)} aria-valuemin={0} aria-valuemax={100}>
            <i style={{ width: `${Math.round(pct * 100)}%` }} />
          </span>
          <small className="ait-muted">{Math.round(pct * 100)}%</small>
        </span>
      ) : (
        <button className="ait-bubble-btn" style={{ justifySelf: 'start' }} onClick={() => void run()}>
          {tr('Скачать Manga OCR (~{0} МБ)', MANGA_MB)}
        </button>
      )}
      {err ? <small style={{ color: 'var(--err)' }}>{tr('Не удалось скачать: {0}', err)}</small> : null}
    </div>
  );
}
