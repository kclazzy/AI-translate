import {
  clampBox,
  exportProjectZip,
  importProjectZip,
  mergeContext,
  newProject,
  pipelineConfigFromSettings,
  renderOutput,
  runPipeline,
  shortId,
  styleDefaultsFor,
  tilesToImage,
  toAppError,
  TiledImage,
  type AppSettings,
  type Box,
  type TextBlock,
  type IdbStore,
  type ImageBackend,
  type PageAssets,
  type PageResult,
  type Project,
  type ProjectPage,
  type StageEvent,
  type TranslateService,
} from '@ait/core';
import type { ImportedImage } from './files';
import { tr } from '@ait/core/i18n';

export interface StoredAssets extends PageAssets {
  rendered?: { y: number; h: number; bytes: Uint8Array }[];
}

/** One change of a project at a time, across every store and panel of this page (see ProjectStore.update). */
const projectLocks = new Map<string, Promise<unknown>>();

/** Projects live in IndexedDB: project JSON in 'projects', page images in 'assets'. */
export class ProjectStore {
  constructor(private db: IdbStore) {}

  /**
   * Change a project from its latest stored copy, one change at a time: a long «Перевести всё» never
   * writes back an old copy over edits, pages added or a glossary changed meanwhile.
   */
  async update(id: string, fn: (fresh: Project) => Project | Promise<Project>): Promise<Project> {
    const prev = projectLocks.get(id) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(async () => {
      const fresh = await this.get(id);
      if (!fresh) throw toAppError(new Error(tr('Проект не найден')));
      return this.save(await fn(fresh));
    });
    projectLocks.set(id, run);
    try {
      return await run;
    } finally {
      if (projectLocks.get(id) === run) projectLocks.delete(id);
    }
  }

  /** Change one page of a project (see update). */
  updatePage(id: string, pageId: string, fn: (page: ProjectPage) => ProjectPage): Promise<Project> {
    return this.update(id, (p) => ({ ...p, pages: p.pages.map((x) => (x.id === pageId ? fn(x) : x)) }));
  }

