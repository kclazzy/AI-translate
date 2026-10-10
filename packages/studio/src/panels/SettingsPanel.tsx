import { useEffect, useRef, useState } from 'react';
import {
  applyPreset,
  CHECKER_KEY_URL,
  CHECKER_LABELS,
  checkerIsCloud,
  type CheckerConfig,
  type CheckerKind,
  type CrossCheckSettings,
  configFromPreset,
  presetFrom,
  createProvider,
  EngineClient,
  isLocalProvider,
  LANGUAGES,
  listOpenAiModels,
  maskKey,
  PROVIDER_PRESETS,
  shortId,
  type AppSettings,
  type PromptProfile,
  type ProviderConfig,
} from '@ait/core';
import { buildReport } from '../report';
import { readSettingsFile, settingsToFile } from '../settingsFile';
import { LocalModels, LocalSetup, ModelCheckCard, ModelPicker, UpdateCheck } from '../ModelPicker';
import { usePlatform } from '../platform';
import { LamaGetButton, lamaModeOf, useLamaDownloaded } from '../lama';
import { ErrorBox, Field, FoldPanel, NumberInput, Segmented, Switch, toast, useAction } from '../ui';
import { resolveUiLang, tr, UI_LANGS } from '@ait/core/i18n';

export interface SettingsProps {
  settings: AppSettings;
  update: (patch: Partial<AppSettings>) => void;
}

/** «Как подключить»: where to get the key, which model to pick, what it costs. */
export function ProviderGuideBox({ preset, open, title }: { preset: (typeof PROVIDER_PRESETS)[number] | undefined; open?: boolean; title?: string }) {
  const g = preset?.guide;
  if (!g) return null;
  return (
    <details className="ait-guide" open={open} data-testid={`guide-${preset!.preset}`}>
      <summary>{title ?? tr('Как подключить')}</summary>
      <ol>
        {g.steps.map((step, i) => (
          <li key={i}>{tr(step)}</li>
        ))}
      </ol>
      {g.keyUrl ? (
        <p>
          <a href={g.keyUrl} target="_blank" rel="noreferrer noopener">
            {preset!.needsKey ? tr('Открыть страницу ключей') : tr('Открыть страницу загрузки')} ↗
          </a>
        </p>
      ) : null}
      {g.models ? <p><b>{tr('Модель:')}</b> {tr(g.models)}</p> : null}
      {g.cost ? <p><b>{tr('Стоимость:')}</b> {tr(g.cost)}</p> : null}
      {g.note ? <p className="ait-guide-note">{tr(g.note)}</p> : null}
    </details>
  );
}

function ProviderEditor({ cfg, onChange, onRemove, onUse, inUse }: { cfg: ProviderConfig; onChange: (c: ProviderConfig) => void; onRemove: () => void; onUse?: () => void; inUse?: boolean }) {
  const platform = usePlatform();
  const [key, setKey] = useState('');
  const [stored, setStored] = useState<string | undefined>();
  const [models, setModels] = useState<string[]>([]);
  const preset = PROVIDER_PRESETS.find((p) => p.preset === cfg.preset);

  useEffect(() => {
    void platform.secrets.get(`provider:${cfg.id}`).then(setStored);
  }, [platform, cfg.id]);

  const test = useAction(async () => {
    const apiKey = key || stored;
    if (cfg.kind === 'openai-compatible') {
      try {
        const list = await listOpenAiModels(cfg.baseUrl, apiKey);
        setModels(list.slice(0, 200));
        toast(tr('Подключено: {0} моделей', list.length));
        return;
      } catch {
        /* some endpoints have no /models; fall back to a tiny completion */
      }
    }
    const p = createProvider({ ...cfg, apiKey, maxOutputTokens: 16 });
    await p.complete({ system: 'Reply with OK.', messages: [{ role: 'user', content: 'ping' }] });
    toast(tr('Подключено'));
  });

  const saveKey = async () => {
    await platform.secrets.set(`provider:${cfg.id}`, key.trim());
    setStored(key.trim() || undefined);
    setKey('');
    toast(key.trim() ? tr('Ключ сохранён в зашифрованном виде') : tr('Ключ удалён'));
  };

  return (
    <div className="ait-panel">
      <div className="ait-row" style={{ alignItems: 'center' }}>
        <strong style={{ flex: '1 1 auto' }}>{tr(cfg.label)}</strong>
        <span className={`ait-badge ${isLocalProvider(cfg) ? 'local' : ''}`} style={{ flex: '0 0 auto' }}>
          {isLocalProvider(cfg) ? tr('на устройстве / в сети') : tr('облако')}
        </span>
        <button className="ait-btn small danger" style={{ flex: '0 0 auto' }} onClick={onRemove}>
          {tr('Удалить')}
        </button>
      </div>
      {preset?.hint ? <p className="ait-hint">{tr(preset.hint)}</p> : null}
      <ProviderGuideBox preset={preset} open={!!preset?.needsKey && !stored} />
      <div className="ait-grid2" style={{ marginTop: 12 }}>
        <Field label={tr('Название')}>
          <input className="ait-input" value={tr(cfg.label)} onChange={(e) => onChange({ ...cfg, label: e.target.value })} />
        </Field>
        <Field label={tr('Адрес API (base URL)')}>
          <input className="ait-input" value={cfg.baseUrl} onChange={(e) => onChange({ ...cfg, baseUrl: e.target.value.trim() })} />
        </Field>
        <Field label={tr('Модель')} hint={preset?.needsKey && !stored ? tr('Сохраните ключ — и список моделей загрузится сам') : tr('⟳ — получить список моделей с сервера')}>
          <ModelPicker cfg={cfg} hasKey={preset?.needsKey ? !!stored : undefined} getKey={async () => key || stored} onPick={(model, vision) => onChange({ ...cfg, model, vision: vision ?? cfg.vision })} />
          <input className="ait-input" value={cfg.model} onChange={(e) => onChange({ ...cfg, model: e.target.value.trim() })} aria-label={tr('Имя модели вручную')} placeholder={tr('или введите имя вручную')} />
        </Field>
        <Field label={tr('Ключ API')} hint={stored ? tr('Сохранён: {0}', maskKey(stored)) : preset?.needsKey ? tr('Нужен для этого сервиса') : tr('Не нужен для локальных серверов')}>
          <div style={{ display: 'flex', gap: 6 }}>
            <input className="ait-input" type="password" autoComplete="off" placeholder={stored ? '••••••••' : 'sk-…'} value={key} onChange={(e) => setKey(e.target.value)} />
            <button className="ait-btn" onClick={saveKey}>{tr('Сохранить')}</button>
          </div>
        </Field>
      </div>
      <div className="ait-row" style={{ marginTop: 12, alignItems: 'center' }}>
        <Switch checked={cfg.vision} onChange={(v) => onChange({ ...cfg, vision: v })} label={tr('Модель понимает изображения (vision)')} />
        <Switch checked={cfg.jsonMode === 'json_object'} onChange={(v) => onChange({ ...cfg, jsonMode: v ? 'json_object' : 'none' })} label={tr('JSON-режим')} />
        <button className="ait-btn" style={{ flex: '0 0 auto' }} onClick={() => void test.run()} disabled={test.busy}>
          {test.busy ? tr('Проверка…') : tr('Проверить подключение')}
        </button>
        {onUse ? (
          <button className="ait-btn" style={{ flex: '0 0 auto' }} onClick={onUse} disabled={inUse} data-testid="use-provider">
            {inUse ? tr('Используется') : tr('Использовать для перевода')}
          </button>
        ) : null}
      </div>
      <div className="ait-grid2" style={{ marginTop: 10 }}>
        <Field label={tr('Цена ввода, $ за 1M токенов')} hint={tr('Для оценки стоимости в отладке')}>
          <input className="ait-input" type="number" min={0} step="0.01" value={cfg.priceInput ?? ''} onChange={(e) => onChange({ ...cfg, priceInput: e.target.value === '' ? undefined : Number(e.target.value) })} />
        </Field>
        <Field label={tr('Ждать ответ, секунд')} hint={tr('Большим локальным моделям нужно больше времени')}>
          <input className="ait-input" type="number" min={10} max={3600} placeholder={isLocalProvider(cfg) ? '600' : '120'} value={cfg.timeoutMs ? Math.round(cfg.timeoutMs / 1000) : ''} onChange={(e) => onChange({ ...cfg, timeoutMs: e.target.value ? Number(e.target.value) * 1000 : undefined })} />
        </Field>
        <Field label={tr('Режим размышлений')}>
          <select className="ait-select" value={cfg.noThinking === undefined ? 'auto' : cfg.noThinking ? 'off' : 'on'} onChange={(e) => onChange({ ...cfg, noThinking: e.target.value === 'auto' ? undefined : e.target.value === 'off' })}>
            <option value="auto">{tr('Авто (выключен для локальных)')}</option>
            <option value="off">{tr('Выключить (быстрее)')}</option>
            <option value="on">{tr('Оставить')}</option>
          </select>
        </Field>
        <Field label={tr('Цена вывода, $ за 1M токенов')}>
          <input className="ait-input" type="number" min={0} step="0.01" value={cfg.priceOutput ?? ''} onChange={(e) => onChange({ ...cfg, priceOutput: e.target.value === '' ? undefined : Number(e.target.value) })} />
        </Field>
      </div>
      <ErrorBox error={test.error} />
    </div>
  );
}

