import { AppError, naturalCompare, planSlices, readArchiveImages, rowBusyness, sniffImageMime, type ImageBackend, type ImageMime } from '@ait/core';
import { jsPDF } from 'jspdf';
import JSZip from 'jszip';

export interface ImportedImage {
  name: string;
  bytes: Uint8Array;
  mime: string;
}

export const MAX_PDF_PAGES = 500;

async function readFile(file: File): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer());
}

/** Render PDF pages to PNG with pdf.js (lazy-loaded; it is large). */
export async function pdfToImages(bytes: Uint8Array, name: string, onProgress?: (done: number, total: number) => void): Promise<ImportedImage[]> {
  const pdfjs = await import('pdfjs-dist');
  const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const doc = await pdfjs.getDocument({ data: bytes, enableXfa: false }).promise;
  if (doc.numPages > MAX_PDF_PAGES) throw new AppError('IMAGE_TOO_LARGE', { retryable: false, detail: `PDF has ${doc.numPages} pages (max ${MAX_PDF_PAGES})` });
  const out: ImportedImage[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(3, 1600 / base.width);
    const vp = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(vp.width);
    canvas.height = Math.round(vp.height);
    await page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport: vp }).promise;
    const blob: Blob = await new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('toBlob'))), 'image/png'));
    out.push({ name: `${name.replace(/\.pdf$/i, '')}-${String(i).padStart(3, '0')}.png`, bytes: new Uint8Array(await blob.arrayBuffer()), mime: 'image/png' });
    onProgress?.(i, doc.numPages);
    page.cleanup();
  }
  await doc.destroy();
  return out;
}

/** Turn dropped/picked files (images, ZIP/CBZ, PDF) into an ordered list of page images. */
export async function importFiles(files: File[], onProgress?: (msg: string) => void): Promise<ImportedImage[]> {
  const sorted = [...files].sort((a, b) => naturalCompare(a.name, b.name));
  const out: ImportedImage[] = [];
  for (const f of sorted) {
    const bytes = await readFile(f);
    const lower = f.name.toLowerCase();
    if (lower.endsWith('.zip') || lower.endsWith('.cbz') || lower.endsWith('.epub')) {
      onProgress?.(`Распаковка ${f.name}…`);
      const images = await readArchiveImages(bytes);
      if (!images.length) throw new AppError('UNSUPPORTED_FORMAT', { retryable: false, detail: `В ${f.name} нет картинок` });
      out.push(...images);
    } else if (/\.(cbr|rar|cb7|7z)$/.test(lower)) {
      throw new AppError('UNSUPPORTED_FORMAT', { retryable: false, detail: `${f.name}: архивы RAR/7z не открываются в браузере. Распакуйте его или переконвертируйте в CBZ (например, в Calibre или 7-Zip) и добавьте снова.` });
    } else if (lower.endsWith('.pdf') || f.type === 'application/pdf') {
      onProgress?.(`Чтение PDF ${f.name}…`);
      out.push(...(await pdfToImages(bytes, f.name, (d, t) => onProgress?.(`PDF ${f.name}: ${d}/${t}`))));
    } else {
      const mime = sniffImageMime(bytes);
      if (mime === 'image/tiff') throw new AppError('UNSUPPORTED_FORMAT', { retryable: false, detail: `${f.name}: TIFF браузер не открывает — сохраните картинку как PNG или JPG.` });
      if (!mime) throw new AppError('UNSUPPORTED_FORMAT', { retryable: false, detail: `${f.name}: поддерживаются PNG, JPG, WEBP, AVIF, GIF, BMP, а также PDF, ZIP, CBZ и EPUB.` });
      out.push({ name: f.name, bytes, mime });
    }
  }
  return out;
}

export interface ExportPage {
  name: string;
  width: number;
  height: number;
  tiles: { y: number; h: number; bytes: Uint8Array }[];
}

