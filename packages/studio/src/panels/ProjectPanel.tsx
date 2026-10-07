import { useEffect, useMemo, useRef, useState } from 'react';
import { replaceInText, toAppError, errorMessage, type AppSettings, type ImageMime, type Project, type ProjectPage, type TextStyle } from '@ait/core';
import { ProjectPageEditor } from '../editor/EditorHost';
import { exportCbz, exportEpub, exportPdf, exportZip, importFiles, type ExportPage } from '../files';
import { usePlatform } from '../platform';
import { rerenderProjectPage, translateProjectPage, ProjectStore } from '../projects';
import { ErrorBox, Field, Progress, Switch, toast, useAction, useObjectUrl } from '../ui';
import { ContextEditor, GlossaryEditor } from './GlossaryPanel';
import { tr, uiLocale } from '@ait/core/i18n';

function Thumb({ store, project, page }: { store: ProjectStore; project: Project; page: ProjectPage }) {
  const [bytes, setBytes] = useState<Uint8Array>();
  useEffect(() => {
    let cancel = false;
    void store.assets(project.id, page.id).then((a) => {
      if (!cancel && a) setBytes(a.rendered?.[0]?.bytes ?? a.original.bytes);
    });
    return () => {
      cancel = true;
    };
  }, [store, project.id, page.id, page.result?.createdAt, page.status]);
  const url = useObjectUrl(bytes);
  return url ? <img src={url} alt={page.name} loading="lazy" /> : <img alt="" />;
}

const STATUS: Record<ProjectPage['status'], string> = { new: tr('не переведена'), queued: tr('в очереди'), working: tr('перевод…'), done: tr('готово'), error: tr('ошибка') };

