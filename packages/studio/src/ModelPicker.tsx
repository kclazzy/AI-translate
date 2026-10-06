import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  checkForUpdate,
  configFromPreset,
  discoverModels,
  errorMessage,
  isThinkingModel,
  ollamaPull,
  ollamaStatus,
  RECOMMENDED_VISION_MODEL,
  RECOMMENDED_VISION_SIZE,
  type AppSettings,
  type DiscoveredModel,
  type OllamaStatus,
  type ProviderConfig,
  type UpdateInfo,
} from '@ait/core';

/**
 * Model selector with a refresh button: asks LM Studio / Ollama / any OpenAI-compatible
 * server which models it has and whether they read images.
 */
export function ModelPicker({ cfg, getKey, onPick, compact }: { cfg: ProviderConfig; getKey: () => Promise<string | undefined>; onPick: (model: string, vision: boolean | undefined) => void; compact?: boolean }) {
  const [models, setModels] = useState<DiscoveredModel[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const list = await discoverModels({ ...cfg, apiKey: cfg.apiKey ?? (await getKey()) });
      setModels(list);
      if (!list.length) setError('Сервер работает, но моделей нет. Загрузите модель в LM Studio или выполните ollama pull.');
    } catch (e) {
      setModels(null);
      setError(`${errorMessage(e)} ${(e as { detail?: string }).detail ?? ''}`.trim());
    } finally {
      setBusy(false);
    }
  }, [cfg.baseUrl, cfg.kind, cfg.label, cfg.apiKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const current = models?.find((m) => m.id === cfg.model);
  const options = models ? [...models] : [];
  if (cfg.model && !current) options.unshift({ id: cfg.model });
  const label = (m: DiscoveredModel) => `${m.vision ? '👁 ' : m.vision === false ? '✎ ' : ''}${m.id}${m.loaded ? ' • загружена' : ''}`;

  return (
    <div style={{ display: 'grid', gap: 4 }}>
      <div style={{ display: 'flex', gap: 6 }}>
        <select
          className="ait-select"
          aria-label="Модель"
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
        <button type="button" className="ait-btn" style={{ flex: 'none', minWidth: 40, padding: '0 10px' }} onClick={() => void refresh()} disabled={busy} title="Обновить список моделей" aria-label="Обновить список моделей">
          <span style={{ display: 'inline-block', animation: busy ? 'ait-spin 0.9s linear infinite' : undefined }}>⟳</span>
        </button>
      </div>
      {error ? <small style={{ color: 'var(--err)' }}>{error}</small> : null}
      {!compact && models?.length ? (
        <small className="ait-muted">
          👁 читает изображения, ✎ только текст.{current?.vision === false ? ' Эта модель не читает картинки: выберите её для перевода текста, а для чтения — модель с 👁.' : ''}
          {isThinkingModel(cfg.model) ? ' Модель с размышлениями: режим размышлений отключается автоматически.' : ''}
        </small>
      ) : null}
    </div>
  );
}

/** "Check for updates" button with the result inline. */
export function UpdateCheck({ current, compact }: { current: string; compact?: boolean }) {
  const [state, setState] = useState<{ busy: boolean; info?: UpdateInfo; error?: string }>({ busy: false });
  const run = async () => {
    setState({ busy: true });
    try {
      setState({ busy: false, info: await checkForUpdate(current) });
    } catch (e) {
      setState({ busy: false, error: `Не удалось проверить: ${(e as Error).message}` });
    }
  };
  const i = state.info;
  return (
    <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <button type="button" className={compact ? 'pp-link' : 'ait-btn small'} onClick={() => void run()} disabled={state.busy}>
        {state.busy ? 'Проверяю…' : 'Проверить обновления'}
      </button>
      {i ? (
        i.available ? (
          <a href={i.url} target="_blank" rel="noreferrer">
            Есть версия {i.latest} — скачать
          </a>
        ) : (
          <span className="ait-muted">У вас последняя версия ({i.current})</span>
        )
      ) : null}
      {state.error ? <span style={{ color: 'var(--err)' }}>{state.error}</span> : null}
    </span>
  );
}

function ollamaProvider(s: AppSettings): ProviderConfig | undefined {
  return s.providers.find((p) => p.preset === 'ollama') ?? s.providers.find((p) => /:11434\b/.test(p.baseUrl));
}

function mb(n?: number): string {
  return n ? `${(n / 1024 / 1024 / 1024).toFixed(2)} ГБ` : '';
}

/**
 * Checks that Ollama runs and has the recommended vision model; offers to download it
 * (with progress) or to install Ollama. `onDownload` replaces the in-place download
 * (the popup opens the settings tab instead, because a popup closes on blur).
 */