function ProfileEditor({ p, onChange }: { p: PromptProfile; onChange: (p: PromptProfile) => void }) {
  return (
    <div className="ait-grid2">
      <Field label={tr('Название профиля')}>
        <input className="ait-input" value={tr(p.name)} onChange={(e) => onChange({ ...p, name: e.target.value })} />
      </Field>
      <Field label={tr('Honorifics (-сан, -кун)')}>
        <select className="ait-select" value={p.honorifics} onChange={(e) => onChange({ ...p, honorifics: e.target.value as PromptProfile['honorifics'] })}>
          <option value="keep">{tr('Сохранять')}</option>
          <option value="adapt">{tr('Адаптировать')}</option>
          <option value="drop">{tr('Убирать')}</option>
        </select>
      </Field>
      <Field label={tr('Имена')}>
        <select className="ait-select" value={p.names} onChange={(e) => onChange({ ...p, names: e.target.value as PromptProfile['names'] })}>
          <option value="transliterate">{tr('Транслитерировать')}</option>
          <option value="keep-original">{tr('Оставлять латиницей')}</option>
          <option value="adapt">{tr('Адаптировать')}</option>
        </select>
      </Field>
      <Field label={tr('Тон')}>
        <input className="ait-input" placeholder={tr('например: дерзкий, подростковый сленг')} value={p.tone} onChange={(e) => onChange({ ...p, tone: e.target.value })} />
      </Field>
      <div style={{ gridColumn: '1 / -1' }}>
        <Field label={tr('Инструкции для модели')}>
          <textarea className="ait-textarea" value={p.customPrompt} onChange={(e) => onChange({ ...p, customPrompt: e.target.value })} />
        </Field>
      </div>
    </div>
  );
}

