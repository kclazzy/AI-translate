import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { emptyContext, type AppSettings, type TranslationContext } from '@ait/core';
import { CachedPageEditor } from './editor/EditorHost';
import { loadBundledFonts } from './fonts';
import { PlatformContext, usePlatform, type StudioPlatform } from './platform';
import { ContextEditor, GlossaryEditor } from './panels/GlossaryPanel';
import { HistoryPanel, PrivacyPanel } from './panels/InfoPanels';
import { ProjectPanel } from './panels/ProjectPanel';
import { QuickPanel } from './panels/QuickPanel';
import { SettingsPanel } from './panels/SettingsPanel';
import { SetupWizard } from './panels/SetupWizard';
import { Icon, ToastHost } from './ui';

export type View = 'quick' | 'projects' | 'glossary' | 'settings' | 'privacy' | 'history' | 'editor';

export interface StudioAppProps {
  platform: StudioPlatform;
  initialView?: View;
  /** Open a cached result in the editor (extension "Edit" button). */
  resultKey?: string;
  /** Files handed over by the OS share sheet / file picker. */
  sharedFiles?: File[];
}

function applyTheme(theme: AppSettings['theme']) {
  if (theme === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme);
}

function SeriesContexts() {
  const { db } = usePlatform();
  const [items, setItems] = useState<[string, TranslationContext][]>([]);
  const [key, setKey] = useState<string>('');
  useEffect(() => {
    void db.entries<TranslationContext>('contexts').then((e) => {
      setItems(e);
      if (e.length && !key) setKey(e[0][0]);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db]);
  const ctx = items.find(([k]) => k === key)?.[1];
  if (!items.length) return <div className="ait-panel ait-muted">Контексты серий появятся после перевода страниц на сайтах. Для проектов контекст хранится внутри проекта.</div>;
  return (
    <>
      <div className="ait-panel">
        <label className="ait-field">
          <span>Серия (сайт)</span>
          <select className="ait-select" value={key} onChange={(e) => setKey(e.target.value)}>
            {items.map(([k]) => <option key={k} value={k}>{k}</option>)}
          </select>
        </label>
      </div>
      {ctx ? (
        <ContextEditor
          context={ctx}
          onChange={(c) => {
            setItems(items.map(([k, v]) => [k, k === key ? c : v]));
            void db.put('contexts', key, c);
          }}
        />
      ) : null}
      {ctx ? (
        <button className="ait-btn small danger" onClick={async () => { await db.put('contexts', key, emptyContext(key, key)); setItems(items.map(([k, v]) => [k, k === key ? emptyContext(key, key) : v])); }}>
          Сбросить контекст серии
        </button>
      ) : null}
    </>
  );
}

export function StudioApp({ platform, initialView, resultKey, sharedFiles }: StudioAppProps) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [view, setView] = useState<View>(initialView ?? (resultKey ? 'editor' : 'quick'));
  const [editKey, setEditKey] = useState<string | undefined>(resultKey);
  const saveChain = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    void loadBundledFonts();
    void platform.loadSettings().then((s) => {
      setSettings(s);
      applyTheme(s.theme);
    });
  }, [platform]);

  const update = useCallback(
    (patch: Partial<AppSettings>) => {
      setSettings((prev) => {
        if (!prev) return prev;
        const next = { ...prev, ...patch };
        if (patch.theme) applyTheme(patch.theme);
        // Save at once: the translation service reads settings from storage, not from React state.
        saveChain.current = saveChain.current.then(() => platform.saveSettings(next)).catch(() => undefined);
        return next;
      });
    },
    [platform],
  );

  if (!settings) return <div className="ait-content ait-muted">Загрузка…</div>;
  if (platform.kind === 'mobile' && !settings.onboarded) {
    return (
      <PlatformContext.Provider value={platform}>
        <SetupWizard settings={settings} update={update} onDone={() => setView('quick')} />
        <ToastHost />
      </PlatformContext.Provider>
    );
  }

  const nav: { id: View; label: string; long?: string; icon: ReactNode }[] = [
    { id: 'quick', label: 'Картинка', long: 'Перевести картинку', icon: <Icon.Edit /> },
    { id: 'projects', label: 'Главы', long: 'Главы и проекты', icon: <Icon.Book /> },
    { id: 'glossary', label: 'Словарь', long: 'Глоссарий и контекст', icon: <Icon.Gloss /> },
    { id: 'history', label: 'История', icon: <Icon.Clock /> },
    { id: 'settings', label: 'Настройки', icon: <Icon.Gear /> },
  ];
  const titles: Record<View, string> = {
    quick: 'Перевести картинку',
    projects: 'Главы и проекты',
    glossary: 'Глоссарий и контекст',
    settings: 'Настройки',
    privacy: 'Приватность',
    history: 'История',
    editor: 'Редактор',
  };

  return (
    <PlatformContext.Provider value={platform}>
      <div className="ait-app">
        <nav className="ait-side" aria-label="Разделы">
          <div className="ait-mark">
            AI Translate
            <small>переводчик манги и комиксов</small>
          </div>
          {nav.map((n) => (
            <button key={n.id} className="ait-nav-btn" aria-current={view === n.id ? 'page' : undefined} onClick={() => setView(n.id)}>
              {n.icon}
              <span className="label-long">{n.long ?? n.label}</span>
              <span className="label-short">{n.label}</span>
            </button>
          ))}
          <div className="ait-side-foot">
            <button className="ait-nav-btn" aria-current={view === 'privacy' ? 'page' : undefined} onClick={() => setView('privacy')}>
              <Icon.Lock />
              <span>{settings.privacy === 'local' ? 'Локальный режим' : 'Приватность'}</span>
            </button>
            <span className="ait-muted" style={{ fontSize: 12, padding: '0 10px' }}>v{platform.version}</span>
          </div>
        </nav>
        <main className="ait-main">
          <header className="ait-topbar">
            <h1>{titles[view]}</h1>
            <span className="spacer" />
            {settings.privacy === 'local' ? <span className="ait-badge local">🔒 Локально</span> : null}
            <span className="ait-badge">{settings.pipeline === 'engine' ? 'Движок' : 'Без движка'}</span>
          </header>
          <div className="ait-content" style={view === 'editor' ? { maxWidth: 'none' } : undefined}>
            {view === 'quick' ? <QuickPanel sharedFile={sharedFiles?.length === 1 && sharedFiles[0].type.startsWith('image/') ? sharedFiles[0] : null} onEdit={(k) => { setEditKey(k); setView('editor'); }} /> : null}
            {view === 'projects' ? <ProjectPanel settings={settings} initialFiles={sharedFiles && sharedFiles.length > 1 ? sharedFiles : undefined} /> : null}
            {view === 'glossary' ? (
              <>
                <GlossaryEditor title="Общий глоссарий" entries={settings.glossary} onChange={(glossary) => update({ glossary })} />
                <SeriesContexts />
              </>
            ) : null}
            {view === 'settings' ? <SettingsPanel settings={settings} update={update} /> : null}
            {view === 'privacy' ? <PrivacyPanel settings={settings} /> : null}
            {view === 'history' ? <HistoryPanel onOpen={(k) => { setEditKey(k); setView('editor'); }} /> : null}
            {view === 'editor' ? (editKey ? <CachedPageEditor resultKey={editKey} settings={settings} onClose={() => setView('quick')} /> : <p className="ait-muted">Откройте страницу из истории или переведите картинку.</p>) : null}
          </div>
        </main>
        <ToastHost />
      </div>
    </PlatformContext.Provider>
  );
}
