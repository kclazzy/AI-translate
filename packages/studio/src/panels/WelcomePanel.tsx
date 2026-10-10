import type { AppSettings } from '@ait/core';
import { tr } from '@ait/core/i18n';
import { LamaGetButton, lamaModeOf, useLamaDownloaded } from '../lama';
import { usePlatform } from '../platform';
import { DetectorGetButton, useDetectorDownloaded } from '../detector';

/** Shown once after installing: what to do first, in four steps (and one optional). */
export function WelcomePanel({ settings, update, onSetup, onCloud }: { settings: AppSettings; update: (p: Partial<AppSettings>) => void; onSetup: () => void; onCloud: () => void }) {
  const platform = usePlatform();
  const [have, setHave] = useLamaDownloaded();
  const lamaOn = have && lamaModeOf(settings) === 'browser';
  const [haveDetector, setHaveDetector] = useDetectorDownloaded();
  const detectorOn = haveDetector && settings.detectorMode === 'browser';
  return (
    <div className="ait-panel" data-testid="welcome" style={{ display: 'grid', gap: 14, maxWidth: 680 }}>
      <h2 style={{ margin: 0 }}>{tr('Добро пожаловать в AI Translate')}</h2>
      <p style={{ margin: 0 }}>{tr('Переводит мангу, манхву, вебтуны и комиксы прямо на сайте: текст в баблах заменяется переводом.')}</p>
      <ol style={{ display: 'grid', gap: 10, paddingLeft: 20, margin: 0 }}>
        <li>
          <b>{tr('Выберите, где работает модель.')}</b>{' '}
          {tr('На этом компьютере — бесплатно и приватно, нужна видеокарта (от 4 ГБ). В облаке — быстро на любом компьютере, нужен ключ API.')}
          <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
            <button className="ait-bubble-btn" onClick={onSetup}>{tr('Настроить на этом компьютере')}</button>
            <button className="ait-btn" onClick={onCloud}>{tr('Подключить облачную модель')}</button>
          </div>
        </li>
        <li>
          <b>{tr('Откройте главу на любом сайте.')}</b> {tr('Наведите мышь на картинку и нажмите «Перевести» — или «Перевести страницу» в окне расширения (значок на панели браузера).')}
        </li>
        <li>
          <b>{tr('Для целой главы')}</b> {tr('включите «Автоперевод на сайте» или нажмите «Перевести и скачать» — получится PDF, CBZ или EPUB.')}
        </li>
        <li>
          <b>{tr('Правьте, если нужно.')}</b> {tr('Кнопка ✎ на переведённой картинке открывает редактор: текст, шрифт, размер, кисть.')}
        </li>
        {platform.lama ? (
          <li data-testid="welcome-lama">
            <b>{tr('Дорисовка фона (по желанию).')}</b>{' '}
            {tr('Когда текст написан прямо на рисунке, а не в бабле, фон под ним закрашивается упрощённо. Нейросеть LaMa дорисует его аккуратно: волосы, одежду, пейзаж. Модель скачивается один раз и работает прямо в браузере.')}
            <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              {lamaOn ? <span className="ait-badge ok">{tr('Готово')}</span> : <LamaGetButton update={update} downloaded={have} label={have ? tr('Включить LaMa') : tr('Скачать LaMa (~200 МБ)')} onDone={() => setHave(true)} />}
            </div>
          </li>
        ) : null}
        {platform.detector ? (
          <li data-testid="welcome-detector">
            <b>{tr('Точный поиск текста (по желанию).')}</b> {tr('Нейросеть находит баблы и текст точнее модели-переводчика: меньше сдвинутого текста, пропусков и стёртого рисунка.')}
            <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              {detectorOn ? <span className="ait-badge ok">{tr('Готово')}</span> : <DetectorGetButton update={update} downloaded={haveDetector} label={haveDetector ? tr('Включить') : tr('Скачать (~45 МБ)')} onDone={() => setHaveDetector(true)} />}
            </div>
          </li>
        ) : null}
      </ol>
      <p className="ait-muted" style={{ margin: 0 }}>
        {tr('Горячие клавиши: Alt+Shift+T — перевести страницу, Alt+Shift+A — перевести область, Alt+Shift+O — оригинал/перевод.')}
      </p>
    </div>
  );
}
