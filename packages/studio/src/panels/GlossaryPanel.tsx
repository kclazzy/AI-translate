import { useState } from 'react';
import { findGlossaryHits, shortId, type ContextEntity, type GlossaryEntry, type TranslationContext } from '@ait/core';
import { Field } from '../ui';

export function GlossaryEditor({ entries, onChange, title = 'Глоссарий' }: { entries: GlossaryEntry[]; onChange: (e: GlossaryEntry[]) => void; title?: string }) {
  const [probe, setProbe] = useState('');
  const set = (id: string, patch: Partial<GlossaryEntry>) => onChange(entries.map((e) => (e.id === id ? { ...e, ...patch } : e)));
  const hits = probe ? findGlossaryHits(probe, entries) : [];
  return (
    <div className="ait-panel">
      <h2>{title}</h2>
      <p className="ait-hint" style={{ marginTop: -6, marginBottom: 12 }}>
        Термины, которые модель обязана переводить именно так. «Запрещено» — варианты, которых быть не должно (например, «Танака-сан»).
      </p>
      <div style={{ overflowX: 'auto' }}>
        <table className="ait-table">
          <thead>
            <tr>
              <th>Оригинал</th>
              <th>Перевод</th>
              <th>Запрещено (через запятую)</th>
              <th>Совпадение</th>
              <th title="С учётом регистра">Aa</th>
              <th>Вкл.</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id}>
                <td><input className="ait-input" value={e.source} onChange={(ev) => set(e.id, { source: ev.target.value })} placeholder="田中" /></td>
                <td><input className="ait-input" value={e.target} onChange={(ev) => set(e.id, { target: ev.target.value })} placeholder="Танака" /></td>
                <td><input className="ait-input" value={e.forbidden.join(', ')} onChange={(ev) => set(e.id, { forbidden: ev.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} /></td>
                <td>
                  <select className="ait-select" value={e.matchMode} onChange={(ev) => set(e.id, { matchMode: ev.target.value as GlossaryEntry['matchMode'] })}>
                    <option value="exact">Точное</option>
                    <option value="regex">Регулярка</option>
                  </select>
                </td>
                <td><input type="checkbox" aria-label="С учётом регистра" checked={e.caseSensitive} onChange={(ev) => set(e.id, { caseSensitive: ev.target.checked })} /></td>
                <td><input type="checkbox" aria-label="Включено" checked={e.enabled} onChange={(ev) => set(e.id, { enabled: ev.target.checked })} /></td>
                <td><button className="ait-btn small ghost danger" onClick={() => onChange(entries.filter((x) => x.id !== e.id))}>Удалить</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="ait-row" style={{ marginTop: 12 }}>
        <div style={{ flex: '0 0 auto' }}>
          <button className="ait-btn" onClick={() => onChange([...entries, { id: shortId('g'), source: '', target: '', matchMode: 'exact', caseSensitive: false, forbidden: [], enabled: true }])}>
            Добавить термин
          </button>
        </div>
        <Field label="Проверить на тексте">
          <input className="ait-input" value={probe} onChange={(e) => setProbe(e.target.value)} placeholder="Вставьте реплику оригинала" />
        </Field>
      </div>
      {probe ? <p className="ait-hint">Сработает: {hits.length ? hits.map((h) => `${h.entry.source} → ${h.entry.target}`).join('; ') : 'ничего'}</p> : null}
    </div>
  );
}

const KINDS: [ContextEntity['kind'], string][] = [
  ['character', 'Персонаж'],
  ['place', 'Место'],
  ['term', 'Термин'],
  ['ability', 'Способность'],
  ['item', 'Предмет'],
  ['organization', 'Организация'],
  ['title', 'Титул'],
];

export function ContextEditor({ context, onChange }: { context: TranslationContext; onChange: (c: TranslationContext) => void }) {
  const set = (i: number, patch: Partial<ContextEntity>) => onChange({ ...context, entities: context.entities.map((e, j) => (j === i ? { ...e, ...patch } : e)), updatedAt: new Date().toISOString() });
  return (
    <div className="ait-panel">
      <h2>Контекст серии</h2>
      <p className="ait-hint" style={{ marginTop: -6, marginBottom: 12 }}>
        Имена и термины, найденные моделью на прошлых страницах. Закреплённые (🔒) модель никогда не меняет. Страниц учтено: {context.pagesSeen}.
      </p>
      <div style={{ overflowX: 'auto' }}>
        <table className="ait-table">
          <thead>
            <tr><th>Оригинал</th><th>Перевод</th><th>Тип</th><th>Пол</th><th>Манера речи</th><th>🔒</th><th /></tr>
          </thead>
          <tbody>
            {context.entities.map((e, i) => (
              <tr key={`${e.source}-${i}`}>
                <td><input className="ait-input" value={e.source} onChange={(ev) => set(i, { source: ev.target.value })} /></td>
                <td><input className="ait-input" value={e.target} onChange={(ev) => set(i, { target: ev.target.value })} /></td>
                <td>
                  <select className="ait-select" value={e.kind} onChange={(ev) => set(i, { kind: ev.target.value as ContextEntity['kind'] })}>
                    {KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                  </select>
                </td>
                <td>
                  <select className="ait-select" value={e.gender ?? 'unknown'} onChange={(ev) => set(i, { gender: ev.target.value as ContextEntity['gender'] })}>
                    <option value="unknown">—</option>
                    <option value="male">м</option>
                    <option value="female">ж</option>
                    <option value="other">другое</option>
                  </select>
                </td>
                <td><input className="ait-input" value={e.speechStyle ?? ''} onChange={(ev) => set(i, { speechStyle: ev.target.value })} placeholder="грубо, на «ты»" /></td>
                <td><input type="checkbox" aria-label="Закрепить" checked={e.locked} onChange={(ev) => set(i, { locked: ev.target.checked })} /></td>
                <td><button className="ait-btn small ghost danger" onClick={() => onChange({ ...context, entities: context.entities.filter((_, j) => j !== i) })}>Удалить</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="ait-row" style={{ marginTop: 12 }}>
        <div style={{ flex: '0 0 auto' }}>
          <button className="ait-btn" onClick={() => onChange({ ...context, entities: [...context.entities, { source: '', target: '', kind: 'character', locked: true }] })}>
            Добавить имя
          </button>
        </div>
      </div>
      <h3>Заметки о стиле серии</h3>
      <textarea className="ait-textarea" value={context.styleNotes} onChange={(e) => onChange({ ...context, styleNotes: e.target.value })} placeholder="Например: главный герой говорит коротко и грубо" />
      {context.summaries.length ? (
        <>
          <h3>Краткое содержание прошлых страниц</h3>
          <ol className="ait-hint" style={{ paddingLeft: 20 }}>
            {context.summaries.map((s, i) => <li key={i}>{s}</li>)}
          </ol>
          <button className="ait-btn small" onClick={() => onChange({ ...context, summaries: [], recentLines: [] })}>Очистить содержание</button>
        </>
      ) : null}
    </div>
  );
}
