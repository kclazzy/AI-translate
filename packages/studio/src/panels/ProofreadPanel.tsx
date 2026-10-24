import { useMemo, useState, useSyncExternalStore } from 'react';
import { QA_LABELS, qaNote, replaceInText, type AppSettings, type Project, type ProjectPage, type TextBlock } from '@ait/core';
import { tr } from '@ait/core/i18n';
import { usePlatform } from '../platform';
import { rerenderProjectPage, type ProjectStore } from '../projects';
import { ErrorBox, Progress, Switch, toast, useAction } from '../ui';

/**
 * «Вычитка»: every text of the chapter in one table — the original and the translation side by
 * side. Edits wait as drafts (kept while the user looks at other tabs) and «Сохранить» draws the
 * changed pages again; find and replace works on the whole chapter at once.
 */

/** Drafts of the chapter open in the table: pageId → blockId → text. Outside the component: switching tabs keeps them. */
const drafts = new Map<string, Map<string, Map<string, string>>>();
const subs = new Set<() => void>();
let version = 0;
const changed = () => {
  version++;
  for (const f of subs) f();
};
const useDraftsVersion = () =>
  useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => version,
  );

function draftsOf(projectId: string): Map<string, Map<string, string>> {
  let d = drafts.get(projectId);
  if (!d) drafts.set(projectId, (d = new Map()));
  return d;
}

/** Unsaved edits of the table for this chapter (the page list warns before they are lost). */
export function proofreadDraftCount(projectId: string): number {
  let n = 0;
  for (const m of drafts.get(projectId)?.values() ?? []) n += m.size;
  return n;
}

const PAGE_ROWS = 300;

interface Row {
  page: ProjectPage;
  block: TextBlock;
}

/** What makes a line worth a second look: the check's remarks, a doubtful reading, text that did not fit. */
function remarks(b: TextBlock): string[] {
  const out = (b.qa?.issues ?? []).map((q) => `${QA_LABELS[q.kind]}: ${qaNote(q)}`);
  if (b.lowConfidence) out.push(tr('Текст прочитан неуверенно'));
  if (b.overflow) out.push(tr('Перевод не поместился в бабл'));
  if (b.selfCheck?.issues.length) out.push(tr('Самопроверка: есть замечания'));
  return out;
}

