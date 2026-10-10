import { useMemo, useState } from 'react';
import { builtinEntries, builtinGenres, shortId, type AppSettings, type BookEntry, type PhraseCategory, type PhrasebookSettings, type UserPhrase } from '@ait/core';
import { tr } from '@ait/core/i18n';
import { Field, Segmented, Switch } from '../ui';
import { filterEntries, phrasebookOf, splitForms, toggleEntry } from '../phrasebook';

const PAGE = 200;

const LANGS: { value: string; label: string }[] = [
  { value: 'ja', label: tr('Японский') },
  { value: 'ko', label: tr('Корейский') },
  { value: 'zh', label: tr('Китайский') },
  { value: 'en', label: tr('Английский') },
];

const CATS: [PhraseCategory, string][] = [
  ['interjection', tr('Реакции и междометия')],
  ['situational', tr('Ситуативные фразы')],
  ['slang', tr('Сленг')],
  ['address', tr('Обращения')],
  ['term', tr('Термины')],
];

const GENRES: Record<string, string> = {
  cultivation: tr('Культивация (сянься, уся)'),
};

const catName = (c: PhraseCategory) => CATS.find(([k]) => k === c)?.[1] ?? c;

interface Draft {
  id: string | null;
  source: string;
  forms: string;
  variants: { text: string; when: string }[];
  note: string;
}

const emptyDraft = (source: string): Draft => ({ id: null, source, forms: '', variants: [{ text: '', when: '' }], note: '' });

