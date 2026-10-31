import { PROVIDER_PRESETS } from '@ait/core';
import { tr } from '@ait/core/i18n';

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