export function ProofreadPanel({ store, project, settings, onChange, onOpenPage }: { store: ProjectStore; project: Project; settings: AppSettings; onChange: (p: Project) => void; onOpenPage: (p: ProjectPage) => void }) {
  const platform = usePlatform();
  useDraftsVersion();
  const d = draftsOf(project.id);
  const [filter, setFilter] = useState('');
  const [only, setOnly] = useState<'all' | 'remarks' | 'edited'>('all');
  const [find, setFind] = useState('');
  const [repl, setRepl] = useState('');
  const [whole, setWhole] = useState(true);
  const [cs, setCs] = useState(false);
  const [limit, setLimit] = useState(PAGE_ROWS);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  const all = useMemo<Row[]>(() => project.pages.flatMap((page) => (page.result?.blocks ?? []).filter((b) => b.translate !== false && !b.continued).map((block) => ({ page, block }))), [project]);
  const textOf = (r: Row) => d.get(r.page.id)?.get(r.block.id) ?? r.block.translatedText;
  const q = filter.trim().toLocaleLowerCase();
  const rows = all.filter((r) => {
    if (only === 'remarks' && !remarks(r.block).length) return false;
    if (only === 'edited' && !r.block.edited && !d.get(r.page.id)?.has(r.block.id)) return false;
    return !q || r.block.originalText.toLocaleLowerCase().includes(q) || textOf(r).toLocaleLowerCase().includes(q);
  });
  const pending = proofreadDraftCount(project.id);

  const setText = (r: Row, text: string) => {
    let m = d.get(r.page.id);
    if (!m) d.set(r.page.id, (m = new Map()));
    if (text === r.block.translatedText) m.delete(r.block.id);
    else m.set(r.block.id, text);
    if (!m.size) d.delete(r.page.id);
    changed();
  };

  const replaceAll = () => {
    let count = 0;
    for (const r of rows) {
      const res = replaceInText(textOf(r), find, repl, { wholeWord: whole, caseSensitive: cs });
      if (!res.count) continue;
      count += res.count;
      setText(r, res.text);
    }
    toast(count ? tr('Заменено: {0}. Нажмите «Сохранить», чтобы перерисовать страницы.', count) : tr('Ничего не найдено'));
  };

  const save = useAction(async () => {
    const ids = [...d.keys()];
    let current = project;
    for (const [i, pageId] of ids.entries()) {
      setProgress({ done: i, total: ids.length });
      const edits = d.get(pageId);
      // The latest stored copy: an edit made in the editor meanwhile stays.
      const page = current.pages.find((p) => p.id === pageId);
      if (!edits || !page?.result) {
        d.delete(pageId);
        continue;
      }
      const blocks = page.result.blocks.map((b) => (edits.has(b.id) ? { ...b, translatedText: edits.get(b.id)!, edited: true } : b));
      current = await rerenderProjectPage(store, platform.backend, settings, current, page, { ...page.result, blocks });
      d.delete(pageId);
      changed();
    }
    setProgress(null);
    onChange(current);
    toast(tr('Сохранено страниц: {0}', ids.length));
  });

  if (!all.length) return <div className="ait-panel"><p className="ait-muted">{tr('Здесь появятся тексты главы, когда страницы будут переведены.')}</p></div>;

  return (
    <div data-testid="proofread">
      <div className="ait-panel">
        <div className="ait-row" style={{ alignItems: 'center' }}>
          <input className="ait-input" style={{ flex: '1 1 220px' }} value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={tr('Поиск по оригиналу и переводу')} aria-label={tr('Поиск по оригиналу и переводу')} />
          <select className="ait-select" style={{ flex: '0 0 200px' }} value={only} onChange={(e) => setOnly(e.target.value as typeof only)} aria-label={tr('Показывать')}>
            <option value="all">{tr('Все строки ({0})', all.length)}</option>
            <option value="remarks">{tr('Только с замечаниями')}</option>
            <option value="edited">{tr('Только исправленные')}</option>
          </select>
          <button className="ait-bubble-btn" style={{ flex: '0 0 auto' }} data-testid="proofread-save" disabled={!pending || save.busy} onClick={() => void save.run()}>
            {pending ? tr('Сохранить ({0})', pending) : tr('Сохранено')}
          </button>
          {pending && !save.busy ? <button className="ait-btn ghost" style={{ flex: '0 0 auto' }} onClick={() => { drafts.delete(project.id); changed(); }}>{tr('Отменить правки')}</button> : null}
        </div>
        <div className="ait-row" style={{ marginTop: 10, alignItems: 'center' }} data-testid="proofread-replace">
          <input className="ait-input" style={{ flex: '1 1 160px' }} value={find} onChange={(e) => setFind(e.target.value)} placeholder={tr('Найти в переводе')} aria-label={tr('Найти в переводе')} />
          <input className="ait-input" style={{ flex: '1 1 160px' }} value={repl} onChange={(e) => setRepl(e.target.value)} placeholder={tr('Заменить на')} aria-label={tr('Заменить на')} />
          <Switch checked={whole} onChange={setWhole} label={tr('Слово целиком')} />
          <Switch checked={cs} onChange={setCs} label={tr('С учётом регистра')} />
          <button className="ait-btn" style={{ flex: '0 0 auto' }} disabled={!find} onClick={replaceAll}>{tr('Заменить везде')}</button>
        </div>
        {progress ? <div style={{ marginTop: 10 }}><Progress value={progress.done / Math.max(1, progress.total)} label={tr('Перерисовка {0} / {1}', progress.done + 1, progress.total)} /></div> : null}
        <ErrorBox error={save.error} />
      </div>
      <div className="ait-panel" style={{ padding: 0, overflowX: 'auto' }}>
        <table className="ait-table ait-proof">
          <thead>
            <tr>
              <th style={{ width: 56 }}>{tr('Стр.')}</th>
              <th>{tr('Оригинал')}</th>
              <th>{tr('Перевод')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, limit).map((r) => {
              const notes = remarks(r.block);
              const text = textOf(r);
              const dirty = d.get(r.page.id)?.has(r.block.id);
              return (
                <tr key={`${r.page.id}:${r.block.id}`} className={dirty ? 'dirty' : undefined}>
                  <td>
                    <button className="ait-btn small ghost" title={tr('Открыть страницу в редакторе')} disabled={r.page.status !== 'done'} onClick={() => onOpenPage(r.page)}>{r.page.index + 1}</button>
                  </td>
                  <td className="ait-proof-orig" lang={r.block.language || undefined}>
                    {r.block.originalText}
                    {notes.length ? <div className="ait-proof-notes" title={notes.join('\n')}>⚠ {notes[0]}{notes.length > 1 ? ` (+${notes.length - 1})` : ''}</div> : null}
                  </td>
                  <td>
                    <textarea className="ait-input" rows={Math.min(6, Math.max(2, Math.ceil(text.length / 40)))} value={text} onChange={(e) => setText(r, e.target.value)} aria-label={tr('Перевод, страница {0}', r.page.index + 1)} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {rows.length > limit ? (
          <div style={{ padding: 12 }}>
            <button className="ait-btn" onClick={() => setLimit(limit + PAGE_ROWS)}>{tr('Показать ещё ({0})', rows.length - limit)}</button>
          </div>
        ) : null}
        {!rows.length ? <p className="ait-muted" style={{ padding: 12 }}>{tr('Ничего не найдено')}</p> : null}
      </div>
    </div>
  );
}