/** Join tiles into one image (when it fits a canvas) or keep them as numbered parts. */
export async function flattenTiles(backend: ImageBackend, page: ExportPage, mime: ImageMime, quality = 0.92): Promise<{ name: string; bytes: Uint8Array }[]> {
  const ext = mime === 'image/png' ? 'png' : mime === 'image/jpeg' ? 'jpg' : 'webp';
  const base = page.name.replace(/\.[^.]+$/, '');
  if (page.height <= 16_000) {
    const canvas = backend.createCanvas(page.width, page.height);
    const ctx = canvas.getContext('2d');
    for (const t of page.tiles) {
      const img = await backend.decode(t.bytes, 'image/png');
      ctx.drawImage(img.source, 0, t.y);
      img.close?.();
    }
    if (mime === 'image/jpeg') {
      // JPEG has no alpha; keep white instead of black.
      ctx.globalCompositeOperation = 'destination-over';
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, page.width, page.height);
    }
    return [{ name: `${base}.${ext}`, bytes: await backend.encode(canvas, mime, quality) }];
  }
  const parts: { name: string; bytes: Uint8Array }[] = [];
  for (const [i, t] of page.tiles.entries()) {
    const img = await backend.decode(t.bytes, 'image/png');
    const c = backend.createCanvas(page.width, t.h);
    c.getContext('2d').drawImage(img.source, 0, 0);
    img.close?.();
    parts.push({ name: `${base}-part${String(i + 1).padStart(2, '0')}.${ext}`, bytes: await backend.encode(c, mime, quality) });
  }
  return parts;
}

export async function exportZip(backend: ImageBackend, pages: ExportPage[], mime: ImageMime, onProgress?: (d: number, t: number) => void): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [i, p] of pages.entries()) {
    for (const f of await flattenTiles(backend, { ...p, name: `${String(i + 1).padStart(3, '0')}-${p.name}` }, mime)) zip.file(f.name, f.bytes);
    onProgress?.(i + 1, pages.length);
  }
  return zip.generateAsync({ type: 'uint8array', compression: 'STORE' });
}

/**
 * A translated page as book pages: short pages stay whole, long webtoon strips are cut at calm
 * rows (gutters between panels) into pages about 1.45× as tall as wide.
 */
export type PageLength = 'normal' | 'long' | 'whole';

/** How tall one book page may be when a long strip is cut: normal ≈ a book page, long ≈ 3×, whole = as long as a PDF page allows. */
export function sliceOptions(width: number, len: PageLength = 'normal'): { target: number; minFactor?: number; maxFactor?: number } {
  if (len === 'long') return { target: Math.round(width * 4.3) };
  // A PDF page is at most 14 400 units and a canvas about 16 000 px: stay under both.
  if (len === 'whole') return { target: 12_000, minFactor: 0.4, maxFactor: 1.15 };
  return { target: Math.round(width * 1.45) };
}

export async function bookPages(backend: ImageBackend, page: ExportPage, mime: ImageMime, quality = 0.9, len: PageLength = 'normal'): Promise<{ width: number; height: number; bytes: Uint8Array }[]> {
  const decoded = [];
  for (const t of page.tiles) decoded.push({ t, img: await backend.decode(t.bytes, sniffImageMime(t.bytes) ?? 'image/png') });
  try {
    const busy = new Float32Array(page.height);
    for (const { t, img } of decoded) {
      const c = backend.createCanvas(page.width, t.h);
      const ctx = c.getContext('2d');
      ctx.drawImage(img.source, 0, 0);
      const rows = rowBusyness(ctx.getImageData(0, 0, page.width, t.h).data, page.width, t.h);
      busy.set(rows.subarray(0, Math.min(t.h, page.height - t.y)), t.y);
    }
    const cuts = planSlices(busy, page.width, sliceOptions(page.width, len));
    const out: { width: number; height: number; bytes: Uint8Array }[] = [];
    for (const [i, y0] of cuts.entries()) {
      const y1 = cuts[i + 1] ?? page.height;
      const c = backend.createCanvas(page.width, y1 - y0);
      const ctx = c.getContext('2d');
      if (mime === 'image/jpeg') {
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, page.width, y1 - y0);
      }
      for (const { t, img } of decoded) {
        if (t.y + t.h <= y0 || t.y >= y1) continue;
        ctx.drawImage(img.source, 0, t.y - y0);
      }
      out.push({ width: page.width, height: y1 - y0, bytes: await backend.encode(c, mime, quality) });
    }
    return out;
  } finally {
    for (const { img } of decoded) img.close?.();
  }
}

