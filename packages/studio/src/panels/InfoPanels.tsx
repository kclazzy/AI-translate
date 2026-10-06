import { useEffect, useState } from 'react';
import { describeRoute, providerById, type AppSettings, type HistoryEntry, type UsageTotals } from '@ait/core';
import { usePlatform } from '../platform';
import { toast } from '../ui';

export function PrivacyPanel({ settings: s }: { settings: AppSettings }) {
  const vision = providerById(s, s.visionProviderId);
  const text = providerById(s, s.translationProviderId) ?? vision;
  const lines = describeRoute(s.privacy, s.pipeline === 'engine' ? undefined : vision, text, s.pipeline === 'engine' ? s.engine.url : undefined);
  return (
    <div className="ait-panel">
      <h2>
        Приватность {s.privacy === 'local' ? <span className="ait-badge local">🔒 Локальный режим</span> : null}
      </h2>
      <ul>
        {lines.map((l) => <li key={l}>{l}</li>)}
        <li>История переводов: {s.saveHistory ? 'сохраняется только на этом устройстве' : 'не сохраняется'}.</li>
        <li>Ключи API хранятся на этом устройстве в зашифрованном виде и отправляются только выбранному провайдеру.</li>
        <li>Кэш переводов хранится {s.cacheDays} дн. на этом устройстве.</li>
      </ul>
      {s.privacy === 'local' ? (
        <p className="ait-hint">В локальном режиме приложение откажется отправлять что-либо провайдеру вне этого устройства или локальной сети, даже если он выбран.</p>
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
          <h2>Расход</h2>
          <p style={{ margin: 0 }}>
            Страниц переведено: <strong>{usage.pages}</strong> · Токенов: {usage.inputTokens.toLocaleString('ru')} вход / {usage.outputTokens.toLocaleString('ru')} выход · Оценка стоимости: ${usage.costUsd.toFixed(3)}
          </p>
        </div>
      ) : null}
      <div className="ait-panel">
        <div className="ait-row" style={{ alignItems: 'center' }}>
          <h2 style={{ margin: 0 }}>История</h2>
          <div style={{ flex: '0 0 auto' }}>
            <button
              className="ait-btn small"
              onClick={async () => {
                await platform.db.clear('history');
                load();
                toast('История очищена');
              }}
            >
              Очистить
            </button>
          </div>
        </div>
        {items.length === 0 ? <p className="ait-muted">Здесь появятся переведённые страницы.</p> : null}
        <table className="ait-table" style={{ marginTop: 10 }}>
          <tbody>
            {items.map((h) => (
              <tr key={`${h.date}-${h.key}`}>
                <td style={{ whiteSpace: 'nowrap' }}>{new Date(h.date).toLocaleString('ru')}</td>
                <td style={{ maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={h.url}>{h.title || h.url || '—'}</td>
                <td>{h.targetLang}</td>
                <td className="ait-muted">{h.model}</td>
                <td>{h.status === 'done' ? <span className="ait-badge ok">готово</span> : <span className="ait-badge err">{h.error ?? 'ошибка'}</span>}</td>
                <td style={{ width: 1 }}>
                  {h.status === 'done' ? (
                    <button className="ait-btn small" onClick={() => onOpen(h.key)}>Открыть</button>
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
