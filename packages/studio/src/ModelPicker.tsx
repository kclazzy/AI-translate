import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  browserBackend,
  checkForUpdate,
  checkReadiness,
  checkVisionModel,
  DEFAULT_KEEP_ALIVE_MIN,
  configFromPreset,
  discoverModels,
  errorMessage,
  guessVramGb,
  isOllama,
  isSameModel,
  isThinkingModel,
  MODEL_TIERS,
  modelCheckKey,
  ollamaDelete,
  ollamaPull,
  ollamaStatus,
  providerById,
  readinessText,
  SETUP_LINKS,
  tierForVram,
  type AppSettings,
  type DiscoveredModel,
  type ModelCheck,
  type OllamaStatus,
  type ProviderConfig,
  type Readiness,
  type UpdateInfo,
} from '@ait/core';
import { FoldPanel } from './ui';
import { tr, uiLocale } from '@ait/core/i18n';

/**
 * Model selector with a refresh button: asks LM Studio / Ollama / any OpenAI-compatible
 * server which models it has and whether they read images.
 */
export function ModelPicker({ cfg, getKey, onPick, compact, hasKey }: { cfg: ProviderConfig; getKey: () => Promise<string | undefined>; onPick: (model: string, vision: boolean | undefined) => void; compact?: boolean; /** false: a cloud service without a saved key — do not ask it for models yet. */ hasKey?: boolean }) {
  const [models, setModels] = useState<DiscoveredModel[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const list = await discoverModels({ ...cfg, apiKey: cfg.apiKey ?? (await getKey()) });
      setModels(list);
      if (!list.length) setError(tr('Сервер работает, но моделей нет. Загрузите модель в LM Studio или выполните ollama pull.'));
    } catch (e) {
      setModels(null);
      setError(`${errorMessage(e)} ${(e as { detail?: string }).detail ?? ''}`.trim());
    } finally {
      setBusy(false);
    }
  }, [cfg.baseUrl, cfg.kind, cfg.label, cfg.apiKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (hasKey === false) {
      setError(null);
      return;
    }
    void refresh();
  }, [refresh, hasKey]);

  const current = models?.find((m) => m.id === cfg.model);
  const options = models ? [...models] : [];
  if (cfg.model && !current) options.unshift({ id: cfg.model });
  const label = (m: DiscoveredModel) => `${m.vision ? '👁 ' : m.vision === false ? '✎ ' : ''}${m.id}${m.loaded ? tr(' • загружена') : ''}`;

  return (
    <div style={{ display: 'grid', gap: 4 }}>
      <div style={{ display: 'flex', gap: 6 }}>
        <select
          className="ait-select"
          aria-label={tr('Модель')}
          value={cfg.model}
          onChange={(e) => {
            const m = options.find((x) => x.id === e.target.value);
            onPick(e.target.value, m?.vision);
          }}
        >
          {options.map((m) => (
            <option key={m.id} value={m.id}>
              {label(m)}
            </option>
          ))}
        </select>
        <button type="button" className="ait-btn" style={{ flex: 'none', minWidth: 40, padding: '0 10px' }} onClick={() => void refresh()} disabled={busy} title={tr('Обновить список моделей')} aria-label={tr('Обновить список моделей')}>
          <span style={{ display: 'inline-block', animation: busy ? 'ait-spin 0.9s linear infinite' : undefined }}>⟳</span>
        </button>
      </div>
      {error ? <small style={{ color: 'var(--err)' }}>{error}</small> : null}
      {!compact && models?.length ? (
        <small className="ait-muted">
          
          {tr('👁 читает изображения, ✎ только текст.')}{current?.vision === false ? tr(' Эта модель не читает картинки: выберите её для перевода текста, а для чтения — модель с 👁.') : ''}
          {isThinkingModel(cfg.model) ? tr(' Модель с размышлениями: режим размышлений отключается автоматически.') : ''}
        </small>
      ) : null}
    </div>
  );
}

type KeyGetter = (providerId: string) => Promise<string | undefined>;

function gb(n?: number): string {
  return n ? tr('{0} ГБ', (n / 1e9).toFixed(1)) : '';
}

function ago(iso: string): string {
  const min = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (min < 1) return tr('только что');
  if (min < 60) return tr('{0} мин назад', min);
  if (min < 60 * 24) return tr('{0} ч назад', Math.round(min / 60));
  return new Date(iso).toLocaleDateString(uiLocale());
}

