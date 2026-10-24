import { useEffect } from 'react';
import { BROWSER_TRANSLATOR_ID, translatorLang, type AppSettings } from '@ait/core';
import { tr } from '@ait/core/i18n';
import { usePlatform } from './platform';
import { checkOcrNeeds, needsMb, ocrComplete, startOcrSetup, useOcrSetup } from './ocrSetup';

/**
 * What the AI mode «Распознавание» needs in this browser — the text detector, the line reader,
 * Manga OCR for Japanese, the translator's language pack — set up by itself when the mode is chosen
 * (see ocrSetup.ts). The card shows the progress, and one button for whatever is still missing.
 */
const tried = new Set<string>();

export function OcrModelsCard({ settings: s }: { settings: AppSettings }) {
  const platform = usePlatform();
  const st = useOcrSetup();
  const key = `${s.sourceLang}|${s.targetLang}|${s.visionProviderId}`;
  useEffect(() => {
    let off = false;
    void checkOcrNeeds(platform, s).then((n) => {
      // Missing parts are downloaded by themselves, once per choice of languages and translator
      // (a failed download is not retried in a loop: the button below is there for that).
      if (!off && !ocrComplete(n) && !tried.has(key)) {
        tried.add(key);
        void startOcrSetup(platform, s);
      }
    });
    return () => {
      off = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [platform, key]);
  if (!platform.ocr || !platform.detector || !st.needs) return null;
  const n = st.needs;
  const browser = s.visionProviderId === BROWSER_TRANSLATOR_ID;
  const pair = `→ ${translatorLang(s.targetLang)}`;
  const chosenPair = `${translatorLang(s.sourceLang)} → ${translatorLang(s.targetLang)}`;
  if (st.running)
    return (
      <div className="ait-notice" data-testid="ocr-setup" style={{ display: 'grid', gap: 6 }}>
        <span>{tr('Готовлю распознавание: скачиваю нейросети (один раз)…')}</span>
        <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span className="ait-progress" style={{ flex: 1, minWidth: 120 }} role="progressbar" aria-label={tr('Скачивание моделей распознавания')} aria-valuenow={Math.round(st.pct * 100)} aria-valuemin={0} aria-valuemax={100}>
            <i style={{ width: `${Math.round(st.pct * 100)}%` }} />
          </span>
          <small className="ait-muted">{Math.round(st.pct * 100)}%</small>
        </span>
      </div>
    );
  if (ocrComplete(n))
    return (
      <span style={{ display: 'grid', gap: 4 }}>
        <small className="ait-badge ok" data-testid="ocr-ready">{tr('Распознавание готово')}</small>
        {browser && n.pack === 'none' ? <small className="ait-badge" data-testid="translator-none">{tr('Встроенный переводчик не умеет переводить {0} — выберите модель в «Чем переводить».', chosenPair)}</small> : null}
        {s.sourceLang.split('-')[0] === 'ja' && platform.ocr.manga ? (
          <small className="ait-muted" data-testid="manga-ocr-ready">
            {tr('Японский читает Manga OCR.')}{' '}
            <button className="pp-link" onClick={async () => { await platform.ocr!.manga!.remove(); await checkOcrNeeds(platform, s); }}>{tr('Удалить Manga OCR')}</button>
          </small>
        ) : null}
        {st.err ? <small style={{ color: 'var(--err)' }}>{st.err}</small> : null}
      </span>
    );
  const mb = needsMb(n, s);
  const what = [
    !n.det ? tr('поиск текста') : '',
    !n.ocr ? tr('чтение строк') : '',
    !n.manga ? tr('Manga OCR для японского') : '',
    n.pack === 'download' ? tr('языковые пакеты переводчика браузера (основные языки {0})', pair) : '',
  ].filter(Boolean);
  return (
    <div className="ait-notice" data-testid="ocr-models" style={{ display: 'grid', gap: 6 }}>
      <span>{tr('Для распознавания осталось скачать: {0}.', what.join(', '))}</span>
      <button className="ait-bubble-btn" style={{ justifySelf: 'start' }} onClick={() => void startOcrSetup(platform, s)}>
        {mb ? tr('Скачать (~{0} МБ)', mb) : tr('Скачать языковые пакеты')}
      </button>
      {st.err ? <small style={{ color: 'var(--err)' }}>{tr('Не удалось скачать: {0}', st.err)}</small> : null}
    </div>
  );
}
