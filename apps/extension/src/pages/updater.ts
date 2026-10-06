import JSZip from 'jszip';
import { downloadWithProgress, pickAsset, releaseAssets, type UpdateInfo } from '@ait/core';
import { db } from '../shared/store';

/**
 * In-app update for an unpacked extension (how this project is installed):
 * download the release zip, write the new files over the extension folder the user picked
 * once (File System Access API, permission remembered by the browser) and reload.
 */

type DirHandle = FileSystemDirectoryHandle & {
  queryPermission?(d: { mode: 'readwrite' }): Promise<PermissionState>;
  requestPermission?(d: { mode: 'readwrite' }): Promise<PermissionState>;
  values(): AsyncIterable<FileSystemHandle>;
};

const HANDLE_KEY = 'update-dir';
const ZIP_FOLDER = 'extension-chrome';

async function readManifest(dir: FileSystemDirectoryHandle): Promise<{ name?: string; version?: string } | null> {
  try {
    const f = await (await dir.getFileHandle('manifest.json')).getFile();
    return JSON.parse(await f.text()) as { name?: string; version?: string };
  } catch {
    return null;
  }
}

/** Accept the extension folder itself or the unpacked release folder that contains it. */
async function resolveExtensionDir(picked: FileSystemDirectoryHandle): Promise<FileSystemDirectoryHandle> {
  const own = chrome.runtime.getManifest();
  let dir = picked;
  let m = await readManifest(dir);
  if (!m) {
    try {
      dir = await picked.getDirectoryHandle(ZIP_FOLDER);
      m = await readManifest(dir);
    } catch {
      /* not the release folder */
    }
  }
  if (!m || m.name !== own.name) throw new Error(`В этой папке нет расширения «${own.name}». Выберите папку, которую вы указали в chrome://extensions → «Загрузить распакованное» (обычно ${ZIP_FOLDER}).`);
  if (m.version !== own.version) throw new Error(`В выбранной папке версия ${m.version}, а запущена ${own.version}. Похоже, это другая копия. Выберите папку, из которой расширение загружено в chrome://extensions.`);
  return dir;
}

async function ensurePermission(dir: DirHandle): Promise<boolean> {
  if (!dir.queryPermission) return true;
  if ((await dir.queryPermission({ mode: 'readwrite' })) === 'granted') return true;
  return (await dir.requestPermission?.({ mode: 'readwrite' })) === 'granted';
}

async function pickDir(): Promise<FileSystemDirectoryHandle> {
  const picker = (window as unknown as { showDirectoryPicker?: (o: object) => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker;
  if (!picker) throw new Error('Этот браузер не умеет обновлять расширение сам. Скачайте новую версию со страницы релизов.');
  alert('Выберите папку, в которую распаковано расширение (ту, что указана в chrome://extensions). Это нужно один раз: дальше обновления будут ставиться одной кнопкой.');
  return picker({ mode: 'readwrite', id: 'ait-extension' });
}

async function writeFile(root: FileSystemDirectoryHandle, path: string, data: Uint8Array): Promise<void> {
  const parts = path.split('/').filter(Boolean);
  if (parts.some((p) => p === '..' || p === '.')) throw new Error(`Недопустимый путь в архиве: ${path}`);
  let dir = root;
  for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: true });
  const w = await (await dir.getFileHandle(parts[parts.length - 1], { create: true })).createWritable();
  await w.write(data as BufferSource);
  await w.close();
}

/** Remove files that the new version no longer has (old hashed bundles), only inside subfolders. */
async function removeStale(dir: DirHandle, keep: Set<string>, prefix = ''): Promise<void> {
  for await (const h of dir.values()) {
    const path = `${prefix}${h.name}`;
    if (h.kind === 'directory') await removeStale(h as DirHandle, keep, `${path}/`);
    else if (prefix && !keep.has(path)) await dir.removeEntry(h.name).catch(() => undefined);
  }
}

export async function installExtensionUpdate(info: UpdateInfo, progress: (text: string, pct?: number) => void): Promise<void> {
  if (typeof (globalThis as { browser?: unknown }).browser !== 'undefined' && !chrome.offscreen) {
    throw new Error('В Firefox временное дополнение обновляется вручную: скачайте новую версию со страницы релизов.');
  }
  const asset = pickAsset(info, 'desktop') ?? pickAsset({ assets: releaseAssets(info.latest) }, 'desktop');
  if (!asset) throw new Error('Не удалось найти файл новой версии. Скачайте его со страницы релизов.');

  // 1. The extension folder (asked once, then remembered).
  let dir = (await db.get<FileSystemDirectoryHandle>('kv', HANDLE_KEY)) ?? null;
  if (dir && !(await ensurePermission(dir as DirHandle))) dir = null;
  if (dir) {
    try {
      dir = await resolveExtensionDir(dir);
    } catch {
      dir = null;
    }
  }
  if (!dir) {
    dir = await resolveExtensionDir(await pickDir());
    if (!(await ensurePermission(dir as DirHandle))) throw new Error('Нет разрешения на запись в папку расширения.');
    await db.put('kv', HANDLE_KEY, dir);
  }

  // 2. Download and check the archive before touching anything.
  progress(`Скачиваю ${info.latest}…`, 0);
  const bytes = await downloadWithProgress(asset.url, (done, total) => progress(`Скачиваю ${info.latest}: ${(done / 1048576).toFixed(1)}${total ? ` из ${(total / 1048576).toFixed(1)}` : ''} МБ`, total ? Math.round((done / total) * 80) : undefined));
  progress('Проверяю архив…', 82);
  const zip = await JSZip.loadAsync(bytes);
  const files = Object.values(zip.files).filter((f) => !f.dir && f.name.startsWith(`${ZIP_FOLDER}/`));
  const manifestFile = zip.file(`${ZIP_FOLDER}/manifest.json`);
  if (!manifestFile || !files.length) throw new Error('В архиве нет расширения — обновление отменено, ничего не изменено.');
  const manifest = JSON.parse(await manifestFile.async('string')) as { name?: string; version?: string };
  if (manifest.name !== chrome.runtime.getManifest().name) throw new Error('Архив от другого расширения — обновление отменено.');
  let total = 0;
  for (const f of files) total += (f as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0;
  if (total > 200 * 1048576) throw new Error('Архив подозрительно большой — обновление отменено.');

  // 3. Write: manifest last, so a half-written update keeps the old manifest.
  const keep = new Set<string>();
  let n = 0;
  for (const f of files) {
    const rel = f.name.slice(ZIP_FOLDER.length + 1);
    keep.add(rel);
    if (rel === 'manifest.json') continue;
    await writeFile(dir, rel, await f.async('uint8array'));
    progress('Устанавливаю…', 82 + Math.round((++n / files.length) * 16));
  }
  await removeStale(dir as DirHandle, keep);
  await writeFile(dir, 'manifest.json', await manifestFile.async('uint8array'));

  // 4. Reload from disk; the background opens a "updated" note after the restart.
  progress(`Готово. Перезапускаю расширение на версии ${manifest.version}…`, 100);
  await chrome.storage.local.set({ justUpdated: { from: chrome.runtime.getManifest().version, to: manifest.version } });
  setTimeout(() => chrome.runtime.reload(), 600);
}
