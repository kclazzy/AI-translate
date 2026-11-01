import { useEffect, useMemo, useState } from 'react';
import { describeRoute, providerById, type AppSettings, type HistoryEntry, type UsageTotals } from '@ait/core';
import { usePlatform } from '../platform';
import { groupHistory } from '../editor/chapters';
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

export function HistoryPanel({ onOpen, onOpenChapter }: { onOpen: (key: string) => void; onOpenChapter?: (keys: string[]) => void }) {
  const platform = usePlatform();
  const [items, setItems] = useState<HistoryEntry[]>([]);
  const [usage, setUsage] = useState<UsageTotals | null>(null);
  const load = () => {
    void platform.service.history(1000).then(setItems);
    void platform.service.usage().then(setUsage);
  };
  useEffect(load, [platform]);
  // Folders: manga → chapter → pages (failed pages too, to see why).
  const series = useMemo(() => groupHistory(items, { failed: true }), [items]);
  const day = (d: string) => new Date(d).toLocaleString(uiLocale());
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
        {series.map((s, i) => (
          <details key={s.key} className="ait-hist-series" open={i === 0} data-testid="history-series">
            <summary>
              <b>{s.name}</b> <small className="ait-muted">{s.site ? `${s.site} · ` : ''}{tr('глав: {0}', s.chapters.length)}</small>
            </summary>
            {s.chapters.map((c) => {
              let at = 0;
              return (
                <details key={c.url || c.entries[0]?.key} className="ait-hist-chapter" data-testid="history-chapter">
                  <summary>
                    <span>{c.number !== undefined ? tr('Глава {0}', c.number) : c.title}</span> <small className="ait-muted">{tr('{0} стр.', c.pages)} · {day(c.last)}</small>{' '}
                    {c.keys.length && onOpenChapter ? (
                      <button
                        className="ait-btn small"
                        onClick={(e) => {
                          e.preventDefault();
                          onOpenChapter(c.keys);
                        }}
                      >
                        {tr('Открыть главу')}
                      </button>
                    ) : null}
                  </summary>
                  <table className="ait-table" style={{ marginTop: 6 }}>
                    <tbody>
                      {c.entries.map((h) => {
                        const n = Math.max(1, h.pages || 1);
                        const label = n > 1 ? tr('Стр. {0}–{1}', at + 1, at + n) : tr('Стр. {0}', at + 1);
                        at += n;
                        return (
                          <tr key={`${h.date}-${h.key}`}>
                            <td style={{ whiteSpace: 'nowrap' }}>{label}</td>
                            <td style={{ whiteSpace: 'nowrap' }}>{day(h.date)}</td>
                            <td>{h.targetLang}</td>
                            <td className="ait-muted">{h.model}</td>
                            <td>{h.status === 'done' ? <span className="ait-badge ok">{tr('готово')}</span> : <span className="ait-badge err">{h.error ?? tr('ошибка')}</span>}</td>
                            <td style={{ width: 1 }}>{h.status === 'done' ? <button className="ait-btn small" onClick={() => onOpen(h.key)}>{tr('Открыть')}</button> : null}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </details>
              );
            })}
          </details>
        ))}
      </div>
    </div>
  );
}
