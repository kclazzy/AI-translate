import { useCallback, useEffect, useState } from 'react';
import { checkForUpdate, discoverModels, errorMessage, isThinkingModel, type DiscoveredModel, type ProviderConfig, type UpdateInfo } from '@ait/core';

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
