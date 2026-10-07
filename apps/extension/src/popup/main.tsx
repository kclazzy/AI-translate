import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { checkReadiness, EngineClient, gpuShare, isOllama, LANGUAGES, MODEL_TIERS, nativeName, providerById as pById, ollamaLoaded, ollamaUnloadAll, providerById, type AppSettings, type LoadedModel, type UsageTotals } from '@ait/core';
import '@ait/studio/styles.css';
import { loadBundledFonts } from '@ait/studio/fonts';
import { ModelCheckCard, ModelPicker, UpdateCheck } from '@ait/studio/model-picker';
import './popup.css';
import type { PageLangs, SpeedStats } from '../shared/messages';
import { db, hostOf, loadSettings, saveSettings, secrets } from '../shared/store';

/** What Ollama holds in video memory right now, with a button to free it. */
function VramLine({ settings }: { settings: AppSettings }) {
  const urls = [...new Set(settings.providers.filter((p) => isOllama(p)).map((p) => p.baseUrl))];
  const [loaded, setLoaded] = useState<LoadedModel[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [speed, setSpeed] = useState<SpeedStats | null>(null);
  const refresh = async () => setLoaded((await Promise.all(urls.map((u) => ollamaLoaded(u)))).flat());
  useEffect(() => {
    void refresh();
    void db.get<SpeedStats>('kv', 'speed').then((x) => setSpeed(x ?? null));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!loaded || !urls.length) return null;
  const gb = loaded.reduce((a, m) => a + m.sizeVram, 0) / 1e9;
  // Part of the model in system RAM: the main reason for a sudden slowdown.
  const spill = loaded.find((m) => gpuShare(m) < 0.95);
  const vision = pById(settings, settings.visionProviderId);
  const tier = MODEL_TIERS.find((t) => vision && t.model === vision.model);
  const expected = tier ? Number(tier.secondsPerPage.split('–')[1]) : undefined;
  const slow = speed && speed.pages >= 2 && expected && speed.avgMs / 1000 > expected * 2;
  return (
    <>
      {spill ? (
        <div className="ait-error" data-testid="vram-spill">
          ⚠ {spill.name} не помещается в видеопамять: на видеокарте только {Math.round(gpuShare(spill) * 100)}%, остальное в обычной памяти — перевод идёт в разы медленнее. Выберите модель поменьше в настройках.
        </div>
      ) : null}
      {speed && speed.pages ? (
        <p className="ait-hint" data-testid="speed-line" style={{ margin: 0 }}>
          Скорость: ~{Math.round(speed.avgMs / 1000)} с на страницу{slow ? ` — медленнее обычного для ${vision?.model} (до ${expected} с). Попробуйте быстрый режим или модель полегче.` : ''}
        </p>
      ) : null}
    <p className="ait-hint" data-testid="vram-line" style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center', margin: 0 }}>
      <span>{loaded.length ? `Видеопамять: занято ${gb.toFixed(1)} ГБ (${loaded.map((m) => m.name).join(', ')})` : 'Видеопамять свободна'}</span>
      {loaded.length ? (
        <button
          className="pp-link"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            for (const u of urls) await ollamaUnloadAll(u);
            await new Promise((r) => setTimeout(r, 400));
            await refresh();
            setBusy(false);
          }}
        >
          {busy ? 'Освобождаю…' : 'Освободить'}
        </button>
      ) : null}
    </p>
    </>
  );
}