  async list(): Promise<Project[]> {
    const all = await this.db.entries<Project>('projects');
    return all.map(([, p]) => p).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  get(id: string): Promise<Project | undefined> {
    return this.db.get<Project>('projects', id);
  }

  async save(p: Project): Promise<Project> {
    const next = { ...p, updatedAt: new Date().toISOString() };
    await this.db.put('projects', p.id, next);
    return next;
  }

  async remove(p: Project): Promise<void> {
    for (const page of p.pages) {
      await this.db.delete('assets', assetKey(p.id, page.id));
      await this.db.delete('assets', thumbKey(p.id, page.id));
    }
    await this.db.delete('projects', p.id);
  }

  async removePage(p: Project, pageId: string): Promise<void> {
    await this.db.delete('assets', assetKey(p.id, pageId));
    await this.db.delete('assets', thumbKey(p.id, pageId));
  }

  /**
   * A small picture of the page for the page grid and the filmstrip (≈ 160 px, JPEG): read alone,
   * never the page's full pictures. Made once from the rendered (or original) picture and dropped
   * whenever the page's pictures change (putAssets).
   */
  async thumb(projectId: string, pageId: string, backend: ImageBackend): Promise<Uint8Array | undefined> {
    const known = await this.db.get<{ bytes: Uint8Array }>('assets', thumbKey(projectId, pageId));
    if (known) return known.bytes;
    const a = await this.assets(projectId, pageId);
    if (!a) return undefined;
    const src = a.rendered?.[0] ? { bytes: a.rendered[0].bytes, mime: undefined } : { bytes: a.original.bytes, mime: a.original.mime };
    try {
      const d = await backend.decode(src.bytes, src.mime);
      const w = Math.min(THUMB_WIDTH, d.width);
      // The top of a tall strip: a thumbnail of a whole webtoon would be a thin line.
      const h = Math.max(1, Math.round(Math.min(d.height, d.width * 1.6) * (w / d.width)));
      const c = backend.createCanvas(w, h);
      const ctx = c.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(d.source, 0, 0, d.width, Math.min(d.height, d.width * 1.6), 0, 0, w, h);
      d.close?.();
      const bytes = await backend.encode(c, 'image/jpeg', 0.8);
      await this.db.put('assets', thumbKey(projectId, pageId), { bytes });
      return bytes;
    } catch {
      return undefined;
    }
  }

  assets(projectId: string, pageId: string): Promise<StoredAssets | undefined> {
    return this.db.get<StoredAssets>('assets', assetKey(projectId, pageId));
  }

  async putAssets(projectId: string, pageId: string, a: StoredAssets): Promise<void> {
    await this.db.put('assets', assetKey(projectId, pageId), a);
    await this.db.delete('assets', thumbKey(projectId, pageId));
  }

  async create(title: string, settings: AppSettings, images: ImportedImage[], backend: ImageBackend): Promise<Project> {
    const p = newProject(shortId('p'), title, { sourceLang: settings.sourceLang, targetLang: settings.targetLang, profileId: settings.activeProfileId });
    p.glossary = [];
    await this.addPages(p, images, backend);
    return this.save(p);
  }

  async addPages(p: Project, images: ImportedImage[], backend: ImageBackend): Promise<void> {
    for (const img of images) {
      const id = shortId('pg');
      let width: number | undefined;
      let height: number | undefined;
      try {
        const d = await backend.decode(img.bytes, img.mime);
        width = d.width;
        height = d.height;
        d.close?.();
      } catch {
        /* undecodable pages are kept and fail visibly when translated */
      }
      p.pages.push({ id, name: img.name, index: p.pages.length, mime: img.mime, width, height, status: 'new' });
      await this.putAssets(p.id, id, { original: { bytes: img.bytes, mime: img.mime } });
    }
  }

  async exportProject(p: Project): Promise<Uint8Array> {
    return exportProjectZip(p, (pageId) => this.assets(p.id, pageId));
  }

  async importProject(bytes: Uint8Array): Promise<Project> {
    const { project, assets } = await importProjectZip(bytes);
    const existing = await this.get(project.id);
    const p = existing ? { ...project, id: shortId('p'), title: tr('{0} (копия)', project.title) } : project;
    for (const [pageId, a] of assets) await this.putAssets(p.id, pageId, a);
    return this.save(p);
  }
}

export function assetKey(projectId: string, pageId: string): string {
  return `${projectId}/${pageId}`;
}

const THUMB_WIDTH = 160;
export function thumbKey(projectId: string, pageId: string): string {
  return `${projectId}/${pageId}#thumb`;
}

/**
 * Translate one project page with the project's own context and glossary.
 * Pages of a chapter are translated in order so the context grows page by page.
 */
export async function translateProjectPage(
  store: ProjectStore,
  service: TranslateService,
  backend: ImageBackend,
  project: Project,
  page: ProjectPage,
  opts: { signal?: AbortSignal; onStage?: (e: StageEvent) => void } = {},
): Promise<{ project: Project; result: PageResult }> {
  const assets = await store.assets(project.id, page.id);
  if (!assets) throw toAppError(new Error('Page image is missing'));
  const { settings } = await service.config();
  const config = pipelineConfigFromSettings({ ...settings, sourceLang: project.settings.sourceLang, targetLang: project.settings.targetLang, activeProfileId: project.settings.profileId, glossary: [...settings.glossary, ...project.glossary] });
  const out = await runPipeline({ bytes: assets.original.bytes, mime: assets.original.mime, config, context: project.context, signal: opts.signal, onStage: opts.onStage }, { backend });
  const rendered = await renderOutput(backend, out, styleDefaultsFor(config, settings.fonts));
  const cleaned = await Promise.all(out.cleaned.tiles.map(async (t) => ({ y: t.y, h: t.h, bytes: await backend.encode(t.canvas, 'image/png') })));
  await store.putAssets(project.id, page.id, { ...assets, cleaned, rendered: rendered.tiles });
  await service.recordUsage(rendered.page.usage);
  // Into the latest copy of the project: this page's result, its contribution to the context.
  const next = await store.update(project.id, (fresh) => ({
    ...fresh,
    pages: fresh.pages.map((p) => (p.id === page.id ? { ...p, status: 'done' as const, error: undefined, result: rendered.page, width: rendered.page.width, height: rendered.page.height } : p)),
    context: out.contextUpdate && fresh.context ? mergeContext(fresh.context, out.contextUpdate) : out.context ?? fresh.context,
  }));
  return { project: next, result: rendered.page };
}

/** Re-render a page after edits (text, styles or cleaned layer). */
export async function rerenderProjectPage(store: ProjectStore, backend: ImageBackend, settings: AppSettings, project: Project, page: ProjectPage, result: PageResult, cleaned?: TiledImage): Promise<Project> {
  const assets = await store.assets(project.id, page.id);
  if (!assets) return project;
  const image = cleaned ?? (await tilesToImage(backend, result.width, result.height, assets.cleaned ?? []));
  const rendered = await renderOutput(backend, { page: result, cleaned: image }, styleDefaultsFor({ targetLang: result.targetLang, sfxStyle: settings.sfxStyle }, settings.fonts));
  const cleanedTiles = cleaned ? await Promise.all(cleaned.tiles.map(async (t) => ({ y: t.y, h: t.h, bytes: await backend.encode(t.canvas, 'image/png') }))) : assets.cleaned;
  await store.putAssets(project.id, page.id, { ...assets, cleaned: cleanedTiles, rendered: rendered.tiles });
  return store.updatePage(project.id, page.id, (p) => ({ ...p, result: rendered.page, status: 'done' as const }));
}

/** Move a block's coordinates by (−dx, −dy): into a cropped page. */
function moveBlock(b: TextBlock, dx: number, dy: number): TextBlock {
  const mv = (x: Box): Box => [x[0] - dx, x[1] - dy, x[2], x[3]];
  const out: TextBlock = { ...b, bbox: mv(b.bbox), polygon: b.polygon.map(([x, y]) => [x - dx, y - dy] as [number, number]) };
  if (b.textBox) out.textBox = mv(b.textBox);
  if (b.bubble) out.bubble = { ...b.bubble, box: mv(b.bubble.box), safeArea: mv(b.bubble.safeArea), rows: b.bubble.rows ? { ...b.bubble.rows, y: b.bubble.rows.y - dy, l: b.bubble.rows.l.map((v) => v - dx), r: b.bubble.rows.r.map((v) => v - dx) } : undefined };
  return out;
}

function cropImage(backend: ImageBackend, img: TiledImage, [x, y, w, h]: Box): TiledImage {
  const out = new TiledImage(backend, w, h);
  for (const t of out.tiles) img.drawRegion(t.canvas.getContext('2d'), x, y + t.y, w, t.h, w, t.h);
  return out;
}

/**
 * «Обрезать»: cut a project page to `rect` — the original, the cleaned picture and the texts move
 * with it (texts outside the frame are dropped), then the page is drawn again.
 */
export async function cropProjectPage(store: ProjectStore, backend: ImageBackend, settings: AppSettings, project: Project, page: ProjectPage, result: PageResult, original: TiledImage, cleaned: TiledImage, rect: Box): Promise<Project> {
  const [x, y, w, h] = clampBox(rect.map(Math.round) as Box, result.width, result.height);
  if (w < 16 || h < 16) return project;
  const assets = await store.assets(project.id, page.id);
  if (!assets) return project;
  const o = cropImage(backend, original, [x, y, w, h]);
  const c = backend.createCanvas(w, h);
  o.drawRegion(c.getContext('2d'), 0, 0, w, h, w, h);
  const originalBytes = await backend.encode(c, 'image/png');
  const cl = cropImage(backend, cleaned, [x, y, w, h]);
  const inside = (b: TextBlock) => {
    const box = b.bubble?.box ?? b.bbox;
    const cx = box[0] + box[2] / 2;
    const cy = box[1] + box[3] / 2;
    return cx >= x && cx < x + w && cy >= y && cy < y + h;
  };
  const next: PageResult = { ...result, width: w, height: h, blocks: result.blocks.filter(inside).map((b) => moveBlock(b, x, y)) };
  await store.putAssets(project.id, page.id, { ...assets, original: { bytes: originalBytes, mime: 'image/png' } });
  const fresh = (await store.get(project.id)) ?? project;
  return rerenderProjectPage(store, backend, settings, fresh, page, next, cl);
}

export async function loadOriginalImage(backend: ImageBackend, assets: StoredAssets): Promise<TiledImage> {
  return TiledImage.fromBytes(backend, assets.original.bytes, assets.original.mime);
}
