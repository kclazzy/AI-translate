import { LANGUAGES, profilesForLanguage, type AppSettings } from '@ait/core';
import { tr } from '@ait/core/i18n';

/**
 * From which language into which: the two choices side by side, with an arrow between them and a
 * button that swaps them (not from «определять автоматически»). Shown first in the settings and
 * in the popup, so it is seen before anything else.
 */
export function LanguagePair({ settings: s, update, compact }: { settings: AppSettings; update: (p: Partial<AppSettings>) => void; compact?: boolean }) {
  const setTarget = (targetLang: string) => update({ targetLang, profiles: profilesForLanguage(s.profiles, s.targetLang, targetLang) });
  const swap = () => {
    if (s.sourceLang === 'auto') return;
    update({ sourceLang: s.targetLang, targetLang: s.sourceLang, profiles: profilesForLanguage(s.profiles, s.targetLang, s.sourceLang) });
  };
  return (
    <div className={`ait-langpair${compact ? ' compact' : ''}`} data-testid="language-pair">
      <label className="ait-langpair-side">
        <span>{tr('С какого языка')}</span>
        <select className="ait-select" aria-label={tr('Исходный язык')} value={s.sourceLang} onChange={(e) => update({ sourceLang: e.target.value })}>
          <option value="auto">{compact ? tr('Авто') : tr('Определять автоматически')}</option>
          {LANGUAGES.map((l) => (
            <option key={l.code} value={l.code}>
              {l.native}
            </option>
          ))}
        </select>
      </label>
      <button type="button" className="ait-langpair-swap" onClick={swap} disabled={s.sourceLang === 'auto'} title={s.sourceLang === 'auto' ? tr('Сначала выберите исходный язык') : tr('Поменять языки местами')} aria-label={tr('Поменять языки местами')}>
        ⇄
      </button>
      <label className="ait-langpair-side">
        <span>{tr('На какой язык')}</span>
        <select className="ait-select" aria-label={tr('Язык перевода')} value={s.targetLang} onChange={(e) => setTarget(e.target.value)}>
          {LANGUAGES.map((l) => (
            <option key={l.code} value={l.code}>
              {l.native}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
