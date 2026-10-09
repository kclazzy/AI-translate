import { tr } from '@ait/core/i18n';

/** Shown once after installing: what to do first, in four steps. */
export function WelcomePanel({ onSetup, onCloud }: { onSetup: () => void; onCloud: () => void }) {
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
      </ol>
      <p className="ait-muted" style={{ margin: 0 }}>
        {tr('Горячие клавиши: Alt+Shift+T — перевести страницу, Alt+Shift+A — перевести область, Alt+Shift+O — оригинал/перевод.')}
      </p>
    </div>
  );
}