/** How much space the app takes on this device, with buttons to free it. */
/** Text over artwork: redraw the background with LaMa — off, in the local engine, or in this browser. */
function LamaChoice({ settings: s, update, offer }: { settings: AppSettings; update: (p: Partial<AppSettings>) => void; offer?: boolean }) {
  const platform = usePlatform();
  const mode = lamaModeOf(s);
  const [have, setHave] = useLamaDownloaded();
  const [pct, setPct] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  // Came from the offer on a page (?offer=lama): show this setting right away.
  const highlight = !!offer && !!platform.lama;
  useEffect(() => {
    if (highlight) ref.current?.scrollIntoView({ block: 'center' });
  }, [highlight]);
  const ready = mode === 'browser' && have;
  return (
    <div ref={ref} className={highlight ? 'ait-offer' : undefined} style={{ display: 'grid', gap: 6 }} data-testid="lama">
      <label className="ait-field">
        <span>{tr('Дорисовка фона под текстом на рисунке (нейросеть LaMa)')}</span>
        <select className="ait-select" value={mode} onChange={(e) => update({ lamaMode: e.target.value as AppSettings['lamaMode'], lamaEngine: undefined })}>
          <option value="off">{tr('Выключена — простая заливка')}</option>
          <option value="engine">{tr('В локальном движке')}</option>
          {platform.lama ? <option value="browser">{tr('Прямо в браузере (видеокарта, модель ~200 МБ)')}</option> : null}
        </select>
      </label>
      {highlight && !ready ? (
        <div style={{ display: 'grid', gap: 6 }}>
          <small className="ait-muted">{tr('Текст поверх рисунка стирается простой заливкой. LaMa дорисует фон под ним: волосы, одежду, пейзаж. Модель скачивается один раз и работает прямо в браузере.')}</small>
          <LamaGetButton update={update} primary downloaded={have} label={tr('Скачать и включить')} onDone={() => setHave(true)} testId="lama-offer" />
        </div>
      ) : null}
      {highlight && ready ? <span className="ait-badge ok" data-testid="lama-ready">{tr('LaMa включена — переведите страницу заново (⟳), чтобы дорисовать фон')}</span> : null}
      {mode === 'browser' && platform.lama ? (
        <span style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {have ? <span className="ait-badge ok">{tr('Модель скачана')}</span> : <span className="ait-badge">{tr('Модель не скачана — пока работает простая заливка')}</span>}
          {pct !== null ? (
            <span className="ait-progress" style={{ flex: 1, minWidth: 120 }} role="progressbar" aria-valuenow={Math.round(pct * 100)} aria-valuemin={0} aria-valuemax={100}>
              <i style={{ width: `${Math.round(pct * 100)}%` }} />
            </span>
          ) : have ? (
            <button className="ait-btn small danger" onClick={async () => { await platform.lama!.remove(); setHave(false); }}>{tr('Удалить модель')}</button>
          ) : (
            <button
              className="ait-btn small"
              onClick={async () => {
                setErr(null);
                setPct(0);
                try {
                  await platform.lama!.download(setPct);
                  setHave(true);
                } catch (e) {
                  setErr(e instanceof Error ? e.message : String(e));
                } finally {
                  setPct(null);
                }
              }}
            >
              {tr('Скачать модель (~200 МБ)')}
            </button>
          )}
          {err ? <small style={{ color: 'var(--err)' }}>{tr('Не удалось скачать: {0}', err)}</small> : null}
        </span>
      ) : null}
    </div>
  );
}

const CHECKER_KINDS: CheckerKind[] = ['deepl', 'google', 'yandex', 'libre', 'llm'];