/** Video card name from WebGL, and its memory if we know the model. */
export function detectGpu(): { name?: string; vramGb?: number } {
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    if (!gl) return {};
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const raw = String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) ?? '');
    // "ANGLE (NVIDIA, NVIDIA GeForce RTX 5070 (0x00002F04) Direct3D11 …)" → "NVIDIA GeForce RTX 5070"
    const m = raw.match(/ANGLE \([^,]*,\s*([^,(]+?)\s*(\(0x|Direct3D|OpenGL|Vulkan|,)/);
    const name = (m ? m[1] : raw).trim();
    return { name: name || undefined, vramGb: guessVramGb(raw) };
  } catch {
    return {};
  }
}

function ollamaProvider(s: AppSettings): ProviderConfig | undefined {
  return s.providers.find((p) => p.preset === 'ollama') ?? s.providers.find((p) => isOllama(p));
}

/** Run "Проверить модель" and remember the result in settings. */
function useModelCheck(settings: AppSettings, update: (p: Partial<AppSettings>) => void, getKey?: KeyGetter) {
  const [running, setRunning] = useState<string | null>(null);
  const latest = useRef(settings);
  latest.current = settings;
  const run = useCallback(
    async (cfg: ProviderConfig): Promise<ModelCheck> => {
      const key = modelCheckKey(cfg);
      setRunning(key);
      try {
        const apiKey = cfg.apiKey ?? (await getKey?.(cfg.id));
        const r = await checkVisionModel({ ...cfg, apiKey }, { backend: browserBackend, targetLang: latest.current.targetLang });
        update({ modelChecks: { ...(latest.current.modelChecks ?? {}), [key]: r } });
        return r;
      } finally {
        setRunning(null);
      }
    },
    [getKey, update],
  );
  return { run, running };
}

const LEVEL: Record<ModelCheck['level'] | 'none', { dot: string; label: string }> = {
  ok: { dot: 'var(--ok)', label: tr('Работает') },
  partial: { dot: '#d4a017', label: tr('Читает с ошибками') },
  fail: { dot: 'var(--err)', label: tr('Не работает') },
  none: { dot: 'var(--ink-3, #999)', label: tr('Не проверена') },
};

function CheckResult({ check }: { check?: ModelCheck }) {
  if (!check) return null;
  return (
    <small className="ait-muted" data-testid="model-check-result">
      {check.message}
      {check.read ? tr(' Прочитала: «{0}»{1}.', check.read, check.translation ? ` → «${check.translation}»` : '') : ''} {' '}{tr('Проверено')}{' '}{ago(check.at)}.
    </small>
  );
}

/**
 * "Does my model work?": a one-click test that sends a small picture with Japanese text to the
 * chosen image-reading model and shows what it read, the translation and how long it took.
 */
export function ModelCheckCard({ settings, update, getKey, compact, onOpenSettings }: { settings: AppSettings; update: (p: Partial<AppSettings>) => void; getKey?: KeyGetter; compact?: boolean; onOpenSettings?: (download?: boolean) => void }) {
  const vision = providerById(settings, settings.visionProviderId);
  const { run, running } = useModelCheck(settings, update, getKey);
  const [ollama, setOllama] = useState<OllamaStatus | null>(null);
  const checkedAt = vision ? settings.modelChecks?.[modelCheckKey(vision)]?.at : undefined;

  useEffect(() => {
    if (vision && isOllama(vision)) void ollamaStatus(vision.baseUrl, vision.model).then(setOllama);
    else setOllama(null);
    // Re-check after a new test result (e.g. the model was just downloaded in the panel below).
  }, [vision?.baseUrl, vision?.model, checkedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  if (settings.pipeline !== 'standalone') return null;
  if (!vision) {
    const msg = tr('Не выбрана модель, которая читает картинки.');
    return compact ? <div className="ait-notice">{msg} {onOpenSettings ? <button className="pp-link" onClick={() => onOpenSettings()}>{tr('Выбрать')}</button> : null}</div> : <div className="ait-panel ait-notice">{msg}</div>;
  }
  const check = settings.modelChecks?.[modelCheckKey(vision)];
  const busy = running === modelCheckKey(vision);
  const level = busy ? null : check?.level ?? 'none';
  const missing = ollama?.state === 'missing';
  const offline = ollama?.state === 'offline';

  const status = (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }} data-testid="model-status">
      <i style={{ width: 9, height: 9, borderRadius: 9, background: busy ? 'var(--magenta)' : missing || offline ? 'var(--err)' : LEVEL[level!].dot, display: 'inline-block' }} />
      <b>{vision.model}</b>
      <span className="ait-muted">
        {busy ? tr('проверяю… (первый запуск модели может занять минуту)') : offline ? tr('Ollama не запущена') : missing ? tr('модель не скачана') : LEVEL[level!].label}
      </span>
    </span>
  );
  const button = (
    <button type="button" className={compact ? 'pp-link' : 'ait-btn small'} disabled={busy || missing || offline} onClick={() => void run(vision)}>
      {busy ? tr('Проверяю…') : check ? tr('Проверить снова') : tr('Проверить модель')}
    </button>
  );

  if (compact) {
    return (
      <div className={level === 'fail' || missing || offline ? 'ait-error' : 'ait-notice'} style={{ display: 'grid', gap: 4 }}>
        <span style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
          {status}
          {missing || offline ? (onOpenSettings ? <button className="pp-link" onClick={() => onOpenSettings(missing)}>{missing ? tr('Скачать') : tr('Подробнее')}</button> : null) : button}
        </span>
        {level === 'fail' || level === 'partial' ? <small>{check?.message}</small> : null}
      </div>
    );
  }
  return (
    <div className="ait-panel" style={{ display: 'grid', gap: 8 }}>
      <h2 style={{ margin: 0 }}>{tr('Модель для чтения картинок')}</h2>
      <span style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        {status}
        {button}
      </span>
      <small className="ait-muted">{tr(vision.label)}</small>
      {busy ? null : <CheckResult check={check} />}
      {!check && !busy ? <small className="ait-muted">{tr('Проверка отправит модели маленькую картинку с японским текстом и покажет, что она прочитала и сколько времени это заняло.')}</small> : null}
    </div>
  );
}

const VRAM_CHOICES = [2, 4, 6, 8, 12, 16];

/**
 * Local models via Ollama: pick a model for the video card, download it with progress,
 * see what is installed, switch, test and delete models.
 */
export function LocalModels({ settings, update, getKey, autoStart }: { settings: AppSettings; update: (p: Partial<AppSettings>) => void; getKey?: KeyGetter; autoStart?: boolean }) {
  const existing = ollamaProvider(settings);
  const cfg = existing ?? configFromPreset('ollama', 'ollama');
  const [gpu] = useState(detectGpu);
  const vram = settings.gpuVramGb ?? gpu.vramGb;
  const tier = tierForVram(vram);
  const [status, setStatus] = useState<OllamaStatus | null>(null);
  const [vision, setVision] = useState<Record<string, boolean | undefined>>({});
  const [pull, setPull] = useState<{ model: string; status: string; completed?: number; total?: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const started = useRef(false);
  const { run, running } = useModelCheck(settings, update, getKey);
  const latest = useRef(settings);
  latest.current = settings;

  const refresh = useCallback(async () => {
    setError(null);
    const st = await ollamaStatus(cfg.baseUrl, tier.model);
    setStatus(st);
    if (st.state === 'ok' || st.state === 'missing') {
      try {
        const found = await discoverModels(cfg);
        setVision(Object.fromEntries(found.map((m) => [m.id, m.vision])));
      } catch {
        /* sizes are enough */
      }
    }
  }, [cfg.baseUrl, tier.model]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const current = providerById(settings, settings.visionProviderId);
  const isCurrent = (model: string) => !!current && isOllama(current) && isSameModel(current.model, model);

  const use = useCallback(
    (model: string) => {
      const s = latest.current;
      const base = ollamaProvider(s) ?? configFromPreset('ollama', 'ollama');
      const next: ProviderConfig = { ...base, model, vision: true, jsonMode: 'json_object' };
      const has = s.providers.some((p) => p.id === next.id);
      const providers = has ? s.providers.map((p) => (p.id === next.id ? next : p)) : [...s.providers, next];
      update({ providers, visionProviderId: next.id, pipeline: 'standalone' });
      return next;
    },
    [update],
  );

  const download = useCallback(
    async (model: string) => {
      setError(null);
      abort.current = new AbortController();
      setPull({ model, status: tr('начинаю') });
      try {
        await ollamaPull(cfg.baseUrl, model, (p) => setPull({ model, ...p }), abort.current.signal);
        setPull(null);
        const next = use(model);
        await refresh();
        // Show right away that the new model works.
        await run(next);
      } catch (e) {
        setPull(null);
        if ((e as { code?: string }).code !== 'CANCELLED' && (e as Error).name !== 'AbortError') setError(`${errorMessage(e)} ${(e as { detail?: string }).detail ?? (e as Error).message ?? ''}`.trim());
      }
    },
    [cfg.baseUrl, use, refresh, run],
  );

  const remove = useCallback(
    async (model: string, size?: number) => {
      if (!confirm(tr('Удалить модель {0}{1} с диска?\nВернуть её можно только повторным скачиванием.', model, size ? ` (${gb(size)})` : ''))) return;
      setDeleting(model);
      setError(null);
      try {
        await ollamaDelete(cfg.baseUrl, model);
        const s = latest.current;
        if (isCurrent(model)) {
          // Switch to another installed image-reading model, if there is one.
          const other = status && 'list' in status ? status.list.find((m) => !isSameModel(m.name, model) && vision[m.name] !== false) : undefined;
          if (other) use(other.name);
        }
        const checks = { ...(s.modelChecks ?? {}) };
        delete checks[modelCheckKey({ baseUrl: cfg.baseUrl, model })];
        update({ modelChecks: checks });
        await refresh();
      } catch (e) {
        setError(tr('Не удалось удалить {0}: {1}', model, (e as { detail?: string }).detail ?? (e as Error).message));
      } finally {
        setDeleting(null);
      }
    },
    [cfg.baseUrl, status, vision, use, update, refresh], // eslint-disable-line react-hooks/exhaustive-deps
  );

  useEffect(() => {
    if (autoStart && status?.state === 'missing' && !started.current && !pull) {
      started.current = true;
      void download(tier.model);
    }
  }, [autoStart, status, download, tier.model, pull]);

  const summary = !status
    ? tr('проверяю…')
    : status.state === 'offline'
      ? tr('Ollama не запущена')
      : status.state === 'forbidden'
        ? tr('Ollama не пускает расширение')
        : tr('установлено: {0}{1}', status.list.length, current && isOllama(current) ? tr(' · выбрана {0}', current.model) : '');
  const box = (children: ReactNode) => (
    <FoldPanel title={tr('Локальные модели (Ollama)')} summary={summary} defaultOpen={autoStart || !!pull} testId="local-models">
      {children}
    </FoldPanel>
  );

  if (!status) return box(<span className="ait-muted">{tr('Проверяю Ollama…')}</span>);
  if (status.state === 'offline') {
    return box(
      <>
        <span>{tr('Ollama не запущена или не установлена (')}{cfg.baseUrl.replace(/\/v1$/, '')}{tr('). Она нужна, чтобы переводить на своей видеокарте, без интернета.')}</span>
        <span style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <a className="ait-btn small" href="https://ollama.com/download" target="_blank" rel="noreferrer">{tr('Скачать Ollama')}</a>
          <button className="ait-btn small" onClick={() => void refresh()}>{tr('Проверить снова')}</button>
        </span>
      </>,
    );
  }
  if (status.state === 'forbidden') {
    return box(
      <>
        <span>{tr('Ollama запущена, но не пускает расширение. Выполните в командной строке и перезапустите Ollama:')}</span>
        <code style={{ userSelect: 'all', wordBreak: 'break-all' }}>setx OLLAMA_ORIGINS "chrome-extension://*,moz-extension://*"</code>
        <button className="ait-btn small" style={{ justifySelf: 'start' }} onClick={() => void refresh()}>{tr('Проверить снова')}</button>
      </>,
    );
  }

  const installed = status.list;
  const has = (model: string) => installed.some((m) => isSameModel(m.name, model));
  const pct = pull?.total ? Math.round(((pull.completed ?? 0) / pull.total) * 100) : null;

  return box(
    <>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <label htmlFor="ait-vram">{tr('Видеопамять')}</label>
        <select id="ait-vram" className="ait-select" style={{ width: 'auto' }} value={vram ?? ''} onChange={(e) => update({ gpuVramGb: e.target.value ? Number(e.target.value) : undefined })}>
          {vram === undefined ? <option value="">{tr('не определена')}</option> : null}
          {VRAM_CHOICES.map((v) => (
            <option key={v} value={v}>
              {v === 16 ? tr('16 ГБ и больше') : tr('{0} ГБ', v)}
            </option>
          ))}
        </select>
        <small className="ait-muted">{gpu.name ? tr('Определено: {0}{1}', gpu.name, gpu.vramGb ? tr(' ({0} ГБ)', gpu.vramGb) : '') : tr('Видеокарту определить не удалось — выберите объём памяти вручную.')}</small>
      </div>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <label htmlFor="ait-keep">{tr('Держать модель в видеопамяти после перевода')}</label>
        <select id="ait-keep" className="ait-select" style={{ width: 'auto' }} value={settings.gpuKeepAliveMin ?? DEFAULT_KEEP_ALIVE_MIN} onChange={(e) => update({ gpuKeepAliveMin: Number(e.target.value) })}>
          <option value={0}>{tr('не держать — выгружать сразу')}</option>
          <option value={1}>{tr('1 минуту')}</option>
          <option value={5}>{tr('5 минут')}</option>
          <option value={15}>{tr('15 минут')}</option>
          <option value={60}>{tr('1 час')}</option>
        </select>
        <small className="ait-muted">{tr('Пока модель в памяти, следующая страница начинается сразу; после — память видеокарты освобождается для игр и других программ.')}</small>
      </div>

      <label className="ait-switch" data-testid="fast-local">
        <input type="checkbox" role="switch" checked={!!settings.fastLocal} onChange={(e) => update({ fastLocal: e.target.checked })} />
        <span>
          
          {tr('Быстрый режим: картинка для модели поменьше, проверка перевода без дополнительного запроса к модели')}
          <small className="ait-muted" style={{ display: 'block' }}>{tr('Обычно на треть быстрее; мелкий текст может читаться хуже.')}</small>
        </span>
      </label>

      <details data-testid="ollama-tuning">
        <summary style={{ cursor: 'pointer' }}>
          <b>{tr('Ускорить Ollama')}</b> <span className="ait-muted">{tr('— настройки самой Ollama')}</span>
        </summary>
        <div style={{ display: 'grid', gap: 6, marginTop: 8 }}>
          <small>{tr('Выполните в командной строке (Win+R → cmd), затем закройте Ollama (трей → Quit) и запустите снова:')}</small>
          <code style={{ userSelect: 'all' }}>setx OLLAMA_FLASH_ATTENTION 1</code>
          <small className="ait-muted">{tr('Flash attention: быстрее и меньше памяти на длинные запросы. В новых версиях Ollama включается сама, если видеокарта поддерживает.')}</small>
          <code style={{ userSelect: 'all' }}>setx OLLAMA_KV_CACHE_TYPE q8_0</code>
          <small className="ait-muted">{tr('Сжатый кэш: модель с картинкой занимает меньше видеопамяти и реже вылезает в обычную память. Работает только вместе с flash attention.')}</small>
          <small>{tr('Главное для скорости — чтобы модель целиком помещалась в видеокарту: если в окне расширения появилось «не помещается в видеопамять», выберите модель на ступень меньше.')}</small>
        </div>
      </details>

      <div style={{ display: 'grid', gap: 6 }}>
        {MODEL_TIERS.map((t) => {
          const rec = t.model === tier.model;
          const tooBig = vram !== undefined && t.vramGb > vram;
          const inst = has(t.model);
          return (
            <div key={t.model} data-testid={`tier-${t.model}`} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '8px 10px', border: `1px solid ${rec ? 'var(--magenta)' : 'var(--rule)'}`, borderRadius: 6, opacity: tooBig ? 0.55 : 1 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <b>{t.model}</b> {rec ? <span className="ait-badge ok">{tr('рекомендуем')}</span> : null} {isCurrent(t.model) ? <span className="ait-badge ok">{tr('✓ выбрана')}</span> : null}
                <br />
                <small className="ait-muted">
                  {t.vramGb === 16 ? tr('16+ ГБ') : tr('от {0} ГБ', t.vramGb)} · {t.sizeGb} {' '}{tr('ГБ · качество:')}{' '}{t.quality} · ~{t.secondsPerPage} {' '}{tr('с/стр.')}{tooBig ? tr(' · не поместится в вашу видеокарту, будет медленно') : ''}
                </small>
              </div>
              {inst ? (
                isCurrent(t.model) ? null : <button className="ait-btn small" style={{ flex: 'none', width: 'auto' }} onClick={() => use(t.model)}>{tr('Использовать')}</button>
              ) : (
                <button className={rec ? 'ait-bubble-btn' : 'ait-btn small'} style={{ flex: 'none', width: 'auto', ...(rec ? { fontSize: 14, minHeight: 32, padding: '3px 14px' } : {}) }} disabled={!!pull} onClick={() => void download(t.model)}>
                  
                  {tr('Скачать')}
                </button>
              )}
            </div>
          );
        })}
      </div>

      {pull ? (
        <div style={{ display: 'grid', gap: 6 }}>
          <span>{tr('Скачиваю')}{' '}{pull.model}…</span>
          <div className="ait-progress" role="progressbar" aria-valuenow={pct ?? 0} aria-valuemin={0} aria-valuemax={100}>
            <i style={{ width: `${pct ?? 3}%` }} />
          </div>
          <small className="ait-muted">
            {pull.status}
            {pull.total ? tr(' — {0} из {1} ({2}%)', gb(pull.completed), gb(pull.total), pct) : ''}{tr('. Не закрывайте эту вкладку до конца загрузки.')}
          </small>
          <button className="ait-btn small" style={{ justifySelf: 'start' }} onClick={() => abort.current?.abort()}>{tr('Остановить')}</button>
        </div>
      ) : null}

      <div style={{ display: 'grid', gap: 6 }}>
        <span style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <b>{tr('Установлено (')}{installed.length})</b>
          <button className="ait-btn small" onClick={() => void refresh()} title={tr('Обновить список')}>⟳</button>
        </span>
        {installed.length === 0 ? <small className="ait-muted">{tr('Пока ни одной модели. Нажмите «Скачать» у рекомендуемой.')}</small> : null}
        {installed.map((m) => {
          const check = settings.modelChecks?.[modelCheckKey({ baseUrl: cfg.baseUrl, model: m.name })];
          const key = modelCheckKey({ baseUrl: cfg.baseUrl, model: m.name });
          const textOnly = vision[m.name] === false;
          return (
            <div key={m.name} data-testid={`installed-${m.name}`} style={{ display: 'grid', gap: 2, padding: '6px 0', borderTop: '1px solid var(--rule)' }}>
              <span style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <i style={{ width: 9, height: 9, borderRadius: 9, background: LEVEL[check?.level ?? 'none'].dot, display: 'inline-block' }} title={LEVEL[check?.level ?? 'none'].label} />
                <b style={{ flex: 1, minWidth: 140 }}>{m.name}</b>
                <small className="ait-muted">{gb(m.size)}{textOnly ? tr(' · только текст') : ''}</small>
                {isCurrent(m.name) ? <span className="ait-badge ok">{tr('✓ выбрана')}</span> : !textOnly ? <button className="ait-btn small" onClick={() => use(m.name)}>{tr('Использовать')}</button> : null}
                {!textOnly ? (
                  <button className="ait-btn small" disabled={running === key} onClick={() => void run({ ...cfg, model: m.name, vision: true })}>
                    {running === key ? tr('Проверяю…') : tr('Проверить')}
                  </button>
                ) : null}
                <button className="ait-btn small danger" disabled={deleting === m.name || pull?.model === m.name} onClick={() => void remove(m.name, m.size)}>
                  {deleting === m.name ? tr('Удаляю…') : tr('Удалить')}
                </button>
              </span>
              {running === key ? <small className="ait-muted">{tr('Проверяю… первый запуск модели может занять минуту.')}</small> : <CheckResult check={check} />}
            </div>
          );
        })}
      </div>
      {error ? <small style={{ color: 'var(--err)' }}>{error}</small> : null}
      <ModelsFolder settings={settings} update={update} needGb={tier.sizeGb} onRecheck={() => void refresh()} />
      <small className="ait-muted">{tr('Модели LM Studio удаляются в самой LM Studio (вкладка «My Models»).')}</small>
    </>,
  );
}

/** Windows-style or Unix absolute path without characters that would break the command. */
export function validModelsDir(path: string): boolean {
  return /^([A-Za-z]:\\|\\\\|\/)[^"<>|?*\n]*$/.test(path.trim());
}

/**
 * Where Ollama keeps downloaded models. The browser cannot move them itself, so we
 * remember the folder and give the exact steps / command for it.
 */
function ModelsFolder({ settings, update, needGb, onRecheck }: { settings: AppSettings; update: (p: Partial<AppSettings>) => void; needGb: number; onRecheck: () => void }) {
  const [dir, setDir] = useState(settings.ollamaModelsDir ?? '');
  const [copied, setCopied] = useState(false);
  const clean = dir.trim().replace(/[\\/]+$/, '');
  const ok = !!clean && validModelsDir(clean);
  const command = `setx OLLAMA_MODELS "${clean}"`;
  const saved = settings.ollamaModelsDir;
  return (
    <details data-testid="models-folder" open={!!saved && saved !== clean ? true : undefined}>
      <summary style={{ cursor: 'pointer' }}>
        <b>{tr('Где хранить модели')}</b> <span className="ait-muted">{saved ? `— ${saved}` : tr('— стандартная папка Ollama')}</span>
      </summary>
      <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
        <small className="ait-muted">{tr('По умолчанию Ollama хранит модели в C:\\Users\\&lt;имя&gt;\\.ollama\\models (диск C). Если там мало места, выберите папку на другом диске — рекомендуемая модель займёт')}{' '}{needGb} {' '}{tr('ГБ.')}</small>
        <span style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <input className="ait-input" style={{ flex: 1, minWidth: 220 }} placeholder="D:\AI\ollama-models" value={dir} onChange={(e) => setDir(e.target.value)} aria-label={tr('Папка для моделей')} />
          <button className="ait-btn small" disabled={!ok || clean === saved} onClick={() => update({ ollamaModelsDir: clean })}>{tr('Сохранить')}</button>
          {saved ? <button className="ait-btn small" onClick={() => { setDir(''); update({ ollamaModelsDir: undefined }); }}>{tr('По умолчанию')}</button> : null}
        </span>
        {dir && !ok ? <small style={{ color: 'var(--err)' }}>{tr('Укажите полный путь, например D:\\AI\\ollama-models (без кавычек).')}</small> : null}
        {ok ? (
          <ol style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 6 }}>
            <li>{tr('Проще всего: значок Ollama в трее →')}{' '}<b>Settings</b> → <b>Model location</b> {' '}{tr('→ выберите')}{' '}<code>{clean}</code>.</li>
            <li>
              
              {tr('Или выполните в командной строке (Win+R → cmd):')}{' '}
              <code style={{ userSelect: 'all', wordBreak: 'break-all' }}>{command}</code>{' '}
              <button
                className="ait-btn small"
                onClick={() => {
                  void navigator.clipboard?.writeText(command).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  });
                }}
              >
                {copied ? tr('Скопировано') : tr('Копировать')}
              </button>
            </li>
            <li>{tr('Закройте Ollama (значок в трее → Quit) и запустите снова.')}</li>
            <li>{tr('Уже скачанные модели перенесите: скопируйте содержимое старой папки models в новую — иначе их придётся скачать заново.')}</li>
            <li>
              <button className="ait-btn small" onClick={onRecheck}>{tr('Проверить')}</button> {' '}{tr('— список «Установлено» покажет модели из новой папки.')}
            </li>
          </ol>
        ) : null}
      </div>
    </details>
  );
}

