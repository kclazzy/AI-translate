import {
  exportProjectZip,
  importProjectZip,
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

/** Projects live in IndexedDB: project JSON in 'projects', page images in 'assets'. */
export class ProjectStore {
  constructor(private db: IdbStore) {}

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
    for (const page of p.pages) await this.db.delete('assets', assetKey(p.id, page.id));
    await this.db.delete('projects', p.id);
  }

  async removePage(p: Project, pageId: string): Promise<void> {
    await this.db.delete('assets', assetKey(p.id, pageId));
  }

  assets(projectId: string, pageId: string): Promise<StoredAssets | undefined> {
    return this.db.get<StoredAssets>('assets', assetKey(projectId, pageId));
  }

  async putAssets(projectId: string, pageId: string, a: StoredAssets): Promise<void> {
    await this.db.put('assets', assetKey(projectId, pageId), a);
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
  const pages = project.pages.map((p) => (p.id === page.id ? { ...p, status: 'done' as const, error: undefined, result: rendered.page, width: rendered.page.width, height: rendered.page.height } : p));
  const next = await store.save({ ...project, pages, context: out.context ?? project.context });
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
  const pages = project.pages.map((p) => (p.id === page.id ? { ...p, result: rendered.page, status: 'done' as const } : p));
  return store.save({ ...project, pages });
}

export async function loadOriginalImage(backend: ImageBackend, assets: StoredAssets): Promise<TiledImage> {
  return TiledImage.fromBytes(backend, assets.original.bytes, assets.original.mime);
}
