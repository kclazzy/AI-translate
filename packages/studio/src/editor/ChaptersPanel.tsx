import { useEffect, useState } from 'react';
import { tr, uiLocale } from '@ait/core/i18n';
import { usePlatform } from '../platform';
import { groupHistory, type SiteFolder } from './chapters';
import { confirmLeave } from './guard';

/**
 * «Главы» in the editor: the translated chapters as folders (site → chapter), from the history; a
 * click opens that chapter here (unsaved edits are asked about first).
 */
export function ChaptersPanel({ currentKey, onOpen }: { currentKey: string; onOpen: (keys: string[]) => void }) {
  const platform = usePlatform();
  const [open, setOpen] = useState(false);
  const [sites, setSites] = useState<SiteFolder[] | null>(null);
  useEffect(() => {
    if (open) void platform.service.history(1000).then((h) => setSites(groupHistory(h)));
  }, [open, platform]);
  const mine = sites?.find((s) => s.chapters.some((c) => c.keys.includes(currentKey)));
  return (
    <span style={{ position: 'relative' }}>
      <button className={`ait-btn small ${open ? 'active' : ''}`} aria-expanded={open} onClick={() => setOpen(!open)} data-testid="chapters-button" title={tr('Переведённые главы по сайтам: открыть другую, не выходя из редактора')}>
        {tr('Главы')}
      </button>
      {open ? (
        <div className="ait-chapters" data-testid="chapters-panel" role="dialog" aria-label={tr('Главы')}>
          {!sites ? <p className="ait-muted">{tr('Загрузка…')}</p> : null}
          {sites && !sites.length ? <p className="ait-muted">{tr('История пуста: переведённые главы появятся здесь.')}</p> : null}
          {sites?.map((s) => (
            <details key={s.site} open={s === mine || sites.length === 1}>
              <summary>
                <b>{s.site || tr('Открытые в студии')}</b> <small className="ait-muted">({s.chapters.length})</small>
              </summary>
              <ul>
                {s.chapters.map((c) => {
                  const here = c.keys.includes(currentKey);
                  return (
                    <li key={c.url || c.keys[0]}>
                      <button
                        className={`pp-link ${here ? 'current' : ''}`}
                        aria-current={here ? 'page' : undefined}
                        disabled={here}
                        title={c.url}
                        onClick={() =>
                          void confirmLeave().then((ok) => {
                            if (!ok) return;
                            setOpen(false);
                            onOpen(c.keys);
                          })
                        }
                      >
                        {c.title}
                      </button>{' '}
                      <small className="ait-muted">
                        {tr('{0} стр.', c.pages)} · {new Date(c.last).toLocaleDateString(uiLocale())}
                      </small>
                    </li>
                  );
                })}
              </ul>
            </details>
          ))}
        </div>
      ) : null}
    </span>
  );
}