/**
 * "Check for updates" with an in-app install when the host supports it
 * (the extension rewrites its own folder and reloads; Android downloads the APK).
 */
export function UpdateCheck({ current, compact, install, autoCheck }: { current: string; compact?: boolean; install?: (info: UpdateInfo, progress: (text: string, pct?: number) => void) => Promise<void>; autoCheck?: boolean }) {
  const [state, setState] = useState<{ busy: boolean; info?: UpdateInfo; error?: string }>({ busy: false });
  const [inst, setInst] = useState<{ text: string; pct?: number } | null>(null);
  const run = async () => {
    setState({ busy: true });
    try {
      setState({ busy: false, info: await checkForUpdate(current) });
    } catch (e) {
      setState({ busy: false, error: tr('Не удалось проверить: {0}', (e as Error).message) });
    }
  };
  useEffect(() => {
    if (autoCheck) void run();
  }, [autoCheck]); // eslint-disable-line react-hooks/exhaustive-deps
  const doInstall = async () => {
    if (!install || !state.info) return;
    setInst({ text: tr('начинаю…') });
    try {
      await install(state.info, (text, pct) => setInst({ text, pct }));
    } catch (e) {
      setInst(null);
      if ((e as Error).name !== 'AbortError') setState((s) => ({ ...s, error: (e as Error).message }));
    }
  };
  const i = state.info;
  return (
    <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }} data-testid="update-check">
      <button type="button" className={compact ? 'pp-link' : 'ait-btn small'} onClick={() => void run()} disabled={state.busy || !!inst}>
        {state.busy ? tr('Проверяю…') : tr('Проверить обновления')}
      </button>
      {i ? (
        i.available ? (
          <>
            <span>{tr('Есть версия')}{' '}{i.latest}</span>
            {install ? (
              <button type="button" className={compact ? 'pp-link' : 'ait-bubble-btn'} style={compact ? undefined : { fontSize: 14, minHeight: 30, padding: '2px 14px' }} disabled={!!inst} onClick={() => void doInstall()}>
                
                {tr('Обновить сейчас')}
              </button>
            ) : null}
            <a href={i.url} target="_blank" rel="noreferrer">
              
              {tr('что нового')}
            </a>
          </>
        ) : (
          <span className="ait-muted">{tr('У вас последняя версия (')}{i.current})</span>
        )
      ) : null}
      {inst ? (
        <span style={{ display: 'inline-grid', gap: 4, minWidth: 200 }}>
          <small>{inst.text}</small>
          {inst.pct !== undefined ? (
            <span className="ait-progress">
              <i style={{ width: `${inst.pct}%` }} />
            </span>
          ) : null}
        </span>
      ) : null}
      {state.error ? <span style={{ color: 'var(--err)' }}>{state.error}</span> : null}
    </span>
  );
}

