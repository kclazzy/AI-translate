import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { EngineClient, LANGUAGES, providerById, type AppSettings, type UsageTotals } from '@ait/core';
import '@ait/studio/styles.css';
import { loadBundledFonts } from '@ait/studio/fonts';
import './popup.css';
import { db, hostOf, loadSettings, saveSettings } from '../shared/store';

function Popup() {
  const [s, setS] = useState<AppSettings | null>(null);
  const [tab, setTab] = useState<chrome.tabs.Tab | null>(null);
  const [engine, setEngine] = useState<'ok' | 'down' | 'unpaired' | null>(null);
  const [usage, setUsage] = useState<UsageTotals | null>(null);

  useEffect(() => {
    void loadSettings().then((x) => {
      setS(x);
      if (x.theme !== 'system') document.documentElement.setAttribute('data-theme', x.theme);
      if (x.pipeline === 'engine')
        void new EngineClient(x.engine.url, x.engine.token)
          .health()
          .then((h) => setEngine((h as { paired?: boolean }).paired === false ? 'unpaired' : 'ok'))
          .catch(() => setEngine('down'));
    });
    void chrome.tabs.query({ active: true, currentWindow: true }).then(([t]) => setTab(t ?? null));
    void db.get<UsageTotals>('usage', 'totals').then((u) => setUsage(u ?? null));
  }, []);

  if (!s) return null;
  const host = hostOf(tab?.url);
  const auto = s.autoTranslate.enabled || s.autoTranslate.sites.includes(host);
  const vision = providerById(s, s.visionProviderId);
  const translator = providerById(s, s.translationProviderId) ?? vision;
  const canRun = !!tab?.id && /^https?:|^file:/.test(tab.url ?? '');
  const update = (patch: Partial<AppSettings>) => {
    const next = { ...s, ...patch };
    setS(next);
    void saveSettings(next);
  };
  const command = (command: 'translate-page' | 'select-area' | 'toggle-original') => {
    if (!tab?.id) return;
    void chrome.runtime.sendMessage({ type: 'popup-command', command, tabId: tab.id });
    if (command !== 'toggle-original') window.close();
  };
  const open = (path: string) => void chrome.tabs.create({ url: chrome.runtime.getURL(path) });
  const missing = s.pipeline === 'standalone' && !vision;

  return (
    <div className="pp">
      <header className="pp-head">
        <span className="pp-mark">AI Translate</span>
        <span className={`ait-badge ${s.privacy === 'local' ? 'local' : ''}`}>{s.privacy === 'local' ? '🔒 Локально' : s.privacy === 'hybrid' ? 'Гибрид' : 'Облако'}</span>
      </header>

      {missing ? (
        <div className="ait-notice">Выберите модель, которая читает изображения. <button className="pp-link" onClick={() => chrome.runtime.openOptionsPage()}>Открыть настройки</button></div>
      ) : null}
      {engine === 'down' ? <div className="ait-error">Движок не отвечает по адресу {s.engine.url}. Запустите его или переключитесь в режим без движка.</div> : null}
      {engine === 'unpaired' ? <div className="ait-notice">Движок запущен, но код сопряжения не подходит. Введите его в настройках.</div> : null}

      <button className="ait-bubble-btn pp-main" disabled={!canRun || missing} onClick={() => command('translate-page')}>
        Перевести страницу
      </button>
      <div className="pp-row">
        <button className="ait-btn" disabled={!canRun} onClick={() => command('select-area')}>Перевести область</button>
        <button className="ait-btn" disabled={!canRun} onClick={() => command('toggle-original')}>Оригинал ⇄</button>
      </div>
      {!canRun ? <p className="ait-hint">На этой странице расширение не работает. Откройте сайт с мангой.</p> : null}

      <label className="ait-switch pp-auto">
        <input
          type="checkbox"
          role="switch"
          checked={auto}
          disabled={!host || s.autoTranslate.enabled}
          onChange={(e) => {
            if (!tab?.id) return;
            const sites = new Set(s.autoTranslate.sites);
            if (e.target.checked) sites.add(host);
            else sites.delete(host);
            setS({ ...s, autoTranslate: { ...s.autoTranslate, sites: [...sites] } });
            void chrome.runtime.sendMessage({ type: 'set-auto', host, enabled: e.target.checked, tabId: tab.id });
          }}
        />
        <span>Автоперевод на {host || 'этом сайте'}</span>
      </label>

      <div className="pp-grid">
        <label className="ait-field">
          <span>Язык перевода</span>
          <select className="ait-select" value={s.targetLang} onChange={(e) => update({ targetLang: e.target.value })}>
            {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.native}</option>)}
          </select>
        </label>
        <label className="ait-field">
          <span>Исходный</span>
          <select className="ait-select" value={s.sourceLang} onChange={(e) => update({ sourceLang: e.target.value })}>
            <option value="auto">Авто</option>
            {LANGUAGES.filter((l) => ['ja', 'ko', 'zh', 'zh-TW', 'en'].includes(l.code)).map((l) => <option key={l.code} value={l.code}>{l.native}</option>)}
          </select>
        </label>
        <label className="ait-field">
          <span>Профиль</span>
          <select className="ait-select" value={s.activeProfileId} onChange={(e) => update({ activeProfileId: e.target.value })}>
            {s.profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <label className="ait-field">
          <span>Качество</span>
          <select className="ait-select" value={s.quality} onChange={(e) => update({ quality: e.target.value as AppSettings['quality'] })}>
            <option value="fast">Быстро</option>
            <option value="balanced">Баланс</option>
            <option value="best">Максимум</option>
          </select>
        </label>
        <label className="ait-field" style={{ gridColumn: '1 / -1' }}>
          <span>Модель</span>
          <select className="ait-select" value={s.visionProviderId ?? ''} onChange={(e) => update({ visionProviderId: e.target.value || null })}>
            <option value="">— не выбрана —</option>
            {s.providers.filter((p) => p.vision).map((p) => <option key={p.id} value={p.id}>{p.label} · {p.model}</option>)}
          </select>
        </label>
      </div>
      <p className="ait-hint pp-route">
        {s.pipeline === 'engine' ? `Движок: ${s.engine.url}` : `Читает: ${vision ? vision.model : '—'}`}
        {translator && translator.id !== vision?.id ? `, переводит: ${translator.model}` : ''}
      </p>

      <footer className="pp-foot">
        <button className="pp-link" onClick={() => open('studio.html')}>Студия</button>
        <button className="pp-link" onClick={() => open('studio.html?view=history')}>История</button>
        <button className="pp-link" onClick={() => chrome.runtime.openOptionsPage()}>Настройки</button>
        <span className="ait-muted">{usage ? `${usage.pages} стр. · $${usage.costUsd.toFixed(2)}` : ''}</span>
      </footer>
    </div>
  );
}

void loadBundledFonts();
createRoot(document.getElementById('root')!).render(<Popup />);