/** «Сверка»: which translators to compare with, their keys, who judges, what to do with mistakes. */
function CrossCheckSettingsBox({ settings: s, update }: { settings: AppSettings; update: (p: Partial<AppSettings>) => void }) {
  const platform = usePlatform();
  const cc: CrossCheckSettings = s.crossCheck ?? { enabled: false, checkers: [], judge: 'main', mode: 'report' };
  const set = (patch: Partial<CrossCheckSettings>) => update({ crossCheck: { ...cc, ...patch } });
  const setChecker = (id: string, patch: Partial<CheckerConfig>) => set({ checkers: cc.checkers.map((c) => (c.id === id ? { ...c, ...patch } : c)) });
  const [keys, setKeys] = useState<Record<string, boolean>>({});
  useEffect(() => {
    void Promise.all(cc.checkers.map(async (c) => [c.id, !!(await platform.secrets.get(`checker:${c.id}`))] as const)).then((x) => setKeys(Object.fromEntries(x)));
  }, [cc.checkers.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const add = (kind: CheckerKind) => set({ checkers: [...cc.checkers, { id: shortId('c'), kind, enabled: true, ...(kind === 'libre' ? { url: 'http://127.0.0.1:5000' } : {}), ...(kind === 'llm' ? { providerId: s.providers[0]?.id } : {}) }] });
  const local = s.privacy === 'local';
  return (
    <div style={{ display: 'grid', gap: 8 }} data-testid="crosscheck">
      <Switch checked={cc.enabled} onChange={(enabled) => set({ enabled })} label={tr('Сверять каждую страницу после перевода')} />
      {cc.checkers.map((c) => {
        const cloud = checkerIsCloud(c, s.providers.find((p) => p.id === c.providerId));
        return (
          <div key={c.id} style={{ display: 'grid', gap: 4, padding: 8, border: '1px solid var(--rule)', borderRadius: 6 }}>
            <span style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <input type="checkbox" checked={c.enabled} onChange={(e) => setChecker(c.id, { enabled: e.target.checked })} aria-label={tr('Использовать {0}', CHECKER_LABELS[c.kind])} />
              <b style={{ flex: 1 }}>{c.kind === 'llm' ? tr('Модель') : CHECKER_LABELS[c.kind]}</b>
              {CHECKER_KEY_URL[c.kind] ? <a className="pp-link" href={CHECKER_KEY_URL[c.kind]} target="_blank" rel="noreferrer">{tr('где взять ключ')}</a> : null}
              <button className="ait-btn small danger" aria-label={tr('Убрать {0}', CHECKER_LABELS[c.kind])} onClick={() => set({ checkers: cc.checkers.filter((x) => x.id !== c.id) })}>✕</button>
            </span>
            {c.kind === 'llm' ? (
              <select className="ait-select" value={c.providerId ?? ''} onChange={(e) => setChecker(c.id, { providerId: e.target.value })} aria-label={tr('Модель для сверки')}>
                {s.providers.map((p) => <option key={p.id} value={p.id}>{tr(p.label)} — {p.model}</option>)}
              </select>
            ) : null}
            {c.kind === 'libre' ? <input className="ait-input" value={c.url ?? ''} onChange={(e) => setChecker(c.id, { url: e.target.value })} placeholder="http://127.0.0.1:5000" aria-label={tr('Адрес LibreTranslate')} /> : null}
            {c.kind === 'yandex' ? <input className="ait-input" value={c.folderId ?? ''} onChange={(e) => setChecker(c.id, { folderId: e.target.value || undefined })} placeholder={tr('ID каталога (нужен только для IAM-токена)')} aria-label={tr('ID каталога Yandex Cloud')} /> : null}
            {c.kind !== 'llm' ? (
              <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input
                  className="ait-input"
                  type="password"
                  placeholder={keys[c.id] ? tr('ключ сохранён — введите новый, чтобы заменить') : c.kind === 'libre' ? tr('ключ (если сервер требует)') : tr('ключ API')}
                  aria-label={tr('Ключ {0}', CHECKER_LABELS[c.kind])}
                  onBlur={async (e) => {
                    const v = e.target.value.trim();
                    if (!v) return;
                    await platform.secrets.set(`checker:${c.id}`, v);
                    e.target.value = '';
                    setKeys((k) => ({ ...k, [c.id]: true }));
                    toast(tr('Ключ сохранён'));
                  }}
                />
              </span>
            ) : null}
            {cloud && local ? <small style={{ color: 'var(--err)' }}>{tr('Включён локальный режим: этот переводчик в облаке и спрашиваться не будет.')}</small> : null}
          </div>
        );
      })}
      <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {CHECKER_KINDS.map((k) => (
          <button key={k} className="ait-btn small" onClick={() => add(k)}>+ {k === 'llm' ? tr('Модель') : CHECKER_LABELS[k]}</button>
        ))}
      </span>
      <label className="ait-field">
        <span>{tr('Кто сравнивает')}</span>
        <select className="ait-select" value={cc.judge} onChange={(e) => set({ judge: e.target.value })}>
          <option value="main">{tr('Модель, которая переводит')}</option>
          {s.providers.map((p) => <option key={p.id} value={p.id}>{tr(p.label)} — {p.model}</option>)}
          <option value="none">{tr('Никто — только показать другие варианты')}</option>
        </select>
      </label>
      <label className="ait-field">
        <span>{tr('Если найдена ошибка')}</span>
        <select className="ait-select" value={cc.mode} onChange={(e) => set({ mode: e.target.value as CrossCheckSettings['mode'] })}>
          <option value="report">{tr('Только показать в редакторе')}</option>
          <option value="fix">{tr('Исправлять сразу (старый вариант можно вернуть)')}</option>
        </select>
      </label>
      <small className="ait-muted">{tr('Без судьи строка помечается, если перевод почти не совпадает ни с одним другим. Сверить страницу можно и вручную — кнопкой «Сверить» в редакторе.')}</small>
    </div>
  );
}

type DirPicker = (o?: { mode?: string; id?: string }) => Promise<FileSystemDirectoryHandle>;
type PermHandle = FileSystemDirectoryHandle & { queryPermission?: (o: { mode: string }) => Promise<string>; requestPermission?: (o: { mode: string }) => Promise<string> };

/** «Сохранять каждую переведённую картинку»: the user picks the folder first, then switches it on. */
function AutoSaveFolder({ settings: s, update }: { settings: AppSettings; update: (p: Partial<AppSettings>) => void }) {
  const platform = usePlatform();
  const picker = (window as unknown as { showDirectoryPicker?: DirPicker }).showDirectoryPicker;
  const [state, setState] = useState<'granted' | 'ask' | 'none'>('none');
  const check = async () => {
    if (!s.autoSaveDir) return setState('none');
    if (s.autoSaveDir === 'downloads') return setState('granted');
    const h = await platform.db.get<PermHandle>('kv', 'autosave-dir');
    if (!h) return setState('none');
    setState((await h.queryPermission?.({ mode: 'readwrite' })) === 'granted' ? 'granted' : 'ask');
  };
  useEffect(() => {
    void check();
  }, [s.autoSaveDir]); // eslint-disable-line react-hooks/exhaustive-deps
  const choose = async () => {
    if (!picker) {
      update({ autoSaveDir: 'downloads' });
      return;
    }
    try {
      const h = (await picker({ mode: 'readwrite', id: 'ait-autosave' })) as PermHandle;
      if ((await h.requestPermission?.({ mode: 'readwrite' })) === 'denied') return;
      await platform.db.put('kv', 'autosave-dir', h);
      await platform.db.delete('kv', 'autosave-blocked');
      update({ autoSaveDir: h.name });
      setState('granted');
    } catch {
      /* the user closed the picker */
    }
  };
  const allow = async () => {
    const h = await platform.db.get<PermHandle>('kv', 'autosave-dir');
    if (h && (await h.requestPermission?.({ mode: 'readwrite' })) === 'granted') {
      await platform.db.delete('kv', 'autosave-blocked');
      setState('granted');
    }
  };
  const where = s.autoSaveDir === 'downloads' ? tr('Загрузки/AI Translate') : s.autoSaveDir;
  return (
    <div style={{ display: 'grid', gap: 6 }} data-testid="autosave">
      <span style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span>{tr('Папка для картинок:')}</span>
        <b data-testid="autosave-dir">{where || tr('не выбрана')}</b>
        <button className="ait-btn small" onClick={() => void choose()}>{picker ? (s.autoSaveDir ? tr('Сменить папку…') : tr('Выбрать папку…')) : tr('Сохранять в Загрузки/AI Translate')}</button>
      </span>
      {state === 'ask' ? (
        <span className="ait-notice" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {tr('Браузер просит заново разрешить запись в папку «{0}». Пока разрешения нет, картинки сохраняются в Загрузки/AI Translate.', where ?? '')}
          <button className="ait-btn small" onClick={() => void allow()}>{tr('Разрешить')}</button>
        </span>
      ) : null}
      <Switch
        checked={!!s.autoSave && !!s.autoSaveDir}
        disabled={!s.autoSaveDir}
        onChange={(autoSave) => update({ autoSave })}
        label={s.autoSaveDir ? tr('Сохранять каждую переведённую картинку в «{0}/<сайт>/<глава>»', where ?? '') : tr('Сохранять каждую переведённую картинку (сначала выберите папку)')}
      />
    </div>
  );
}

function StorageLine() {
  const platform = usePlatform();
  const [used, setUsed] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const measure = () => void navigator.storage?.estimate?.().then((e) => setUsed(e.usage ?? null)).catch(() => undefined);
  useEffect(measure, []);
  const clear = async (store: 'results' | 'history', what: string) => {
    if (!confirm(tr('Удалить {0}? Это нельзя отменить.', what))) return;
    setBusy(true);
    await platform.db.clear(store);
    setBusy(false);
    toast(store === 'results' ? tr('Кэш очищен') : tr('История очищена'));
    measure();
  };
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginTop: 12 }} data-testid="storage-line">
      <span className="ait-muted">{tr('Занято на устройстве:')}{' '}{used === null ? '…' : tr('{0} МБ', (used / 1048576).toFixed(used > 104857600 ? 0 : 1))}</span>
      <button className="ait-btn small" disabled={busy} onClick={() => void clear('results', tr('переведённые страницы из кэша'))}>{tr('Очистить кэш')}</button>
      <button className="ait-btn small" disabled={busy} onClick={() => void clear('history', tr('записи истории'))}>{tr('Очистить историю')}</button>
    </div>
  );
}