function DropZone({ onFiles, label }: { onFiles: (f: File[]) => void; label: string }) {
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  return (
    <div
      className={`ait-drop ${over ? 'over' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        onFiles([...e.dataTransfer.files]);
      }}
    >
      <p style={{ margin: '0 0 10px' }}>{label}</p>
      <button className="ait-btn" onClick={() => input.current?.click()}>{tr('Выбрать файлы')}</button>
      <input ref={input} type="file" multiple hidden accept="image/*,.zip,.cbz,.epub,.pdf,.cbr,.rar" onChange={(e) => e.target.files && onFiles([...e.target.files])} />
      <p className="ait-hint">{tr('PNG, JPG, WEBP, AVIF, GIF, BMP; глава целиком — PDF, ZIP, CBZ, EPUB')}</p>
    </div>
  );
}

export function ProjectPanel({ settings, initialFiles }: { settings: AppSettings; initialFiles?: File[] }) {
  const platform = usePlatform();
  const store = useMemo(() => new ProjectStore(platform.db), [platform]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [project, setProject] = useState<Project | null>(null);
  const [editing, setEditing] = useState<ProjectPage | null>(null);
  const [tab, setTab] = useState<'pages' | 'glossary' | 'context' | 'replace'>('pages');
  const [progress, setProgress] = useState<{ done: number; total: number; label: string } | null>(null);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [exportFmt, setExportFmt] = useState<'zip-png' | 'zip-jpg' | 'zip-webp' | 'pdf' | 'cbz' | 'epub'>('pdf');
  const abort = useRef<AbortController | null>(null);
  const scanlator = settings.uiMode === 'scanlator';

  const reload = () => void store.list().then(setProjects);
  useEffect(reload, [store]);

  const create = useAction(async (files: File[]) => {
    setProgress({ done: 0, total: 1, label: tr('Чтение файлов…') });
    try {
      const images = await importFiles(files, (m) => setProgress({ done: 0, total: 1, label: m }));
      if (!images.length) throw toAppError(new Error(tr('В файлах нет изображений')));
      const title = files.length === 1 ? files[0].name.replace(/\.[^.]+$/, '') : tr('Глава от {0}', new Date().toLocaleDateString(uiLocale()));
      const p = await store.create(title, settings, images, platform.backend);
      setProject(p);
      reload();
    } finally {
      setProgress(null);
    }
  });

  useEffect(() => {
    if (initialFiles?.length) void create.run(initialFiles);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialFiles]);

  const addPages = useAction(async (files: File[]) => {
    if (!project) return;
    const images = await importFiles(files);
    const p = { ...project, pages: [...project.pages] };
    await store.addPages(p, images, platform.backend);
    setProject(await store.save(p));
  });

  const importProject = useAction(async (file: File) => {
    const p = await store.importProject(new Uint8Array(await file.arrayBuffer()));
    setProject(p);
    reload();
  });

  const translateAll = useAction(async (onlyNew: boolean) => {
    if (!project) return;
    const ctrl = new AbortController();
    abort.current = ctrl;
    let current = project;
    const todo = current.pages.filter((p) => !onlyNew || p.status !== 'done');
    let errors = 0;
    try {
      for (const [i, page] of todo.entries()) {
        if (ctrl.signal.aborted) break;
        setProgress({ done: i, total: todo.length, label: tr('Страница {0} / {1}', i + 1, todo.length) });
        current = { ...current, pages: current.pages.map((p) => (p.id === page.id ? { ...p, status: 'working' as const } : p)) };
        setProject(current);
        try {
          const r = await translateProjectPage(store, platform.service, platform.backend, current, page, { signal: ctrl.signal });
          current = r.project;
        } catch (e) {
          const err = toAppError(e);
          if (err.code === 'CANCELLED') break;
          errors++;
          current = await store.save({ ...current, pages: current.pages.map((p) => (p.id === page.id ? { ...p, status: 'error' as const, error: err.toJSON() } : p)) });
          if (err.code === 'INVALID_API_KEY' || err.code === 'NOT_CONFIGURED' || err.code === 'PRIVACY_VIOLATION') throw err;
        }
        setProject(current);
      }
    } finally {
      abort.current = null;
      setProgress(null);
      setProject(current.pages.some((p) => p.status === 'working') ? await store.save({ ...current, pages: current.pages.map((p) => (p.status === 'working' ? { ...p, status: 'new' as const } : p)) }) : current);
      reload();
    }
    toast(errors ? tr('Готово, с ошибками: {0}', errors) : tr('Глава переведена'));
  });

  const doExport = useAction(async () => {
    if (!project) return;
    const pages: ExportPage[] = [];
    for (const p of project.pages) {
      const a = await store.assets(project.id, p.id);
      if (!a) continue;
      const tiles = a.rendered ?? [{ y: 0, h: p.height ?? 0, bytes: a.original.bytes }];
      pages.push({ name: p.name, width: p.width ?? p.result?.width ?? 0, height: p.height ?? p.result?.height ?? 0, tiles });
    }
    const onP = (d: number, t: number) => setProgress({ done: d, total: t, label: tr('Экспорт {0} / {1}', d, t) });
    try {
      if (exportFmt === 'pdf') await platform.saveFile(`${project.title}.pdf`, await exportPdf(platform.backend, pages, onP, settings.exportPageLength), 'application/pdf');
      else if (exportFmt === 'cbz') await platform.saveFile(`${project.title}.cbz`, await exportCbz(platform.backend, pages, project.title, onP, settings.exportPageLength), 'application/vnd.comicbook+zip');
      else if (exportFmt === 'epub') await platform.saveFile(`${project.title}.epub`, await exportEpub(platform.backend, pages, project.title, settings.targetLang, onP, settings.exportPageLength), 'application/epub+zip');
      else {
        const mime: ImageMime = exportFmt === 'zip-jpg' ? 'image/jpeg' : exportFmt === 'zip-webp' ? 'image/webp' : 'image/png';
        await platform.saveFile(`${project.title}.zip`, await exportZip(platform.backend, pages, mime, onP), 'application/zip');
      }
    } finally {
      setProgress(null);
    }
  });

  const saveProjectFile = useAction(async () => {
    if (!project) return;
    await platform.saveFile(`${project.title}.aitproj`, await store.exportProject(project), 'application/zip');
  });

  if (editing && project) {
    const fresh = project.pages.find((p) => p.id === editing.id) ?? editing;
    return <ProjectPageEditor store={store} project={project} page={fresh} settings={settings} onClose={() => setEditing(null)} onSaved={(p) => setProject(p)} />;
  }

  if (!project) {
    return (
      <div>
        <div className="ait-panel">
          <h2>{tr('Новый проект')}</h2>
          <DropZone onFiles={(f) => void create.run(f)} label={tr('Перетащите страницы главы сюда')} />
          {progress ? <div style={{ marginTop: 12 }}><Progress value={progress.done / Math.max(1, progress.total)} label={progress.label} /></div> : null}
          <ErrorBox error={create.error} />
          <div style={{ marginTop: 12 }}>
            <label className="ait-btn">
              
              {tr('Открыть файл проекта (.aitproj)')}
              <input type="file" hidden accept=".aitproj,.zip" onChange={(e) => e.target.files?.[0] && void importProject.run(e.target.files[0])} />
            </label>
          </div>
          <ErrorBox error={importProject.error} />
        </div>
        <div className="ait-panel">
          <h2>{tr('Проекты')}</h2>
          {projects.length === 0 ? <p className="ait-muted">{tr('Пока нет проектов. Добавьте страницы, чтобы начать.')}</p> : null}
          <table className="ait-table">
            <tbody>
              {projects.map((p) => (
                <tr key={p.id}>
                  <td><button className="ait-btn ghost" onClick={() => setProject(p)}>{p.title}</button></td>
                  <td className="ait-muted">{p.pages.filter((x) => x.status === 'done').length} / {p.pages.length} {' '}{tr('стр.')}</td>
                  <td className="ait-muted">{new Date(p.updatedAt).toLocaleString(uiLocale())}</td>
                  <td style={{ width: 1 }}>
                    <button className="ait-btn small ghost danger" onClick={async () => { if (confirm(tr('Удалить проект «{0}»?', p.title))) { await store.remove(p); reload(); } }}>{tr('Удалить')}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  const done = project.pages.filter((p) => p.status === 'done').length;
  const busy = translateAll.busy || doExport.busy;

  return (
    <div>
      <div className="ait-panel">
        <div className="ait-row" style={{ alignItems: 'center' }}>
          <button className="ait-btn small ghost" style={{ flex: '0 0 auto' }} onClick={() => { setProject(null); reload(); }}>{tr('← Проекты')}</button>
          <input className="ait-input" style={{ flex: '1 1 240px', fontWeight: 600 }} value={project.title} onChange={(e) => setProject({ ...project, title: e.target.value })} onBlur={() => void store.save(project)} aria-label={tr('Название проекта')} />
          <span className="ait-muted" style={{ flex: '0 0 auto' }}>{done} {' '}{tr('из')}{' '}{project.pages.length} {' '}{tr('готово')}</span>
        </div>
        <div className="ait-row" style={{ marginTop: 14, alignItems: 'center' }}>
          {translateAll.busy ? (
            <button className="ait-btn" style={{ flex: '0 0 auto' }} onClick={() => abort.current?.abort()}>{tr('Остановить')}</button>
          ) : (
            <button className="ait-bubble-btn" style={{ flex: '0 0 auto' }} onClick={() => void translateAll.run(true)} disabled={busy || !project.pages.length}>
              {done ? tr('Перевести оставшиеся') : tr('Перевести всё')}
            </button>
          )}
          {done && !busy ? <button className="ait-btn" style={{ flex: '0 0 auto' }} onClick={() => void translateAll.run(false)}>{tr('Перевести заново')}</button> : null}
          <span style={{ flex: 1 }} />
          <select className="ait-select" style={{ flex: '0 0 170px' }} value={exportFmt} onChange={(e) => setExportFmt(e.target.value as typeof exportFmt)} aria-label={tr('Формат экспорта')}>
            <option value="zip-png">{tr('ZIP с PNG')}</option>
            <option value="zip-jpg">{tr('ZIP с JPG')}</option>
            <option value="zip-webp">{tr('ZIP с WEBP')}</option>
            <option value="pdf">PDF</option>
            <option value="cbz">{tr('CBZ (читалки комиксов)')}</option>
            <option value="epub">{tr('EPUB (книжные приложения)')}</option>
          </select>
          <button className="ait-btn" style={{ flex: '0 0 auto' }} onClick={() => void doExport.run()} disabled={busy || !done}>{tr('Скачать')}</button>
          <button className="ait-btn" style={{ flex: '0 0 auto' }} onClick={() => void saveProjectFile.run()} disabled={busy}>{tr('Сохранить проект')}</button>
        </div>
        {progress ? <div style={{ marginTop: 14 }}><Progress value={progress.done / Math.max(1, progress.total)} label={progress.label} /></div> : null}
        <ErrorBox error={translateAll.error || doExport.error || saveProjectFile.error || addPages.error} />
      </div>

      <div className="ait-seg" role="tablist" style={{ margin: '4px 0 12px' }}>
        <button aria-pressed={tab === 'pages'} onClick={() => setTab('pages')}>{tr('Страницы')}</button>
        <button aria-pressed={tab === 'glossary'} onClick={() => setTab('glossary')}>{tr('Глоссарий')}</button>
        <button aria-pressed={tab === 'context'} onClick={() => setTab('context')}>{tr('Контекст')}</button>
        {scanlator ? <button aria-pressed={tab === 'replace'} onClick={() => setTab('replace')}>{tr('Замена и стиль')}</button> : null}
      </div>

      {tab === 'pages' ? (
        <>
          <div className="ait-pages">
            {project.pages.map((p) => (
              <div key={p.id} className={`ait-page ${selection.has(p.id) ? 'selected' : ''}`} onClick={() => (p.status === 'done' ? setEditing(p) : undefined)} title={p.error ? errorMessage(p.error) : p.name}>
                {scanlator ? (
                  <input type="checkbox" aria-label={tr('Выбрать {0}', p.name)} checked={selection.has(p.id)} onClick={(e) => e.stopPropagation()} onChange={(e) => { const s = new Set(selection); if (e.target.checked) s.add(p.id); else s.delete(p.id); setSelection(s); }} />
                ) : null}
                <Thumb store={store} project={project} page={p} />
                <div className="meta">
                  <span>{p.index + 1}. {p.name}</span>
                  <span className={`ait-badge ${p.status === 'done' ? 'ok' : p.status === 'error' ? 'err' : ''}`}>{STATUS[p.status]}</span>
                </div>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 16 }}>
            <DropZone onFiles={(f) => void addPages.run(f)} label={tr('Добавить страницы в проект')} />
          </div>
        </>
      ) : null}
      {tab === 'glossary' ? <GlossaryEditor title={tr('Глоссарий проекта')} entries={project.glossary} onChange={(glossary) => { const p = { ...project, glossary }; setProject(p); void store.save(p); }} /> : null}
      {tab === 'context' ? <ContextEditor context={project.context} onChange={(context) => { const p = { ...project, context }; setProject(p); void store.save(p); }} /> : null}
      {tab === 'replace' ? <ReplaceAndStyle store={store} project={project} settings={settings} selection={selection} onChange={setProject} /> : null}
    </div>
  );
}

function ReplaceAndStyle({ store, project, settings, selection, onChange }: { store: ProjectStore; project: Project; settings: AppSettings; selection: Set<string>; onChange: (p: Project) => void }) {
  const platform = usePlatform();
  const [find, setFind] = useState('');
  const [repl, setRepl] = useState('');
  const [whole, setWhole] = useState(true);
  const [cs, setCs] = useState(false);
  const [style, setStyle] = useState<Partial<TextStyle>>({});

  const replace = useAction(async () => {
    let current = project;
    let total = 0;
    for (const page of project.pages) {
      if (!page.result) continue;
      let count = 0;
      const blocks = page.result.blocks.map((b) => {
        const r = replaceInText(b.translatedText, find, repl, { wholeWord: whole, caseSensitive: cs });
        count += r.count;
        return r.count ? { ...b, translatedText: r.text, edited: true } : b;
      });
      if (count) {
        total += count;
        current = await rerenderProjectPage(store, platform.backend, settings, current, page, { ...page.result, blocks });
      }
    }
    onChange(current);
    toast(tr('Заменено: {0}', total));
  });

  const applyStyle = useAction(async () => {
    const targets = project.pages.filter((p) => p.result && (selection.size === 0 || selection.has(p.id)));
    let current = project;
    for (const page of targets) {
      const blocks = page.result!.blocks.map((b) => ({ ...b, style: { ...(b.style ?? {}), ...style } }));
      current = await rerenderProjectPage(store, platform.backend, settings, current, page, { ...page.result!, blocks });
    }
    onChange(current);
    toast(tr('Стиль применён к страницам: {0}', targets.length));
  });

  return (
    <div>
      <div className="ait-panel">
        <h2>{tr('Найти и заменить во всех страницах')}</h2>
        <div className="ait-row">
          <Field label={tr('Найти')}><input className="ait-input" value={find} onChange={(e) => setFind(e.target.value)} placeholder="Tanaka" /></Field>
          <Field label={tr('Заменить на')}><input className="ait-input" value={repl} onChange={(e) => setRepl(e.target.value)} placeholder={tr('Танака')} /></Field>
        </div>
        <div className="ait-row" style={{ marginTop: 10, alignItems: 'center' }}>
          <Switch checked={whole} onChange={setWhole} label={tr('Слово целиком')} />
          <Switch checked={cs} onChange={setCs} label={tr('С учётом регистра')} />
          <button className="ait-btn" style={{ flex: '0 0 auto' }} disabled={!find || replace.busy} onClick={() => void replace.run()}>{tr('Заменить везде')}</button>
        </div>
        <ErrorBox error={replace.error} />
      </div>
      <div className="ait-panel">
        <h2>{tr('Стиль для')}{' '}{selection.size ? tr('выбранных страниц ({0})', selection.size) : tr('всех страниц')}</h2>
        <div className="ait-grid2">
          <Field label={tr('Шрифт')}>
            <select className="ait-select" value={style.fontFamily ?? ''} onChange={(e) => setStyle({ ...style, fontFamily: e.target.value || undefined })}>
              <option value="">{tr('Не менять')}</option>
              <option value='"AIT Lettering", sans-serif'>AIT Lettering</option>
              <option value='"AIT Comic", sans-serif'>AIT Comic</option>
              <option value='"AIT Narration", sans-serif'>AIT Narration</option>
              <option value='"AIT SFX", sans-serif'>AIT SFX</option>
              <option value="Arial, sans-serif">Arial</option>
            </select>
          </Field>
          <Field label={tr('Кегль (пусто — авто)')}><input className="ait-input" type="number" min={6} max={120} value={style.fontSize ?? ''} onChange={(e) => setStyle({ ...style, fontSize: e.target.value ? Number(e.target.value) : undefined })} /></Field>
          <Field label={tr('Цвет')}><input type="color" value={style.color ?? '#111111'} onChange={(e) => setStyle({ ...style, color: e.target.value })} /></Field>
          <Field label={tr('Обводка, px')}><input className="ait-input" type="number" min={0} max={20} value={style.strokeWidth ?? ''} onChange={(e) => setStyle({ ...style, strokeWidth: e.target.value === '' ? undefined : Number(e.target.value), strokeColor: style.strokeColor ?? '#ffffff' })} /></Field>
          <Field label={tr('Выравнивание')}>
            <select className="ait-select" value={style.alignment ?? ''} onChange={(e) => setStyle({ ...style, alignment: (e.target.value || undefined) as TextStyle['alignment'] | undefined })}>
              <option value="">{tr('Не менять')}</option>
              <option value="center">{tr('По центру')}</option>
              <option value="left">{tr('Влево')}</option>
              <option value="right">{tr('Вправо')}</option>
            </select>
          </Field>
        </div>
        <button className="ait-btn" style={{ marginTop: 12 }} disabled={applyStyle.busy || !Object.keys(style).length} onClick={() => void applyStyle.run()}>{tr('Применить')}</button>
        <ErrorBox error={applyStyle.error} />
      </div>
    </div>
  );
}