function Popup() {
  const [s, setS] = useState<AppSettings | null>(null);
  const [tab, setTab] = useState<chrome.tabs.Tab | null>(null);
  const [engine, setEngine] = useState<'ok' | 'down' | 'unpaired' | null>(null);
  const [usage, setUsage] = useState<UsageTotals | null>(null);
  const [busy, setBusy] = useState(0);
  const [unloaded, setUnloaded] = useState<string[] | null>(null);
  const [langs, setLangs] = useState<PageLangs | null>(null);
  const [preflight, setPreflight] = useState(false);
  const [fmt, setFmt] = useState<'pdf' | 'cbz' | 'zip' | 'epub'>('pdf');

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
    void chrome.tabs.query({ active: true, currentWindow: true }).then(([t]) => {
      setTab(t ?? null);
      // The badge counts pictures in work on this tab.
      if (t?.id !== undefined) void chrome.action.getBadgeText({ tabId: t.id }).then((n) => setBusy(Number(n) || 0));
      // Which languages the page shows: the button names the one a click switches to.
      if (t?.id !== undefined) void chrome.tabs.sendMessage(t.id, { type: 'get-langs' }).then((l: PageLangs) => setLangs(l ?? null), () => undefined);
    });
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
  const command = async (command: 'translate-page' | 'select-area' | 'toggle-original' | 'download-chapter') => {
    if (!tab?.id) return;
    if (command !== 'toggle-original') {
      // Before a local translation: is everything installed and running? If not, open the helper,
      // which offers the downloads and continues this translation once ready.
      setPreflight(true);
      const ready = await checkReadiness(s);
      setPreflight(false);
      if (!ready.ok) {
        void chrome.tabs.create({ url: chrome.runtime.getURL(`studio.html?view=settings&setup=1&resume=${tab.id}&cmd=${command}`) });
        window.close();
        return;
      }
    }
    void chrome.runtime.sendMessage({ type: 'popup-command', command, tabId: tab.id, format: command === 'download-chapter' ? fmt : undefined });
    if (command !== 'toggle-original') window.close();
  };
  const open = (path: string) => void chrome.tabs.create({ url: chrome.runtime.getURL(path) });
  const missing = s.pipeline === 'standalone' && !vision?.vision;
  const on = s.enabled !== false;
  const toggle = async () => {
    const next = !on;
    setS({ ...s, enabled: next });
    setBusy(0);
    const r = (await chrome.runtime.sendMessage({ type: 'set-enabled', enabled: next })) as { unloaded?: string[] } | undefined;
    setUnloaded(r?.unloaded ?? []);
  };
  const power = (
    <label className="ait-switch" title={on ? 'Выключить AI Translate' : 'Включить AI Translate'} data-testid="power">
      <input type="checkbox" role="switch" checked={on} onChange={() => void toggle()} aria-label="AI Translate включён" />
      <span>{on ? 'Вкл' : 'Выкл'}</span>
    </label>
  );
  if (!on) {
    return (
      <div className="pp">
        <header className="pp-head">
          <span className="pp-mark">AI Translate</span>
          {power}
        </header>
        <div className="ait-notice" data-testid="off-notice">
          Расширение выключено: не переводит, не показывает кнопки на картинках и не держит модель в видеопамяти.
          {unloaded?.length ? ` Выгружено из памяти: ${unloaded.join(', ')}.` : ''}
        </div>
        <button className="ait-bubble-btn pp-main" onClick={() => void toggle()}>Включить</button>
      </div>
    );
  }

  return (
    <div className="pp">
      <header className="pp-head">
        <span className="pp-mark">AI Translate</span>
        <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span className={`ait-badge ${s.privacy === 'local' ? 'local' : ''}`}>{s.privacy === 'local' ? '🔒 Локально' : s.privacy === 'hybrid' ? 'Гибрид' : 'Облако'}</span>
          {power}
        </span>
      </header>

      {missing ? (
        <div className="ait-notice">Выберите модель, которая читает изображения. <button className="pp-link" onClick={() => chrome.runtime.openOptionsPage()}>Открыть настройки</button></div>
      ) : null}
      {s.pipeline === 'standalone' ? (
        <ModelCheckCard compact settings={s} update={update} getKey={(id) => secrets.get(`provider:${id}`)} onOpenSettings={(download) => open(download ? 'studio.html?view=settings&pull=1' : 'studio.html?view=settings')} />
      ) : null}
      {s.pipeline === 'standalone' ? <VramLine settings={s} /> : null}
      {engine === 'down' ? <div className="ait-error">Движок не отвечает по адресу {s.engine.url}. Запустите его или переключитесь в режим без движка.</div> : null}
      {engine === 'unpaired' ? <div className="ait-notice">Движок запущен, но код сопряжения не подходит. Введите его в настройках.</div> : null}

      <button className="ait-bubble-btn pp-main" disabled={!canRun || missing} onClick={() => void command('translate-page')}>
        {preflight ? 'Проверяю программы…' : 'Перевести страницу'}
      </button>
      <div className="pp-row" data-testid="download-row">
        <button className="ait-btn" disabled={!canRun || missing} onClick={() => void command('download-chapter')} title="Перевести все картинки страницы и скачать главу одним файлом">
          Перевести и скачать
        </button>
        <select className="ait-select" style={{ flex: '0 0 92px' }} value={fmt} onChange={(e) => setFmt(e.target.value as typeof fmt)} aria-label="Формат файла">
          <option value="pdf">PDF</option>
          <option value="cbz">CBZ</option>
          <option value="epub">EPUB</option>
          <option value="zip">ZIP</option>
        </select>
        <select
          className="ait-select"
          style={{ flex: '0 0 112px' }}
          value={s.exportPageLength ?? 'normal'}
          disabled={fmt === 'zip'}
          onChange={(e) => update({ exportPageLength: e.target.value as AppSettings['exportPageLength'] })}
          aria-label="Длина страницы"
          title="Как резать длинную ленту вебтуна на страницы"
        >
          <option value="normal">Обычные стр.</option>
          <option value="long">Длинные стр.</option>
          <option value="whole">Без нарезки</option>
        </select>
      </div>
      <div className="pp-row">
        <button className="ait-btn" disabled={!canRun} onClick={() => void command('select-area')}>Перевести область</button>
        <button
          className="ait-btn"
          disabled={!canRun}
          data-testid="toggle-langs"
          title={langs?.showingOriginal ? 'Показать перевод' : 'Показать оригинал'}
          onClick={() => {
            void command('toggle-original');
            if (langs) setLangs({ ...langs, showingOriginal: !langs.showingOriginal });
          }}
        >
          {langs?.translated ? `⇄ ${langs.showingOriginal ? nativeName(langs.target) : nativeName(langs.source) || 'Оригинал'}` : `${nativeName(s.sourceLang === 'auto' ? undefined : s.sourceLang) || 'Оригинал'} ⇄ ${nativeName(s.targetLang)}`}
        </button>
      </div>
      {busy && tab?.id !== undefined ? (
        <button
          className="ait-btn danger"
          onClick={() => {
            void chrome.runtime.sendMessage({ type: 'cancel-all', tabId: tab.id });
            setBusy(0);
          }}
        >
          Остановить перевод ({busy} в работе)
        </button>
      ) : null}
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
          <span>Сервер модели</span>
          <select className="ait-select" value={s.visionProviderId ?? ''} onChange={(e) => update({ visionProviderId: e.target.value || null })}>
            <option value="">— не выбран —</option>
            {s.providers.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
        </label>
        {vision ? (
          <div className="ait-field" style={{ gridColumn: '1 / -1' }}>
            <span>Модель</span>
            <ModelPicker
              compact
              cfg={vision}
              getKey={() => secrets.get(`provider:${vision.id}`)}
              onPick={(model, canSee) => {
                update({ providers: s.providers.map((p) => (p.id === vision.id ? { ...p, model, vision: canSee ?? p.vision } : p)) });
              }}
            />
            {vision.vision === false ? <small className="ait-muted">Эта модель не читает картинки — выберите модель с 👁.</small> : null}
          </div>
        ) : null}
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
      <div className="pp-update">
        <UpdateCheck compact current={chrome.runtime.getManifest().version} install={async () => open('studio.html?view=settings&update=1')} />
      </div>
    </div>
  );
}

void loadBundledFonts();
createRoot(document.getElementById('root')!).render(<Popup />);