export function RecommendedModelCard({ settings, update, compact, autoStart, onDownload }: { settings: AppSettings; update: (p: Partial<AppSettings>) => void; compact?: boolean; autoStart?: boolean; onDownload?: () => void }) {
  const model = RECOMMENDED_VISION_MODEL;
  const existing = ollamaProvider(settings);
  const cfg = existing ?? configFromPreset('ollama', 'ollama');
  const [status, setStatus] = useState<OllamaStatus | null>(null);
  const [pull, setPull] = useState<{ status: string; completed?: number; total?: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const started = useRef(false);

  const check = useCallback(async () => {
    setError(null);
    setStatus(await ollamaStatus(cfg.baseUrl, model));
  }, [cfg.baseUrl, model]);

  const use = useCallback(() => {
    const next: ProviderConfig = { ...cfg, model, vision: true, jsonMode: 'json_object' };
    const providers = existing ? settings.providers.map((p) => (p.id === existing.id ? next : p)) : [...settings.providers, next];
    update({ providers, visionProviderId: next.id, pipeline: settings.pipeline });
  }, [cfg, existing, settings.providers, settings.pipeline, update, model]);

  const download = useCallback(async () => {
    if (onDownload) return onDownload();
    setError(null);
    abort.current = new AbortController();
    setPull({ status: 'начинаю' });
    try {
      await ollamaPull(cfg.baseUrl, model, (p) => setPull(p), abort.current.signal);
      setPull(null);
      use();
      await check();
    } catch (e) {
      setPull(null);
      if ((e as { code?: string }).code !== 'CANCELLED') setError(`${errorMessage(e)} ${(e as { detail?: string }).detail ?? (e as Error).message ?? ''}`.trim());
    }
  }, [onDownload, cfg.baseUrl, model, use, check]);

  useEffect(() => {
    void check();
  }, [check]);

  useEffect(() => {
    if (autoStart && status?.state === 'missing' && !started.current) {
      started.current = true;
      void download();
    }
  }, [autoStart, status, download]);

  if (!status) return compact ? null : <div className="ait-panel ait-muted">Проверяю Ollama…</div>;
  const selected = settings.visionProviderId === cfg.id && existing?.model === model;
  const current = settings.providers.find((p) => p.id === settings.visionProviderId);
  // In the popup, stay quiet when another image-reading model (e.g. LM Studio) is already chosen.
  if (compact && current && current.id !== cfg.id && current.vision) return null;
  if (status.state === 'ok' && selected) {
    return compact ? null : <div className="ait-panel"><span className="ait-badge ok">✓</span> Модель {model} установлена и выбрана для чтения картинок.</div>;
  }

  const box = (children: ReactNode) => (compact ? <div className="ait-notice" style={{ display: 'grid', gap: 8 }}>{children}</div> : <div className="ait-panel" style={{ display: 'grid', gap: 10 }}><h2 style={{ margin: 0 }}>Модель для чтения картинок</h2>{children}</div>);

  if (status.state === 'offline') {
    return box(
      <>
        <span>Ollama не запущена или не установлена. Она нужна, чтобы переводить локально, без интернета.</span>
        <span style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <a className="ait-btn small" href="https://ollama.com/download" target="_blank" rel="noreferrer">Скачать Ollama</a>
          <button className="ait-btn small" onClick={() => void check()}>Проверить снова</button>
        </span>
        {!compact ? <small className="ait-muted">После установки запустите Ollama (значок в трее) и выполните в командной строке: <code>setx OLLAMA_ORIGINS "chrome-extension://*,moz-extension://*"</code>, затем перезапустите Ollama.</small> : null}
      </>,
    );
  }
  if (status.state === 'forbidden') {
    return box(
      <>
        <span>Ollama запущена, но не пускает расширение. Выполните в командной строке и перезапустите Ollama:</span>
        <code style={{ userSelect: 'all', wordBreak: 'break-all' }}>setx OLLAMA_ORIGINS "chrome-extension://*,moz-extension://*"</code>
        <button className="ait-btn small" style={{ justifySelf: 'start' }} onClick={() => void check()}>Проверить снова</button>
      </>,
    );
  }
  if (status.state === 'ok') {
    return box(
      <>
        <span>Модель {model} уже установлена в Ollama.</span>
        <button className="ait-btn small" style={{ justifySelf: 'start' }} onClick={use}>Использовать для чтения картинок</button>
      </>,
    );
  }
  // missing
  const pct = pull?.total ? Math.round(((pull.completed ?? 0) / pull.total) * 100) : null;
  return box(
    <>
      <span>
        {pull ? `Скачиваю ${model} через Ollama…` : `Модель ${model} не установлена (${RECOMMENDED_VISION_SIZE}). Она читает текст на картинках и хорошо работает на видеокартах с 8–12 ГБ памяти.`}
      </span>
      {pull ? (
        <div style={{ display: 'grid', gap: 6 }}>
          <div className="ait-progress" role="progressbar" aria-valuenow={pct ?? 0} aria-valuemin={0} aria-valuemax={100}>
            <i style={{ width: `${pct ?? 3}%` }} />
          </div>
          <small className="ait-muted">
            {pull.status}
            {pull.total ? ` — ${mb(pull.completed)} из ${mb(pull.total)} (${pct}%)` : ''}
          </small>
          <button className="ait-btn small" style={{ justifySelf: 'start' }} onClick={() => abort.current?.abort()}>Остановить</button>
          {!compact ? <small className="ait-muted">Не закрывайте эту вкладку до конца загрузки.</small> : null}
        </div>
      ) : (
        <span style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="ait-bubble-btn" style={{ fontSize: 15, minHeight: 34, padding: '3px 16px' }} onClick={() => void download()}>Скачать {model}</button>
          <button className="ait-btn small" onClick={() => void check()}>Проверить снова</button>
        </span>
      )}
      {error ? <small style={{ color: 'var(--err)' }}>{error}</small> : null}
    </>,
  );
}