/** «Разговорник»: hints for the model on recurring expressions (なるほど, 대박, "No way"). */
export function PhrasebookPanel({ settings, update }: { settings: AppSettings; update: (patch: Partial<AppSettings>) => void }) {
  const pb = phrasebookOf(settings);
  const set = (next: PhrasebookSettings) => update({ phrasebook: next });
  const [lang, setLang] = useState(() => (['ja', 'ko', 'zh', 'en'].includes(settings.sourceLang) ? settings.sourceLang : 'ja'));
  const [query, setQuery] = useState('');
  const [cat, setCat] = useState<PhraseCategory | ''>('');
  const [limit, setLimit] = useState(PAGE);
  const all = useMemo(() => builtinEntries(), []);
  const genres = useMemo(() => builtinGenres(), []);
  const list = useMemo(() => filterEntries(all, { lang, query, cat }), [all, lang, query, cat]);
  const disabled = useMemo(() => new Set(pb.disabled), [pb.disabled]);
  const counts = useMemo(() => Object.fromEntries(LANGS.map((l) => [l.value, all.filter((e) => e.source === l.value).length])), [all]);
  const reset = () => setLimit(PAGE);

  return (
    <>
      <div className="ait-panel" data-testid="phrasebook">
        <h2>{tr('Разговорник')}</h2>
        <p className="ait-hint" style={{ marginTop: -6, marginBottom: 12 }}>
          {tr('Устойчивые выражения (なるほど, 대박, «No way») с вариантами перевода. Если такое выражение есть на странице, модель получает подсказку и сама выбирает вариант по сцене — ничего не заменяется принудительно. Глоссарий важнее разговорника. Сейчас — для перевода на русский.')}
        </p>
        <Switch checked={pb.enabled} onChange={(enabled) => set({ ...pb, enabled })} label={tr('Подсказывать модели устойчивые выражения (разговорник)')} />
        {genres.length ? (
          <div style={{ marginTop: 14 }}>
            <h3 style={{ margin: '0 0 6px' }}>{tr('Жанровые наборы')}</h3>
            <p className="ait-hint" style={{ margin: '0 0 8px' }}>{tr('Термины жанра включаются только если вы переводите такие тайтлы.')}</p>
            {genres.map((g) => (
              <div key={g} style={{ marginBottom: 6 }}>
                <Switch
                  checked={pb.genres.includes(g)}
                  disabled={!pb.enabled}
                  onChange={(v) => set({ ...pb, genres: v ? [...pb.genres.filter((x) => x !== g), g] : pb.genres.filter((x) => x !== g) })}
                  label={GENRES[g] ?? g}
                />
              </div>
            ))}
          </div>
        ) : null}
      </div>

      <div className="ait-panel">
        <div className="ait-row">
          <div style={{ flex: '0 0 auto' }}>
            <Segmented value={lang} options={LANGS.map((l) => ({ value: l.value, label: `${l.label} · ${counts[l.value] ?? 0}` }))} onChange={(v) => { setLang(v); reset(); }} label={tr('Язык оригинала')} />
          </div>
          <Field label={tr('Поиск')}>
            <input className="ait-input" type="search" value={query} onChange={(e) => { setQuery(e.target.value); reset(); }} placeholder={tr('Выражение или перевод')} data-testid="pb-search" />
          </Field>
          <Field label={tr('Категория')}>
            <select className="ait-select" value={cat} onChange={(e) => { setCat(e.target.value as PhraseCategory | ''); reset(); }}>
              <option value="">{tr('Все')}</option>
              {CATS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </Field>
        </div>
        <p className="ait-hint">{tr('Найдено: {0}. Снимите галочку, чтобы модель не получала подсказку для выражения.', list.length)}</p>
        <ul className="ait-pb-list">
          {list.slice(0, limit).map((e) => (
            <EntryRow key={e.id} entry={e} enabled={!disabled.has(e.id)} genreOff={!!e.genre && !pb.genres.includes(e.genre)} onToggle={(v) => set(toggleEntry(pb, e.id, v))} />
          ))}
        </ul>
        {list.length > limit ? (
          <button className="ait-btn small" style={{ marginTop: 10 }} onClick={() => setLimit(limit + PAGE)}>
            {tr('Показать ещё ({0})', list.length - limit)}
          </button>
        ) : null}
      </div>

      <UserPhrases pb={pb} set={set} lang={lang} />
    </>
  );
}

function EntryRow({ entry: e, enabled, genreOff, onToggle }: { entry: BookEntry; enabled: boolean; genreOff: boolean; onToggle: (v: boolean) => void }) {
  return (
    <li className="ait-pb-row" data-testid="pb-row" data-id={e.id} style={enabled && !genreOff ? undefined : { opacity: 0.6 }}>
      <input type="checkbox" checked={enabled} onChange={(ev) => onToggle(ev.target.checked)} aria-label={tr('Подсказывать «{0}»', e.src[0])} />
      <div className="ait-pb-body">
        <div>
          <strong lang={e.source}>{e.src.slice(0, 3).join(' · ')}</strong>
          {e.src.length > 3 ? <span className="ait-muted"> +{e.src.length - 3}</span> : null}
          <span className="ait-pb-tags">
            <span className="ait-badge">{catName(e.cat)}</span>
            {e.standalone ? <span className="ait-badge" title={tr('Только когда реплика почти целиком из этого выражения')}>{tr('целая реплика')}</span> : null}
            {e.genre ? <span className="ait-badge">{GENRES[e.genre] ?? e.genre}</span> : null}
          </span>
        </div>
        <ul className="ait-pb-variants">
          {e.variants.map((v, i) => (
            <li key={i}>
              «{v.text}»{v.when ? <span className="ait-muted"> — {v.when}</span> : null}
              {v.policy ? <span className="ait-muted"> ({v.policy === 'keep' ? tr('с хонорификами') : tr('без хонорификов')})</span> : null}
            </li>
          ))}
        </ul>
        {e.note ? <div className="ait-hint" style={{ margin: 0 }}>⚠ {e.note}</div> : null}
      </div>
    </li>
  );
}

function UserPhrases({ pb, set, lang }: { pb: PhrasebookSettings; set: (p: PhrasebookSettings) => void; lang: string }) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const save = () => {
    if (!draft) return;
    const src = splitForms(draft.forms);
    const variants = draft.variants.map((v) => ({ text: v.text.trim(), when: v.when.trim() })).filter((v) => v.text);
    if (!src.length || !variants.length) return;
    const entry: UserPhrase = { id: draft.id ?? shortId('user:'), source: draft.source, src, variants, ...(draft.note.trim() ? { note: draft.note.trim() } : {}) };
    set({ ...pb, user: draft.id ? pb.user.map((u) => (u.id === draft.id ? entry : u)) : [...pb.user, entry] });
    setDraft(null);
  };
  const edit = (u: UserPhrase) => setDraft({ id: u.id, source: u.source, forms: u.src.join(', '), variants: u.variants.map((v) => ({ ...v })), note: u.note ?? '' });
  const ready = !!draft && splitForms(draft.forms).length > 0 && draft.variants.some((v) => v.text.trim());
  return (
    <div className="ait-panel" data-testid="pb-user">
      <h2>{tr('Свои выражения')}</h2>
      <p className="ait-hint" style={{ marginTop: -6, marginBottom: 12 }}>
        {tr('Ваши варианты важнее встроенных: если написание совпадает, модель получит только ваш вариант. Сюда же попадает «Запомнить» из редактора.')}
      </p>
      {pb.user.length ? (
        <ul className="ait-pb-list">
          {pb.user.map((u) => (
            <li key={u.id} className="ait-pb-row" data-testid="pb-user-row">
              <span className="ait-badge">{u.source}</span>
              <div className="ait-pb-body">
                <strong lang={u.source}>{u.src.join(' · ')}</strong>
                <ul className="ait-pb-variants">
                  {u.variants.map((v, i) => <li key={i}>«{v.text}»{v.when ? <span className="ait-muted"> — {v.when}</span> : null}</li>)}
                </ul>
                {u.note ? <div className="ait-hint" style={{ margin: 0 }}>⚠ {u.note}</div> : null}
              </div>
              <button className="ait-btn small ghost" onClick={() => edit(u)}>{tr('Изменить')}</button>
              <button className="ait-btn small ghost danger" onClick={() => set({ ...pb, user: pb.user.filter((x) => x.id !== u.id) })} aria-label={tr('Удалить «{0}»', u.src[0])}>{tr('Удалить')}</button>
            </li>
          ))}
        </ul>
      ) : <p className="ait-muted">{tr('Пока нет своих выражений.')}</p>}

      {draft ? (
        <div className="ait-pb-form">
          <div className="ait-row">
            <Field label={tr('Язык оригинала')}>
              <select className="ait-select" value={draft.source} onChange={(e) => setDraft({ ...draft, source: e.target.value })}>
                {LANGS.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
              </select>
            </Field>
            <Field label={tr('Написания (через запятую)')}>
              <input className="ait-input" value={draft.forms} onChange={(e) => setDraft({ ...draft, forms: e.target.value })} placeholder="なるほど, 成程" data-testid="pb-forms" />
            </Field>
          </div>
          {draft.variants.map((v, i) => (
            <div className="ait-row" key={i} style={{ marginTop: 8 }}>
              <Field label={tr('Вариант перевода')}>
                <input className="ait-input" value={v.text} onChange={(e) => setDraft({ ...draft, variants: draft.variants.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)) })} placeholder={tr('Вот оно что')} data-testid="pb-variant" />
              </Field>
              <Field label={tr('Когда')}>
                <input className="ait-input" value={v.when} onChange={(e) => setDraft({ ...draft, variants: draft.variants.map((x, j) => (j === i ? { ...x, when: e.target.value } : x)) })} placeholder={tr('догадка')} />
              </Field>
              <div style={{ flex: '0 0 auto' }}>
                <button className="ait-btn small ghost danger" disabled={draft.variants.length < 2} onClick={() => setDraft({ ...draft, variants: draft.variants.filter((_, j) => j !== i) })}>{tr('Убрать')}</button>
              </div>
            </div>
          ))}
          <button className="ait-btn small ghost" style={{ marginTop: 8 }} onClick={() => setDraft({ ...draft, variants: [...draft.variants, { text: '', when: '' }] })} disabled={draft.variants.length >= 8}>
            {tr('+ вариант')}
          </button>
          <Field label={tr('Примечание для модели (необязательно)')}>
            <input className="ait-input" value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })} placeholder={tr('не переводить дословно')} />
          </Field>
          <div className="ait-row" style={{ marginTop: 10 }}>
            <div style={{ flex: '0 0 auto', display: 'flex', gap: 8 }}>
              <button className="ait-btn" onClick={save} disabled={!ready} data-testid="pb-save">{draft.id ? tr('Сохранить') : tr('Добавить')}</button>
              <button className="ait-btn ghost" onClick={() => setDraft(null)}>{tr('Отмена')}</button>
            </div>
          </div>
        </div>
      ) : (
        <button className="ait-btn" style={{ marginTop: 12 }} onClick={() => setDraft(emptyDraft(lang))} data-testid="pb-add">{tr('Добавить выражение')}</button>
      )}
    </div>
  );
}
