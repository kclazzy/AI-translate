import { useEffect } from 'react';
import { type AppSettings } from '@ait/core';
import { tr } from '@ait/core/i18n';
import { usePlatform } from './platform';
import { checkOcrNeeds, needsMb, startOcrSetup, useOcrSetup } from './ocrSetup';
import { Switch } from './ui';

/**
 * «Сначала распознавание» (the cascade, see core pipeline/cascade.ts): the text is read by the networks
 * on the video card first; the model gets only the text when the reading is sure. Needs the detector
 * and the line reader in this browser: switching it on downloads what is missing.
 */
export function CascadeChoice({ settings: s, update }: { settings: AppSettings; update: (p: Partial<AppSettings>) => void }) {
  const platform = usePlatform();
  const st = useOcrSetup();
  const on = !!s.cascade;
  useEffect(() => {
    if (on) void checkOcrNeeds(platform, s);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [platform, on, s.sourceLang]);
  // Only where a model reads the pictures, and with the networks available here.
  if (s.readMode === 'ocr' || s.pipeline === 'engine' || !platform.ocr || !platform.detector) return null;
  const missing = on && st.needs && !(st.needs.det && st.needs.ocr && st.needs.manga);
  return (
    <span data-testid="cascade" style={{ display: 'grid', gap: 4 }}>
      <Switch
        checked={on}
        onChange={(cascade) => {
          update({ cascade });
          if (cascade) void checkOcrNeeds(platform, s).then((n) => (n.det && n.ocr && n.manga ? undefined : startOcrSetup(platform, s)));
        }}
        label={tr('Сначала распознавание — быстрее')}
      />
      <small className="ait-muted ait-set-hint">
        {tr('Текст сначала читают нейросети на видеокарте. Прочитано уверенно — модели уходит только текст, это в несколько раз быстрее; есть сомнения — модель читает картинку, как обычно.')}
      </small>
      {on && st.running ? (
        <small className="ait-muted" data-testid="cascade-setup">{tr('Скачиваю распознавание (один раз)… {0}%', Math.round(st.pct * 100))}</small>
      ) : missing ? (
        <span>
          <button type="button" className="ait-btn small" data-testid="cascade-download" onClick={() => void startOcrSetup(platform, s)}>
            {tr('Скачать распознавание (~{0} МБ)', needsMb(st.needs!, s))}
          </button>{' '}
          <small className="ait-muted">{tr('Пока его нет, модель читает каждую страницу сама.')}</small>
        </span>
      ) : null}
    </span>
  );
}
