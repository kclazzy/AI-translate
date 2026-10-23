import { useEffect, useState } from 'react';
import type { AppSettings } from '@ait/core';
import { tr } from '@ait/core/i18n';
import { usePlatform } from './platform';

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
  if (have.det && have.ocr) return <small className="ait-badge ok" data-testid="ocr-ready">{tr('Модели распознавания готовы')}</small>;
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
