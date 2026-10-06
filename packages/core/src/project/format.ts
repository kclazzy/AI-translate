import JSZip from 'jszip';
import { AppError, type SerializedError } from '../errors';
import { emptyContext, type TranslationContext } from '../translate/context';
import type { GlossaryEntry } from '../translate/glossary';
import type { PageResult } from '../types';
import { sniffImageMime } from '../util/bytes';

export const PROJECT_VERSION = 1;
export const PROJECT_EXTENSION = '.aitproj';

export type PageStatus = 'new' | 'queued' | 'working' | 'done' | 'error';

export interface ProjectPage {
  id: string;
  name: string;
  index: number;
  mime: string;
  width?: number;
  height?: number;
  status: PageStatus;
  error?: SerializedError;
  result?: PageResult;
}

export interface Project {
  projectVersion: 1;
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  sourceUrl?: string;
  settings: { sourceLang: string; targetLang: string; profileId: string };
  pages: ProjectPage[];
  glossary: GlossaryEntry[];
  context: TranslationContext;
}

export interface PageAssets {
  original: { bytes: Uint8Array; mime: string };
  cleaned?: { y: number; h: number; bytes: Uint8Array }[];
}

export function newProject(id: string, title: string, settings: Project['settings']): Project {
  const now = new Date().toISOString();
  return { projectVersion: PROJECT_VERSION, id, title, createdAt: now, updatedAt: now, settings, pages: [], glossary: [], context: emptyContext(id, title) };
}

export const ARCHIVE_LIMITS = {
  maxEntries: 3000,
  maxTotalBytes: 1_500_000_000,
  maxEntryBytes: 200_000_000,
  maxRatio: 200,
};

interface ZipEntryInternal {
  _data?: { uncompressedSize?: number; compressedSize?: number };
}

/** Guard against zip bombs and path tricks before anything is decompressed. */
export function checkArchive(zip: JSZip): JSZip.JSZipObject[] {
  const files = Object.values(zip.files).filter((f) => !f.dir);
  if (files.length > ARCHIVE_LIMITS.maxEntries) throw new AppError('IMAGE_TOO_LARGE', { retryable: false, detail: `Archive has ${files.length} files` });
  let total = 0;
  for (const f of files) {
    const meta = (f as unknown as ZipEntryInternal)._data;
    const size = meta?.uncompressedSize ?? 0;
    const comp = meta?.compressedSize ?? 0;
    if (size > ARCHIVE_LIMITS.maxEntryBytes) throw new AppError('IMAGE_TOO_LARGE', { retryable: false, detail: `${f.name} is too large` });
    if (comp > 0 && size / comp > ARCHIVE_LIMITS.maxRatio && size > 10_000_000) throw new AppError('IMAGE_TOO_LARGE', { retryable: false, detail: `${f.name} has a suspicious compression ratio` });
    total += size;
    const original = (f as unknown as { unsafeOriginalName?: string }).unsafeOriginalName ?? f.name;
    if (original.includes('..') || original.startsWith('/') || original.includes('\\') || /^[a-z]:/i.test(original)) throw new AppError('UNSUPPORTED_FORMAT', { retryable: false, detail: `Unsafe path ${f.name}` });
  }
  if (total > ARCHIVE_LIMITS.maxTotalBytes) throw new AppError('IMAGE_TOO_LARGE', { retryable: false, detail: 'Archive is too large when unpacked' });
  return files;
}

/** Natural sort so page2 comes before page10. */
export function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

/** Read the images of a ZIP/CBZ chapter in page order. */
export async function readArchiveImages(bytes: Uint8Array): Promise<{ name: string; bytes: Uint8Array; mime: string }[]> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw new AppError('UNSUPPORTED_FORMAT', { retryable: false, detail: 'Not a valid ZIP archive' });
  }
  const files = checkArchive(zip).filter((f) => /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(f.name) && !f.name.startsWith('__MACOSX'));
  files.sort((a, b) => naturalCompare(a.name, b.name));
  // EPUB: keep the reading order of the book (spine), not the file names.
  const order = await epubImageOrder(zip);
  if (order.length) {
    const rank = new Map(order.map((n, i) => [n, i]));
    files.sort((a, b) => (rank.get(a.name) ?? 1e9) - (rank.get(b.name) ?? 1e9) || naturalCompare(a.name, b.name));
  }
  const out: { name: string; bytes: Uint8Array; mime: string }[] = [];
  for (const f of files) {
    const data = await f.async('uint8array');
    const mime = sniffImageMime(data);
    if (!mime) continue;
    out.push({ name: f.name.split('/').pop() ?? f.name, bytes: data, mime });
  }
  return out;
}

