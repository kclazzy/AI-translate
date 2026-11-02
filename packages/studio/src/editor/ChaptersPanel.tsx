import { useEffect, useState } from 'react';
import { tr, uiLocale } from '@ait/core/i18n';
import { usePlatform } from '../platform';
import { groupHistory, type SeriesFolder } from './chapters';
import { confirmLeave } from './guard';
import { forgetFolder } from './forget';

/**
 * «Главы» in the editor: the translated chapters as folders (site → chapter), from the history; a
 * click opens that chapter here (unsaved edits are asked about first).
 */
export function ChaptersPanel({ currentKey, onOpen, onGone }: { currentKey: string; onOpen: (keys: string[]) => void; /** The chapter open here was deleted. */ onGone?: () => void }) {
  const platform = usePlatform();
  const [open, setOpen] = useState(false);
  const [sites, setSites] = useState<SeriesFolder[] | null>(null);
  const load = () => void platform.service.history(1000).then((h) => setSites(groupHistory(h, { failed: true })));
  useEffect(() => {
    if (open) load();
  }, [open, platform]);
  const forget = async (keys: string[], what: string) => {
    if (!(await forgetFolder(platform, keys, what))) return;
    // The page open here went too (also as a picture of a deleted strip): the editor closes.
    if (keys.includes(currentKey) || !(await platform.service.getResult(currentKey))) onGone?.();
    else load();
  };
  const mine = sites?.find((s) => s.chapters.some((c) => c.keys.includes(currentKey)));
  return (
    <span style={{ position: 'relative' }}>
      <button className={`ait-btn small ${open ? 'active' : ''}`} aria-expanded={open} onClick={() => setOpen(!open)} data-testid="chapters-button" title={tr('Переведённые главы по сериям: открыть другую, не выходя из редактора')}>
        {tr('Главы')}
      </button>
      {open ? (
        <div className="ait-chapters" data-testid="chapters-panel" role="dialog" aria-label={tr('Главы')}>
          {!sites ? <p className="ait-muted">{tr('Загрузка…')}</p> : null}
          {sites && !sites.length ? <p className="ait-muted">{tr('История пуста: переведённые главы появятся здесь.')}</p> : null}
          {sites?.map((s) => (
            <details key={s.key} open={s === mine || sites.length === 1}>
              <summary>
                <b>{s.name}</b> <small className="ait-muted">{s.site ? `${s.site} · ` : ''}({s.chapters.length})</small>{' '}
                <button className="ait-btn small ghost" data-testid="forget-series" title={tr('Удалить мангу: все её переведённые главы')} onClick={(e) => { e.preventDefault(); void forget(s.chapters.flatMap((c) => c.entries.map((x) => x.key)), tr('мангу «{0}»', s.name)); }}>
                  🗑
                </button>
              </summary>
              <ul>
                {s.chapters.map((c) => {
                  const here = c.keys.includes(currentKey);
                  return (
                    <li key={c.url || c.keys[0]}>
                      <button
                        className={`pp-link ${here ? 'current' : ''}`}
                        aria-current={here ? 'page' : undefined}
                        disabled={here || !c.keys.length}
                        title={c.title || c.url}
                        onClick={() =>
                          void confirmLeave().then((ok) => {
                            if (!ok) return;
                            setOpen(false);
                            onOpen(c.keys);
                          })
                        }
                      >
                        {c.number !== undefined ? tr('Глава {0}', c.number) : c.title}
                      </button>{' '}
                      <small className="ait-muted">
                        {tr('{0} стр.', c.pages)} · {new Date(c.last).toLocaleDateString(uiLocale())}
                      </small>{' '}
                      <button className="ait-btn small ghost" data-testid="forget-chapter" title={tr('Удалить главу')} onClick={() => void forget(c.entries.map((x) => x.key), c.number !== undefined ? tr('главу {0}', c.number) : tr('главу «{0}»', c.title))}>
                        🗑
                      </button>
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
