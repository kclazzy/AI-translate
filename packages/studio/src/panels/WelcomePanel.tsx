import { useState } from 'react';
import type { AppSettings } from '@ait/core';
import { detectGpu } from '../ModelPicker';
import { tr } from '@ait/core/i18n';
import { LamaGetButton, lamaModeOf, useLamaDownloaded } from '../lama';
import { usePlatform } from '../platform';
import { DetectorGetButton, useDetectorDownloaded } from '../detector';

/** Shown once after installing: the AI mode to start with (one of three, one recommended), then what to do. */
export function WelcomePanel({ settings, update, onSetup, onCloud, onEngine }: { settings: AppSettings; update: (p: Partial<AppSettings>) => void; onSetup: () => void; onCloud: () => void; onEngine: () => void }) {
  const platform = usePlatform();
  // A card with 8 GB or more runs a reading model well; with less (or none found) the cloud is the easy start.
  const [gpu] = useState(() => detectGpu());
  const strong = gpu.vramGb !== undefined ? gpu.vramGb >= 8 : /RTX [2-5]0[6-9]0|RX [67][7-9]00|Arc A7/i.test(gpu.name ?? '');
  const recommended = strong ? 'ollama' : 'cloud';
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
          <b>{tr('Выберите режим работы ИИ.')}</b> {tr('Его можно сменить в любой момент одной кнопкой в окне расширения.')}
          <div data-testid="welcome-modes" style={{ display: 'grid', gap: 8, marginTop: 8, gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))' }}>
            {(
              [
                ['ollama', tr('Ollama на этом ПК'), tr('Бесплатно и без интернета. Нужна видеокарта от 8 ГБ; модель скачивается один раз (~6 ГБ).'), tr('Настроить'), onSetup],
                ['cloud', tr('Облачная модель'), tr('Быстро на любом компьютере, даже без видеокарты. Нужен ключ API (у Gemini есть бесплатный).'), tr('Подключить'), onCloud],
                ['engine', tr('Движок на ПК'), tr('Для опытных: программа AI Translate Engine сама распознаёт текст, переводит текстовая модель. Нужно установить движок.'), tr('Подключить движок'), onEngine],
              ] as const
            ).map(([mode, title, text, action, go]) => (
              <div key={mode} data-mode={mode} className="ait-panel" style={{ display: 'grid', gap: 6, padding: 12, margin: 0, borderColor: mode === recommended ? 'var(--accent, #2f6fde)' : undefined }}>
                <b>
                  {title}
                  {mode === recommended ? <span className="ait-badge ok" style={{ marginLeft: 6 }}>{tr('Рекомендуем')}</span> : null}
                </b>
                <small className="ait-muted">{text}</small>
                <button className={mode === recommended ? 'ait-bubble-btn' : 'ait-btn'} onClick={go} style={{ justifySelf: 'start' }}>
                  {action}
                </button>
              </div>
            ))}
          </div>
          {gpu.name ? <small className="ait-muted">{tr('Видеокарта: {0}', gpu.name + (gpu.vramGb ? ` (${tr('{0} ГБ', gpu.vramGb)})` : ''))}</small> : null}
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