/** Image paths of an EPUB in reading order (spine → pages → <img>/<image>), or [] if not an EPUB. */
export async function epubImageOrder(zip: JSZip): Promise<string[]> {
  const container = zip.file('META-INF/container.xml');
  if (!container) return [];
  const rootPath = /full-path="([^"]+)"/.exec(await container.async('string'))?.[1];
  const opfFile = rootPath ? zip.file(rootPath) : null;
  if (!opfFile) return [];
  const opf = await opfFile.async('string');
  const base = rootPath!.includes('/') ? rootPath!.slice(0, rootPath!.lastIndexOf('/') + 1) : '';
  const resolve = (dir: string, href: string) => {
    const parts = (dir + decodeURIComponent(href.split('#')[0])).split('/');
    const out: string[] = [];
    for (const p of parts) {
      if (p === '..') out.pop();
      else if (p && p !== '.') out.push(p);
    }
    return out.join('/');
  };
  const items = new Map<string, string>();
  for (const m of opf.matchAll(/<item\b[^>]*>/g)) {
    const id = /\bid="([^"]+)"/.exec(m[0])?.[1];
    const href = /\bhref="([^"]+)"/.exec(m[0])?.[1];
    if (id && href) items.set(id, resolve(base, href));
  }
  const order: string[] = [];
  for (const m of opf.matchAll(/<itemref\b[^>]*idref="([^"]+)"/g)) {
    const path = items.get(m[1]);
    if (!path) continue;
    if (/\.(png|jpe?g|webp|gif|avif)$/i.test(path)) {
      order.push(path);
      continue;
    }
    const doc = zip.file(path);
    if (!doc) continue;
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
    const html = await doc.async('string');
    for (const im of html.matchAll(/<(?:img|image)\b[^>]*?(?:src|xlink:href|href)="([^"]+)"/g)) order.push(resolve(dir, im[1]));
  }
  return order;
}

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/bmp': 'bmp', 'image/avif': 'avif' };

export async function exportProjectZip(project: Project, getAssets: (pageId: string) => Promise<PageAssets | undefined>): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file('project.json', JSON.stringify({ ...project, updatedAt: new Date().toISOString() }, null, 2));
  for (const p of project.pages) {
    const a = await getAssets(p.id);
    if (!a) continue;
    zip.file(`pages/${p.id}/original.${EXT[a.original.mime] ?? 'bin'}`, a.original.bytes);
    for (const t of a.cleaned ?? []) zip.file(`pages/${p.id}/cleaned-${t.y}-${t.h}.png`, t.bytes);
  }
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 3 } });
}

export function validateProject(raw: unknown): Project {
  if (!raw || typeof raw !== 'object') throw new AppError('UNSUPPORTED_FORMAT', { retryable: false, detail: 'project.json is not an object' });
  const p = raw as Partial<Project>;
  if (p.projectVersion !== 1) throw new AppError('UNSUPPORTED_FORMAT', { retryable: false, detail: `Unsupported project version ${p.projectVersion}` });
  if (typeof p.id !== 'string' || !Array.isArray(p.pages)) throw new AppError('UNSUPPORTED_FORMAT', { retryable: false, detail: 'Project is missing id or pages' });
  return {
    projectVersion: 1,
    id: p.id,
    title: typeof p.title === 'string' ? p.title : 'Untitled',
    createdAt: p.createdAt ?? new Date().toISOString(),
    updatedAt: p.updatedAt ?? new Date().toISOString(),
    sourceUrl: p.sourceUrl,
    settings: { sourceLang: p.settings?.sourceLang ?? 'auto', targetLang: p.settings?.targetLang ?? 'ru', profileId: p.settings?.profileId ?? 'natural' },
    pages: p.pages.filter((pg) => pg && typeof pg.id === 'string').map((pg, i) => ({ ...pg, index: typeof pg.index === 'number' ? pg.index : i, status: pg.status ?? 'new' })) as ProjectPage[],
    glossary: Array.isArray(p.glossary) ? p.glossary : [],
    context: p.context ?? emptyContext(p.id, p.title ?? ''),
  };
}

export async function importProjectZip(bytes: Uint8Array): Promise<{ project: Project; assets: Map<string, PageAssets> }> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw new AppError('UNSUPPORTED_FORMAT', { retryable: false, detail: 'Not a project file' });
  }
  const files = checkArchive(zip);
  const pj = zip.file('project.json');
  if (!pj) throw new AppError('UNSUPPORTED_FORMAT', { retryable: false, detail: 'project.json missing' });
  const project = validateProject(JSON.parse(await pj.async('string')));
  const assets = new Map<string, PageAssets>();
  for (const f of files) {
    const m = /^pages\/([^/]+)\/(original\.\w+|cleaned-(\d+)-(\d+)\.png)$/.exec(f.name);
    if (!m) continue;
    const pageId = m[1];
    const data = await f.async('uint8array');
    const entry = assets.get(pageId) ?? ({ original: { bytes: new Uint8Array(), mime: 'image/png' }, cleaned: [] } as PageAssets);
    if (m[2].startsWith('original')) entry.original = { bytes: data, mime: sniffImageMime(data) ?? 'image/png' };
    else entry.cleaned!.push({ y: Number(m[3]), h: Number(m[4]), bytes: data });
    assets.set(pageId, entry);
  }
  for (const a of assets.values()) a.cleaned?.sort((x, y) => x.y - y.y);
  return { project, assets };
}