export function SettingsPanel({ settings: s, update }: SettingsProps) {
  const platform = usePlatform();
  const params = new URLSearchParams(location.search);
  const getKey = (id: string) => platform.secrets.get(`provider:${id}`);
  useEffect(() => {
    if (params.get('update') === '1') document.getElementById('ait-update')?.scrollIntoView({ block: 'center' });
    if (params.get('updated')) toast(tr('Обновлено до версии {0}', params.get('updated')));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [addPreset, setAddPreset] = useState('anthropic');
  const [profileId, setProfileId] = useState(s.activeProfileId);
  const [siteKey, setSiteKey] = useState('');
  const engineTest = useAction(async () => {
    const h = await new EngineClient(s.engine.url, s.engine.token).health();
    toast(h.status === 'ok' && (h as { paired?: boolean }).paired !== false ? tr('Движок {0}: {1}{2}', h.version, h.device, h.gpu ? `, ${h.gpu}` : '') : tr('Движок отвечает, но код сопряжения не подошёл'));
  });

  const setProvider = (c: ProviderConfig) => update({ providers: s.providers.map((p) => (p.id === c.id ? c : p)) });
  const removeProvider = (id: string) =>
    update({
      providers: s.providers.filter((p) => p.id !== id),
      visionProviderId: s.visionProviderId === id ? null : s.visionProviderId,
      translationProviderId: s.translationProviderId === id ? null : s.translationProviderId,
    });
  const profile = s.profiles.find((p) => p.id === profileId) ?? s.profiles[0];
  const visionCandidates = s.providers.filter((p) => p.vision);
  const localProviders = s.providers.filter((p) => isLocalProvider(p));
  const cloudProviders = s.providers.filter((p) => !isLocalProvider(p));
  const addRow = (presets: typeof PROVIDER_PRESETS) => {
    const value = presets.some((p) => p.preset === addPreset) ? addPreset : presets[0]?.preset ?? '';
    return (
      <div className="ait-row">
        <Field label={tr('Добавить')}>
          <select className="ait-select" value={value} onChange={(e) => setAddPreset(e.target.value)}>
            {presets.map((p) => <option key={p.preset} value={p.preset}>{tr(p.label)}</option>)}
          </select>
        </Field>
        <div style={{ flex: '0 0 auto' }}>
          <button className="ait-btn" onClick={() => update({ providers: [...s.providers, configFromPreset(value, shortId(value + '-'))] })}>
            {tr('Добавить')}
          </button>
        </div>
      </div>
    );
  };
  const guideFor = (presets: typeof PROVIDER_PRESETS) => {
    const p = presets.find((x) => x.preset === addPreset) ?? presets[0];
    return <ProviderGuideBox preset={p} title={tr('Как подключить: {0}', tr(p?.label ?? ''))} />;
  };
  /** Make this provider read the pictures (or translate, if it cannot see) and allow the cloud for it. */
  const pickProvider = (p: ProviderConfig) => {
    const cloud = !isLocalProvider(p);
    if (p.vision) update({ visionProviderId: p.id, translationProviderId: null, ...(cloud ? { privacy: 'cloud' as const } : {}) });
    else update({ translationProviderId: p.id, ...(cloud && s.privacy === 'local' ? { privacy: 'hybrid' as const } : {}) });
    toast(p.vision ? tr('{0} теперь читает и переводит страницы', tr(p.label)) : tr('{0} теперь переводит текст', tr(p.label)));
  };

  return (
    <div>
      {params.get('setup') === '1' ? <LocalSetup settings={s} update={update} getKey={getKey} onReady={platform.setupReady ? () => platform.setupReady!(params) : undefined} /> : null}
      {s.pipeline === 'standalone' ? <ModelCheckCard settings={s} update={update} getKey={getKey} /> : null}
      {s.pipeline === 'standalone' && platform.kind === 'extension' ? <LocalModels settings={s} update={update} getKey={getKey} autoStart={params.get('pull') === '1'} /> : null}
      <div className="ait-panel">
        <h2>{tr('Как переводить')}</h2>
        <div className="ait-grid2">
          <Field label={tr('Исходный язык')}>
            <select className="ait-select" value={s.sourceLang} onChange={(e) => update({ sourceLang: e.target.value })}>
              <option value="auto">{tr('Определять автоматически')}</option>
              {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.native}</option>)}
            </select>
          </Field>
          <Field label={tr('Язык перевода')}>
            <select className="ait-select" value={s.targetLang} onChange={(e) => update({ targetLang: e.target.value })}>
              {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.native}</option>)}
            </select>
          </Field>
          <Field label={tr('Проверка перевода')} hint={tr('Ещё один короткий запрос на страницу: смысл, контекст, эмоции, персонажи, грамматика, термины')}>
            <select className="ait-select" value={s.qaMode ?? 'fix'} onChange={(e) => update({ qaMode: e.target.value as AppSettings['qaMode'] })}>
              <option value="fix">{tr('Исправлять ошибки автоматически')}</option>
              <option value="report">{tr('Только показывать замечания')}</option>
              <option value="off">{tr('Выключена (быстрее)')}</option>
            </select>
          </Field>
          <Field label={tr('Сверка с другими переводчиками')} hint={tr('Перевод сравнивается с DeepL, Google, Яндексом, LibreTranslate или другой моделью; расхождения видны в редакторе')}>
            <CrossCheckSettingsBox settings={s} update={update} />
          </Field>
          <Field label={tr('Наборы настроек')} hint={tr('Модель, качество и проверка — одним выбором (например «Быстро локально» и «Точно в облаке»)')}>
            <div style={{ display: 'grid', gap: 6 }} data-testid="presets">
              {(s.presets ?? []).map((p) => (
                <span key={p.id} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <b style={{ flex: 1 }}>{p.name}</b>
                  <small className="ait-muted">{Object.values(p.models).join(' + ')}</small>
                  <button className="ait-btn small" onClick={() => update(applyPreset(s, p))}>{tr('Применить')}</button>
                  <button className="ait-btn small danger" aria-label={tr('Удалить набор {0}', p.name)} onClick={() => update({ presets: (s.presets ?? []).filter((x) => x.id !== p.id) })}>✕</button>
                </span>
              ))}
              <button
                className="ait-btn small"
                style={{ justifySelf: 'start' }}
                onClick={() => {
                  const name = prompt(tr('Название набора'), tr('Набор {0}', (s.presets?.length ?? 0) + 1));
                  if (name?.trim()) update({ presets: [...(s.presets ?? []), presetFrom(s, name.trim())] });
                }}
              >
                {tr('Сохранить текущие как набор')}
              </button>
            </div>
          </Field>
          <Field label={tr('Качество')} hint={tr('Чем выше, тем крупнее картинка уходит модели и дольше ответ')}>
            <Segmented label={tr('Качество')} value={s.quality} onChange={(quality) => update({ quality })} options={[{ value: 'fast', label: tr('Быстро') }, { value: 'balanced', label: tr('Баланс') }, { value: 'best', label: tr('Максимум') }]} />
            <div style={{ marginTop: 8 }}>
              <Switch
                checked={s.twoStepTranslation ?? (s.quality !== 'fast' && !s.fastLocal)}
                onChange={(twoStepTranslation) => update({ twoStepTranslation })}
                label={tr('Переводить отдельным шагом — точнее смысл и окончания слов, чуть дольше')}
              />
            </div>
            <div style={{ marginTop: 8 }}>
              <Switch
                checked={s.stitchStrips !== false}
                onChange={(stitchStrips) => update({ stitchStrips })}
                label={tr('Склеивать соседние картинки ленты (вебтун) — баблы на стыке не теряются')}
              />
            </div>
            <div style={{ marginTop: 8 }}>
              <Switch checked={!!s.bubblesOnly} onChange={(bubblesOnly) => update({ bubblesOnly })} label={tr('Только баблы: звуки и надписи на фоне оставлять как в оригинале')} />
            </div>
            <div style={{ marginTop: 8 }}>
              <Switch checked={!!s.onlySourceLang} onChange={(onlySourceLang) => update({ onlySourceLang })} label={tr('Переводить только текст на исходном языке (нужен выбранный исходный язык)')} />
            </div>
            <div style={{ marginTop: 8 }}>
              <Switch checked={s.autoApplyCached !== false} onChange={(autoApplyCached) => update({ autoApplyCached })} label={tr('Сразу показывать уже переведённые картинки, когда страница открывается снова')} />
            </div>
            <div style={{ marginTop: 8 }}>
              {platform.kind === 'extension' ? <AutoSaveFolder settings={s} update={update} /> : null}
            </div>
            <div style={{ marginTop: 8 }}>
              <label className="ait-field" data-testid="font-scale">
                <span>{tr('Размер текста перевода: {0}%', Math.round((s.fonts.scale ?? 1) * 100))}</span>
                <input type="range" min={0.6} max={1.5} step={0.05} value={s.fonts.scale ?? 1} onChange={(e) => update({ fonts: { ...s.fonts, scale: Number(e.target.value) } })} aria-label={tr('Размер текста перевода')} />
                <small className="ait-muted">{tr('Меньше 100% — текст мельче, чем помещается в бабл; больше — крупнее, пока помещается. Размер, заданный в редакторе вручную, не меняется.')}</small>
              </label>
            </div>
            <div style={{ marginTop: 8 }}>
              <label className="ait-field">
                <span>{tr('Стирать оригинал с запасом: {0} px', s.inpaintExpand ?? 3)}</span>
                <input type="range" min={0} max={12} value={s.inpaintExpand ?? 3} onChange={(e) => update({ inpaintExpand: Number(e.target.value) })} aria-label={tr('Запас вокруг букв при стирании')} />
                <small className="ait-muted">{tr('Больше — если вокруг перевода остаются следы старых букв; меньше — если стирается лишний рисунок.')}</small>
              </label>
            </div>
            <div style={{ marginTop: 8 }}>
              <LamaChoice settings={s} update={update} offer={params.get('offer') === 'lama'} />
            </div>
            <div style={{ marginTop: 8 }}>
              <Segmented label={tr('Страницы главы в редакторе')} value={s.editorPageList ?? 'bottom'} onChange={(editorPageList) => update({ editorPageList })} options={[{ value: 'bottom', label: tr('Снизу') }, { value: 'right', label: tr('Справа') }]} />
            </div>
          </Field>
          <Field label={tr('Звуки (SFX)')}>
            <div style={{ display: 'grid', gap: 8 }}>
              <Switch checked={s.translateSfx} onChange={(translateSfx) => update({ translateSfx })} label={tr('Переводить звуковые эффекты')} />
              <select className="ait-select" value={s.sfxStyle} onChange={(e) => update({ sfxStyle: e.target.value as AppSettings['sfxStyle'] })}>
                <option value="translated">{tr('Перевод')}</option>
                <option value="original">{tr('Оставить оригинал')}</option>
                <option value="small">{tr('Мелкий')}</option>
                <option value="large">{tr('Крупный')}</option>
                <option value="artistic">{tr('Художественный')}</option>
              </select>
            </div>
          </Field>
        </div>
      </div>

      <div className="ait-panel">
        <h2>{tr('Где обрабатывать')}</h2>
        <Segmented
          label={tr('Режим обработки')}
          value={s.pipeline}
          onChange={(pipeline) => update({ pipeline })}
          options={[
            { value: 'standalone', label: tr('Здесь (через модель)') },
            { value: 'engine', label: tr('Локальный движок') },
          ]}
        />
        <p className="ait-hint">
          {s.pipeline === 'standalone'
            ? tr('Изображение читает vision-модель, очистка и вёрстка выполняются прямо здесь. Работает без установки движка, в том числе на телефоне.')
            : tr('Поиск текста, OCR и очистку делает движок на ПК (GPU). Телефон может подключиться к нему по Wi-Fi.')}
        </p>
        {s.pipeline === 'engine' ? (
          <div className="ait-grid2" style={{ marginTop: 12 }}>
            <Field label={tr('Адрес движка')} hint={tr('На ПК: http://127.0.0.1:8765. С телефона: LAN-адрес из окна движка.')}>
              <input className="ait-input" value={s.engine.url} onChange={(e) => update({ engine: { ...s.engine, url: e.target.value.trim() } })} />
            </Field>
            <Field label={tr('Код сопряжения')} hint={tr('Показывается в окне движка при запуске')}>
              <input className="ait-input" value={s.engine.token} onChange={(e) => update({ engine: { ...s.engine, token: e.target.value.trim() } })} />
            </Field>
            <Field label={tr('Поиск текста')}>
              <select className="ait-select" value={s.engine.options.detector} onChange={(e) => update({ engine: { ...s.engine, options: { ...s.engine.options, detector: e.target.value as AppSettings['engine']['options']['detector'] } } })}>
                <option value="auto">{tr('Авто (баблы, иначе vision)')}</option>
                <option value="classic">{tr('Только баблы (без модели)')}</option>
                <option value="vision">{tr('Vision-модель')}</option>
              </select>
            </Field>
            <Field label={tr('Распознавание (OCR)')}>
              <select className="ait-select" value={s.engine.options.ocr} onChange={(e) => update({ engine: { ...s.engine, options: { ...s.engine.options, ocr: e.target.value as AppSettings['engine']['options']['ocr'] } } })}>
                <option value="auto">{tr('Авто')}</option>
                <option value="manga-ocr">{tr('manga-ocr (японский)')}</option>
                <option value="paddle">{tr('PaddleOCR (корейский, китайский)')}</option>
                <option value="vision">{tr('Vision-модель')}</option>
              </select>
            </Field>
            <Field label={tr('Очистка')}>
              <select className="ait-select" value={s.engine.options.inpainter} onChange={(e) => update({ engine: { ...s.engine, options: { ...s.engine.options, inpainter: e.target.value as AppSettings['engine']['options']['inpainter'] } } })}>
                <option value="auto">{tr('Авто')}</option>
                <option value="fill">{tr('Заливка цветом бабла')}</option>
                <option value="telea">OpenCV</option>
                <option value="lama">{tr('LaMa (нужна модель)')}</option>
              </select>
            </Field>
            <div style={{ alignSelf: 'end' }}>
              <button className="ait-btn" onClick={() => void engineTest.run()} disabled={engineTest.busy}>
                {tr('Проверить движок')}
              </button>
            </div>
          </div>
        ) : null}
        <ErrorBox error={engineTest.error} />
      </div>

      <div className="ait-panel">
        <h2>{tr('Модели')}</h2>
        <div className="ait-grid2">
          <Field label={tr('Читает изображение')} hint={tr('Нужна модель с поддержкой изображений')}>
            <select className="ait-select" value={s.visionProviderId ?? ''} onChange={(e) => update({ visionProviderId: e.target.value || null })}>
              <option value="">{tr('— не выбрано —')}</option>
              {visionCandidates.map((p) => <option key={p.id} value={p.id}>{tr(p.label)} · {p.model}</option>)}
            </select>
          </Field>
          <Field label={tr('Переводит текст')} hint={tr('Пусто — переводит та же модель за один запрос')}>
            <select className="ait-select" value={s.translationProviderId ?? ''} onChange={(e) => update({ translationProviderId: e.target.value || null })}>
              <option value="">{tr('Та же модель')}</option>
              {s.providers.map((p) => <option key={p.id} value={p.id}>{tr(p.label)} · {p.model}</option>)}
            </select>
          </Field>
          <Field label={tr('Приватность')}>
            <select className="ait-select" value={s.privacy} onChange={(e) => update({ privacy: e.target.value as AppSettings['privacy'] })}>
              <option value="local">{tr('Только локально — ничего не уходит наружу')}</option>
              <option value="hybrid">{tr('Гибрид — наружу уходит только текст')}</option>
              <option value="cloud">{tr('Облако — изображения могут уходить провайдеру')}</option>
            </select>
          </Field>
          <Field label={tr('Параллельных страниц')}>
            <NumberInput min={1} max={8} fallback={1} value={s.concurrency} onChange={(concurrency) => update({ concurrency })} />
          </Field>
        </div>
      </div>

      <FoldPanel title={tr('Локальные серверы')} summary={localProviders.map((p) => tr(p.label)).join(', ') || tr('нет')} testId="local-servers">
        {localProviders.map((p) => (
          <ProviderEditor key={p.id} cfg={p} onChange={setProvider} onRemove={() => removeProvider(p.id)} onUse={() => pickProvider(p)} inUse={p.vision ? s.visionProviderId === p.id && !s.translationProviderId : s.translationProviderId === p.id} />
        ))}
        {addRow(PROVIDER_PRESETS.filter((p) => p.local))}
        {guideFor(PROVIDER_PRESETS.filter((p) => p.local))}
      </FoldPanel>
      <FoldPanel title={tr('Облачные модели')} summary={cloudProviders.length ? cloudProviders.map((p) => tr(p.label)).join(', ') : tr('не подключены — Claude, OpenAI, Gemini, OpenRouter…')} testId="cloud-providers">
        {cloudProviders.map((p) => (
          <ProviderEditor key={p.id} cfg={p} onChange={setProvider} onRemove={() => removeProvider(p.id)} onUse={() => pickProvider(p)} inUse={p.vision ? s.visionProviderId === p.id && !s.translationProviderId : s.translationProviderId === p.id} />
        ))}
        {addRow(PROVIDER_PRESETS.filter((p) => !p.local))}
        {guideFor(PROVIDER_PRESETS.filter((p) => !p.local))}
      </FoldPanel>

      <div className="ait-panel">
        <h2>{tr('Профили перевода')}</h2>
        <div className="ait-row" style={{ marginBottom: 12 }}>
          <Field label={tr('Профиль')}>
            <select className="ait-select" value={profile.id} onChange={(e) => setProfileId(e.target.value)}>
              {s.profiles.map((p) => <option key={p.id} value={p.id}>{tr(p.name)}</option>)}
            </select>
          </Field>
          <div style={{ flex: '0 0 auto', display: 'flex', gap: 6 }}>
            <button className="ait-btn" onClick={() => update({ activeProfileId: profile.id })} disabled={s.activeProfileId === profile.id}>
              {s.activeProfileId === profile.id ? tr('Используется по умолчанию') : tr('Сделать основным')}
            </button>
            <button
              className="ait-btn"
              onClick={() => {
                const id = shortId('prof');
                update({ profiles: [...s.profiles, { ...profile, id, name: tr('{0} (копия)', tr(profile.name)) }] });
                setProfileId(id);
              }}
            >
              {tr('Копировать')}
            </button>
          </div>
        </div>
        <ProfileEditor p={profile} onChange={(np) => update({ profiles: s.profiles.map((x) => (x.id === np.id ? np : x)) })} />
        <h3>{tr('Профиль для конкретного сайта или серии')}</h3>
        <div className="ait-row">
          <Field label={tr('Сайт или серия')} hint={tr('Например: mangadex.org/title/abc')}>
            <input className="ait-input" value={siteKey} onChange={(e) => setSiteKey(e.target.value.trim())} />
          </Field>
          <div style={{ flex: '0 0 auto' }}>
            <button className="ait-btn" disabled={!siteKey} onClick={() => { update({ seriesProfiles: { ...s.seriesProfiles, [siteKey]: profile.id } }); setSiteKey(''); }}>
              {tr('Привязать «{0}»', tr(profile.name))}
            </button>
          </div>
        </div>
        {Object.entries(s.seriesProfiles).length ? (
          <table className="ait-table" style={{ marginTop: 10 }}>
            <tbody>
              {Object.entries(s.seriesProfiles).map(([k, v]) => (
                <tr key={k}>
                  <td>{k}</td>
                  <td>{tr(s.profiles.find((p) => p.id === v)?.name ?? v)}</td>
                  <td style={{ width: 1 }}>
                    <button className="ait-btn small ghost" onClick={() => { const next = { ...s.seriesProfiles }; delete next[k]; update({ seriesProfiles: next }); }}>{tr('Убрать')}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </div>

      <div className="ait-panel">
        <h2>{tr('Интерфейс и данные')}</h2>
        <div className="ait-grid2">
          <Field label={tr('Язык интерфейса')} hint={tr('«Как в системе» — язык браузера (в Windows — язык Windows). Страница перезагрузится.')}>
            <select className="ait-select" data-testid="ui-lang" value={s.interfaceLang ?? 'auto'} onChange={(e) => update({ interfaceLang: e.target.value })}>
              <option value="auto">{tr('Как в системе')} ({UI_LANGS.find((l) => l.code === resolveUiLang('auto'))?.native ?? 'English'})</option>
              {UI_LANGS.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.native}
                </option>
              ))}
            </select>
          </Field>
          <Field label={tr('Тема')}>
            <Segmented label={tr('Тема')} value={s.theme} onChange={(theme) => update({ theme })} options={[{ value: 'system', label: tr('Как в системе') }, { value: 'light', label: tr('Светлая') }, { value: 'dark', label: tr('Тёмная') }]} />
          </Field>
          <Field label={tr('Режим работы')}>
            <Segmented label={tr('Режим')} value={s.uiMode} onChange={(uiMode) => update({ uiMode })} options={[{ value: 'reader', label: tr('Читатель') }, { value: 'advanced', label: tr('Продвинутый') }, { value: 'scanlator', label: tr('Сканлейтер') }]} />
          </Field>
          <Field label={tr('Хранить кэш, дней')}>
            <NumberInput min={1} max={365} fallback={14} value={s.cacheDays} onChange={(cacheDays) => update({ cacheDays })} />
          </Field>
          <Field label={tr('Хранить историю, дней')} hint={tr('Старые записи удаляются сами')}>
            <NumberInput min={1} max={3650} fallback={30} value={s.historyDays ?? 30} onChange={(historyDays) => update({ historyDays })} />
          </Field>
          <Field label={tr('Длина страницы в PDF/CBZ/EPUB')} hint={tr('Как резать длинную ленту вебтуна при скачивании')}>
            <Segmented label={tr('Длина страницы')} value={s.exportPageLength ?? 'normal'} onChange={(exportPageLength) => update({ exportPageLength })} options={[{ value: 'normal', label: tr('Обычная') }, { value: 'long', label: tr('Длинная') }, { value: 'whole', label: tr('Без нарезки') }]} />
          </Field>
          <Field label={tr('Минимальный размер картинки, px')}>
            <NumberInput min={50} max={2000} fallback={200} value={s.minImageSize} onChange={(minImageSize) => update({ minImageSize })} />
          </Field>
        </div>
        <div style={{ display: 'grid', gap: 10, marginTop: 12 }}>
          <Switch checked={s.saveHistory} onChange={(saveHistory) => update({ saveHistory })} label={tr('Сохранять историю переводов')} />
          <Switch checked={s.debug} onChange={(debug) => update({ debug })} label={tr('Показывать отладку (время этапов, токены, стоимость)')} />
        </div>
        <StorageLine />
        <div style={{ marginTop: 14 }}>
          <span id="ait-update"><UpdateCheck current={platform.version} install={platform.installUpdate} autoCheck={params.get('update') === '1'} /></span>
        </div>
        <div style={{ marginTop: 14, display: 'grid', gap: 6 }} data-testid="settings-file">
          <b>{tr('Настройки в файл')}</b>
          <small className="ait-muted">{tr('Чтобы перенести модели, профили, глоссарий и наборы на другой компьютер. Ключи API в файл не попадают — их нужно ввести там заново.')}</small>
          <span style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="ait-btn small" onClick={() => void platform.saveFile(`ai-translate-settings-${new Date().toISOString().slice(0, 10)}.json`, new TextEncoder().encode(settingsToFile(s, platform.version)), 'application/json')}>
              {tr('Сохранить настройки')}
            </button>
            <label className="ait-btn small" style={{ cursor: 'pointer' }}>
              {tr('Загрузить настройки')}
              <input
                type="file"
                accept=".json"
                hidden
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  e.target.value = '';
                  if (!f) return;
                  let imported: ReturnType<typeof readSettingsFile>;
                  try {
                    imported = readSettingsFile(await f.text(), s);
                  } catch {
                    toast(tr('Это не файл настроек AI Translate'));
                    return;
                  }
                  const list = imported.changed.length ? `\n\n${tr('Новые или другие адреса (сохранённые ключи к ним не перейдут):')}\n${imported.changed.map((c) => `• ${c}`).join('\n')}` : '';
                  if (!confirm(tr('Заменить текущие настройки настройками из файла?') + list)) return;
                  // A key must never follow an address that came from someone else's file.
                  await Promise.all(imported.dropSecrets.map((n) => platform.secrets.delete(n)));
                  update(imported.settings);
                  toast(tr('Настройки загружены. Введите ключи API, если они нужны.'));
                }}
              />
            </label>
          </span>
        </div>
        <div style={{ marginTop: 14, display: 'grid', gap: 6 }} data-testid="report">
          <b>{tr('Сообщить о проблеме')}</b>
          <small className="ait-muted">{tr('Соберёт файл с версией, настройками (без ключей API) и последними ошибками. Приложите его к сообщению на GitHub.')}</small>
          <span style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              className="ait-btn small"
              onClick={async () => {
                const bytes = await buildReport({ db: platform.db, settings: s, version: platform.version, kind: platform.kind, history: await platform.service.history(50) });
                await platform.saveFile(`ai-translate-report-${new Date().toISOString().slice(0, 10)}.zip`, bytes, 'application/zip');
              }}
            >
              {tr('Собрать файл для отчёта')}
            </button>
            <a className="ait-btn small" href="https://github.com/kclazzy/AI-translate/issues/new" target="_blank" rel="noreferrer">{tr('Открыть GitHub')}</a>
          </span>
        </div>
      </div>
    </div>
  );
}