/** PDF: one PDF page per book page; long strips are cut between panels. */
export async function exportPdf(backend: ImageBackend, pages: ExportPage[], onProgress?: (d: number, t: number) => void, len: PageLength = 'normal'): Promise<Uint8Array> {
  let doc: jsPDF | null = null;
  for (const [i, p] of pages.entries()) {
    for (const part of await bookPages(backend, p, 'image/jpeg', 0.9, len)) {
      // PDF pages are limited to 14 400 units; scale very large pages down to fit.
      const k = Math.min(1, 14_000 / Math.max(part.width, part.height));
      const w = part.width * k;
      const h = part.height * k;
      const orientation = w > h ? 'landscape' : 'portrait';
      if (!doc) doc = new jsPDF({ orientation, unit: 'px', format: [w, h], hotfixes: ['px_scaling'], compress: true });
      else doc.addPage([w, h], orientation);
      doc.addImage(part.bytes, 'JPEG', 0, 0, w, h, undefined, 'FAST');
    }
    onProgress?.(i + 1, pages.length);
  }
  if (!doc) throw new AppError('UNKNOWN', { message: 'Nothing to export', retryable: false });
  return new Uint8Array(doc.output('arraybuffer'));
}

/** CBZ: the comic-reader format — a ZIP of numbered page images plus ComicInfo.xml. */
export async function exportCbz(backend: ImageBackend, pages: ExportPage[], title: string, onProgress?: (d: number, t: number) => void, len: PageLength = 'normal'): Promise<Uint8Array> {
  const zip = new JSZip();
  let n = 0;
  for (const [i, p] of pages.entries()) {
    for (const part of await bookPages(backend, p, 'image/jpeg', 0.92, len)) zip.file(`${String(++n).padStart(4, '0')}.jpg`, part.bytes);
    onProgress?.(i + 1, pages.length);
  }
  const esc = (v: string) => v.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!);
  zip.file('ComicInfo.xml', `<?xml version="1.0" encoding="utf-8"?>\n<ComicInfo><Title>${esc(title)}</Title><PageCount>${n}</PageCount><LanguageISO>ru</LanguageISO><Notes>AI Translate</Notes></ComicInfo>\n`);
  return zip.generateAsync({ type: 'uint8array', compression: 'STORE' });
}

/** EPUB 3 with fixed layout: one image per page, readable in book apps on phones and e-readers. */
export async function exportEpub(backend: ImageBackend, pages: ExportPage[], title: string, lang = 'ru', onProgress?: (d: number, t: number) => void, len: PageLength = 'normal'): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  const esc = (v: string) => v.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!);
  const manifest: string[] = [];
  const spine: string[] = [];
  let n = 0;
  let first: { width: number; height: number } | null = null;
  for (const [i, p] of pages.entries()) {
    for (const part of await bookPages(backend, p, 'image/jpeg', 0.9, len)) {
      const id = String(++n).padStart(4, '0');
      first ??= part;
      zip.file(`OEBPS/img/${id}.jpg`, part.bytes);
      zip.file(`OEBPS/p${id}.xhtml`, `<?xml version="1.0" encoding="utf-8"?><!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${id}</title><meta name="viewport" content="width=${part.width}, height=${part.height}"/><style>body{margin:0}img{width:100%;height:100%;display:block}</style></head><body><img src="img/${id}.jpg" alt=""/></body></html>`);
      manifest.push(`<item id="i${id}" href="img/${id}.jpg" media-type="image/jpeg"/><item id="p${id}" href="p${id}.xhtml" media-type="application/xhtml+xml"/>`);
      spine.push(`<itemref idref="p${id}"/>`);
    }
    onProgress?.(i + 1, pages.length);
  }
  if (!n) throw new AppError('UNKNOWN', { message: 'Nothing to export', retryable: false });
  zip.file('OEBPS/nav.xhtml', `<?xml version="1.0" encoding="utf-8"?><!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>${esc(title)}</title></head><body><nav epub:type="toc"><ol><li><a href="p0001.xhtml">${esc(title)}</a></li></ol></nav></body></html>`);
  zip.file(
    'OEBPS/content.opf',
    `<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="uid">ait-${Date.now()}</dc:identifier><dc:title>${esc(title)}</dc:title><dc:language>${esc(lang)}</dc:language><meta property="dcterms:modified">${new Date().toISOString().slice(0, 19)}Z</meta><meta property="rendition:layout">pre-paginated</meta><meta property="rendition:spread">none</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>${manifest.join('')}</manifest><spine>${spine.join('')}</spine></package>`,
  );
  void first;
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', mimeType: 'application/epub+zip' });
}
