import { AppError, ARCHIVE_LIMITS, naturalCompare, sniffImageMime } from '@ait/core';
import { tr } from '@ait/core/i18n';

export interface ArchivedImage {
  name: string;
  bytes: Uint8Array;
  mime: string;
}

const IMAGE = /\.(png|jpe?g|webp|gif|bmp|avif)$/i;
/** A broken file never answers the unpacker: it is given this long (more for a bigger file). */
const openMs = (bytes: number) => 30_000 + bytes / 50_000;

function unsafe(path: string): boolean {
  return path.includes('..') || path.startsWith('/') || path.includes('\\') || /^[a-z]:/i.test(path);
}

type Tree = { [name: string]: Tree | File };
function walk(tree: Tree, prefix: string, out: Map<string, File>) {
  for (const [name, v] of Object.entries(tree)) {
    if (v instanceof File) out.set(prefix + name, v);
    else if (v && typeof v === 'object') walk(v, `${prefix}${name}/`, out);
  }
}

/**
 * The pages of a RAR / 7z / TAR chapter (CBR, CB7, CBT) in page order. libarchive (WebAssembly)
 * is loaded only now; the archive is checked for size and paths before anything is unpacked, and
 * unpacked in one pass (a solid RAR would otherwise be unpacked from the start for every page).
 */
export async function otherArchiveImages(bytes: Uint8Array, name: string): Promise<ArchivedImage[]> {
  const { Archive } = await import('libarchive.js');
  let worker: Worker | null = null;
  Archive.init({
    getWorker: () => {
      worker = new Worker(new URL('libarchive/worker-bundle.js', document.baseURI), { type: 'module' });
      return worker;
    },
  });
  const stop = () => (worker as Worker | null)?.terminate();
  const bad = (detail: string) => new AppError('UNSUPPORTED_FORMAT', { retryable: false, detail });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const opened = Archive.open(new File([bytes as BlobPart], name));
    const arc = await Promise.race([
      opened,
      new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(bad(tr('{0}: архив не открылся — файл повреждён или это не архив.', name))), openMs(bytes.length));
      }),
    ]);
    clearTimeout(timer);
    if (await arc.hasEncryptedData()) throw bad(tr('{0}: архив защищён паролем. Распакуйте его сами и добавьте картинки.', name));
    const list = (await arc.getFilesArray()) as { file: { name: string; size: number }; path: string }[];
    if (list.length > ARCHIVE_LIMITS.maxEntries) throw new AppError('IMAGE_TOO_LARGE', { retryable: false, detail: `Archive has ${list.length} files` });
    let total = 0;
    for (const e of list) {
      const full = e.path + e.file.name;
      if (unsafe(full)) throw bad(`Unsafe path ${full}`);
      if (e.file.size > ARCHIVE_LIMITS.maxEntryBytes) throw new AppError('IMAGE_TOO_LARGE', { retryable: false, detail: `${full} is too large` });
      total += e.file.size;
    }
    if (total > ARCHIVE_LIMITS.maxTotalBytes) throw new AppError('IMAGE_TOO_LARGE', { retryable: false, detail: 'Archive is too large when unpacked' });
    const wanted = list.map((e) => e.path + e.file.name).filter((p) => IMAGE.test(p) && !p.startsWith('__MACOSX'));
    if (!wanted.length) return [];
    const files = new Map<string, File>();
    walk((await arc.extractFiles()) as Tree, '', files);
    wanted.sort(naturalCompare);
    const out: ArchivedImage[] = [];
    for (const path of wanted) {
      const f = files.get(path);
      if (!f) continue;
      const data = new Uint8Array(await f.arrayBuffer());
      const mime = sniffImageMime(data);
      if (mime) out.push({ name: path.split('/').pop() ?? path, bytes: data, mime });
    }
    return out;
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw bad(tr('{0}: архив не открылся — файл повреждён или это не архив.', name));
  } finally {
    clearTimeout(timer);
    stop();
  }
}
