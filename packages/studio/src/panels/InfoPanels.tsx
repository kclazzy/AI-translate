import { useEffect, useState } from 'react';
import { describeRoute, providerById, type AppSettings, type HistoryEntry, type UsageTotals } from '@ait/core';
import { usePlatform } from '../platform';
import { toast } from '../ui';
import { tr, uiLocale } from '@ait/core/i18n';

export function PrivacyPanel({ settings: s }: { settings: AppSettings }) {
  const vision = providerById(s, s.visionProviderId);
  const text = providerById(s, s.translationProviderId) ?? vision;
  const lines = describeRoute(s.privacy, s.pipeline === 'engine' ? undefined : vision, text, s.pipeline === 'engine' ? s.engine.url : undefined);
  return (
    <div className="ait-panel">
      <h2>
        {tr('Приватность')}{' '}{s.privacy === 'local' ? <span className="ait-badge local">{tr('🔒 Локальный режим')}</span> : null}
      </h2>
      <ul>
        {lines.map((l) => <li key={l}>{l}</li>)}
        <li>{tr('История переводов:')}{' '}{s.saveHistory ? tr('сохраняется только на этом устройстве') : tr('не сохраняется')}.</li>
        <li>{tr('Ключи API хранятся на этом устройстве в зашифрованном виде и отправляются только выбранному провайдеру.')}</li>
        <li>{tr('Кэш переводов хранится {0} дн. на этом устройстве.', s.cacheDays)}</li>
      </ul>
      {s.privacy === 'local' ? (
        <p className="ait-hint">{tr('В локальном режиме приложение откажется отправлять что-либо провайдеру вне этого устройства или локальной сети, даже если он выбран.')}</p>
      ) : null}
    </div>
  );
}

export function HistoryPanel({ onOpen }: { onOpen: (key: string) => void }) {
  const platform = usePlatform();
  const [items, setItems] = useState<HistoryEntry[]>([]);
  const [usage, setUsage] = useState<UsageTotals | null>(null);
  const load = () => {
    void platform.service.history().then(setItems);
    void platform.service.usage().then(setUsage);
  };
  useEffect(load, [platform]);
  return (
    <div>
      {usage ? (
        <div className="ait-panel">
          <h2>{tr('Расход')}</h2>
          <p style={{ margin: 0 }}>
            {tr('Страниц переведено: {0} · Токенов: {1} вход / {2} выход · Оценка стоимости: {3}', usage.pages, usage.inputTokens.toLocaleString(uiLocale()), usage.outputTokens.toLocaleString(uiLocale()), new Intl.NumberFormat(uiLocale(), { style: 'currency', currency: 'USD', maximumFractionDigits: 3 }).format(usage.costUsd))}
          </p>
        </div>
      ) : null}
      <div className="ait-panel">
        <div className="ait-row" style={{ alignItems: 'center' }}>
          <h2 style={{ margin: 0 }}>{tr('История')}</h2>
          <div style={{ flex: '0 0 auto' }}>
            <button
              className="ait-btn small"
              onClick={async () => {
                await platform.db.clear('history');
                load();
                toast(tr('История очищена'));
              }}
            >
              {tr('Очистить')}
            </button>
          </div>
        </div>
        {items.length === 0 ? <p className="ait-muted">{tr('Здесь появятся переведённые страницы.')}</p> : null}
        <table className="ait-table" style={{ marginTop: 10 }}>
          <tbody>
            {items.map((h) => (
              <tr key={`${h.date}-${h.key}`}>
                <td style={{ whiteSpace: 'nowrap' }}>{new Date(h.date).toLocaleString(uiLocale())}</td>
                <td style={{ maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={h.url}>{h.title || h.url || '—'}</td>
                <td>{h.targetLang}</td>
                <td className="ait-muted">{h.model}</td>
                <td>{h.status === 'done' ? <span className="ait-badge ok">{tr('готово')}</span> : <span className="ait-badge err">{h.error ?? tr('ошибка')}</span>}</td>
                <td style={{ width: 1 }}>
                  {h.status === 'done' ? (
                    <button className="ait-btn small" onClick={() => onOpen(h.key)}>{tr('Открыть')}</button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