/**
 * "What is missing for local translation": checks Ollama / LM Studio / the engine every few
 * seconds, offers the download and the next step, downloads the model, and reports when
 * everything is ready (the extension then continues the translation that was started).
 */
export function LocalSetup({ settings, update, getKey, onReady }: { settings: AppSettings; update: (p: Partial<AppSettings>) => void; getKey?: KeyGetter; onReady?: () => void }) {
  const [state, setState] = useState<Readiness | null>(null);
  const [pull, setPull] = useState<{ status: string; completed?: number; total?: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const readyFired = useRef(false);
  const latest = useRef(settings);
  latest.current = settings;
  const { run, running } = useModelCheck(settings, update, getKey);

  const refresh = useCallback(async () => {
    setChecking(true);
    try {
      setState(await checkReadiness(latest.current));
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => {
      if (!pull) void refresh();
    }, 3000);
    return () => clearInterval(t);
  }, [refresh, pull]);

  useEffect(() => {
    if (state?.ok && !readyFired.current) {
      readyFired.current = true;
      const v = providerById(latest.current, latest.current.visionProviderId);
      // Prove it works, then continue.
      void (async () => {
        if (v && latest.current.pipeline === 'standalone') await run(v);
        onReady?.();
      })();
    }
  }, [state, onReady, run]);

  const download = async (model: string, baseUrl: string) => {
    setError(null);
    setPull({ status: tr('начинаю') });
    try {
      await ollamaPull(baseUrl, model, (p) => setPull(p));
      // Use the model that was just downloaded for reading pictures.
      const cur = latest.current;
      const v = providerById(cur, cur.visionProviderId);
      if (v && isOllama(v) && !isSameModel(v.model, model)) {
        const next = { ...cur, providers: cur.providers.map((p) => (p.id === v.id ? { ...p, model, vision: true } : p)) };
        latest.current = next;
        update({ providers: next.providers });
      }
      setPull(null);
      await refresh();
    } catch (e) {
      setPull(null);
      setError(`${errorMessage(e)} ${(e as { detail?: string }).detail ?? (e as Error).message ?? ''}`.trim());
    }
  };

  const win = typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent);
  const step = (n: number, done: boolean, title: string, body?: ReactNode) => (
    <div style={{ display: 'grid', gridTemplateColumns: '28px 1fr', gap: 8, alignItems: 'start' }}>
      <span className={`ait-badge ${done ? 'ok' : ''}`} style={{ justifyContent: 'center' }}>{done ? '✓' : n}</span>
      <div style={{ display: 'grid', gap: 6 }}>
        <b>{title}</b>
        {body}
      </div>
    </div>
  );

  const need = state && !state.ok ? state.need : null;
  const [gpu] = useState(detectGpu);
  const missingModel = state && !state.ok && state.need === 'ollama-model' ? state.model : '';
  // The configured model is only the default: suggest the one that fits this video card.
  const suggested = missingModel && missingModel === configFromPreset('ollama').model ? tierForVram(settings.gpuVramGb ?? gpu.vramGb).model : missingModel;
  const programOk = state?.ok || need === 'ollama-model';
  const checkKey = (() => {
    const v = providerById(settings, settings.visionProviderId);
    return v ? modelCheckKey(v) : '';
  })();
  const check = settings.modelChecks?.[checkKey];
  const pct = pull?.total ? Math.round(((pull.completed ?? 0) / pull.total) * 100) : null;

  return (
    <div className="ait-panel" data-testid="local-setup" style={{ display: 'grid', gap: 14, borderColor: state?.ok ? 'var(--ok)' : 'var(--magenta)' }}>
      <h2 style={{ margin: 0 }}>{tr('Подготовка к переводу на этом компьютере')}</h2>
      {!state ? <span className="ait-muted">{tr('Проверяю программы…')}</span> : <span>{readinessText(state)}</span>}

      {need === 'engine' ? (
        step(1, false, tr('Запустите локальный движок'), (
          <>
            <small>{tr('Откройте папку, куда распакован AI Translate, и запустите')}{' '}<code>engine\scripts\start-engine.bat</code>{tr('. Нужен Python 3.11+.')}</small>
            <span style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <a className="ait-btn small" href={SETUP_LINKS.python} target="_blank" rel="noreferrer">{tr('Скачать Python')}</a>
              <button className="ait-btn small" onClick={() => update({ pipeline: 'standalone' })}>{tr('Переводить без движка')}</button>
            </span>
          </>
        ))
      ) : need === 'lmstudio' || need === 'server' ? (
        step(1, false, need === 'lmstudio' ? tr('Запустите LM Studio и её сервер') : tr('Запустите сервер модели'), (
          <>
            <small>{need === 'lmstudio' ? tr('В LM Studio: вкладка Developer → Start Server, включите CORS. Загрузите модель, которая читает картинки.') : tr('Сервер должен отвечать по адресу {0}.', (state as { baseUrl: string }).baseUrl)}</small>
            {need === 'lmstudio' ? <a className="ait-btn small" style={{ justifySelf: 'start' }} href={SETUP_LINKS.lmstudio} target="_blank" rel="noreferrer">{tr('Скачать LM Studio')}</a> : null}
          </>
        ))
      ) : (
        <>
          {step(1, !!programOk, tr('Ollama — программа, которая запускает модель'), need === 'ollama' ? (
            <>
              <span style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <a className="ait-bubble-btn" style={{ fontSize: 14, minHeight: 32, padding: '3px 14px', textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }} href={win ? SETUP_LINKS.ollamaWindows : SETUP_LINKS.ollamaPage} target="_blank" rel="noreferrer">
                  
                  {tr('Скачать Ollama')}{win ? tr(' для Windows') : ''}
                </a>
                {win ? <a className="ait-btn small" href={SETUP_LINKS.ollamaPage} target="_blank" rel="noreferrer">macOS / Linux</a> : null}
              </span>
              <small className="ait-muted">{tr('Откройте скачанный файл и установите. Если Ollama уже установлена — запустите её из меню «Пуск» (значок ламы появится рядом с часами).')}</small>
              <small className="ait-muted">{checking ? tr('Проверяю…') : tr('Жду запуска Ollama — проверяю каждые 3 секунды, нажимать ничего не нужно.')}</small>
            </>
          ) : null)}
          {step(2, !!state?.ok, tr('Модель, которая читает картинки'), need === 'ollama-model' ? (
            pull ? (
              <>
                <div className="ait-progress"><i style={{ width: `${pct ?? 3}%` }} /></div>
                <small className="ait-muted">{pull.status}{pull.total ? tr(' — {0} из {1} ({2}%)', gb(pull.completed), gb(pull.total), pct) : ''}</small>
              </>
            ) : (
              <>
                <button className="ait-bubble-btn" style={{ justifySelf: 'start', fontSize: 14, minHeight: 32, padding: '3px 14px' }} onClick={() => void download(suggested, (state as { baseUrl: string }).baseUrl)}>
                  
                  {tr('Скачать')}{' '}{suggested}
                </button>
                <small className="ait-muted">
                  {MODEL_TIERS.find((t) => t.model === suggested) ? tr('{0} ГБ, подобрана {1}. ', MODEL_TIERS.find((t) => t.model === suggested)!.sizeGb, gpu.name ? tr('под {0}', gpu.name) : tr('под видеокарту')) : ''}{tr('Другую можно выбрать в «Локальных моделях» ниже.')}
                </small>
              </>
            )
          ) : need === 'ollama' ? <small className="ait-muted">{tr('После запуска Ollama предложим скачать модель под вашу видеокарту.')}</small> : null)}
          {step(3, check?.level === 'ok', tr('Проверка'), state?.ok ? (
            running ? <small className="ait-muted">{tr('Проверяю модель… первый запуск может занять минуту.')}</small> : check ? <small>{check.message}</small> : null
          ) : null)}
        </>
      )}
      {state?.ok && onReady ? <small>{tr('Готово — продолжаю перевод на странице.')}</small> : null}
      {error ? <small style={{ color: 'var(--err)' }}>{error}</small> : null}
    </div>
  );
}
