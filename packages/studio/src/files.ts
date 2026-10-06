import { AppError, naturalCompare, readArchiveImages, sniffImageMime, type ImageBackend, type ImageMime } from '@ait/core';
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
    if (lower.endsWith('.zip') || lower.endsWith('.cbz')) {
      onProgress?.(`Распаковка ${f.name}…`);
      out.push(...(await readArchiveImages(bytes)));
    } else if (lower.endsWith('.pdf') || f.type === 'application/pdf') {
      onProgress?.(`Чтение PDF ${f.name}…`);
      out.push(...(await pdfToImages(bytes, f.name, (d, t) => onProgress?.(`PDF ${f.name}: ${d}/${t}`))));
    } else {
      const mime = sniffImageMime(bytes);
      if (!mime) throw new AppError('UNSUPPORTED_FORMAT', { retryable: false, detail: f.name });
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

export async function exportPdf(backend: ImageBackend, pages: ExportPage[], onProgress?: (d: number, t: number) => void): Promise<Uint8Array> {
  let doc: jsPDF | null = null;
  for (const [i, p] of pages.entries()) {
    for (const part of await flattenTiles(backend, p, 'image/jpeg', 0.9)) {
      const img = await backend.decode(part.bytes, 'image/jpeg');
      const w = img.width;
      const h = img.height;
      img.close?.();
      const orientation = w > h ? 'landscape' : 'portrait';
      if (!doc) doc = new jsPDF({ orientation, unit: 'px', format: [w, h], hotfixes: ['px_scaling'] });
      else doc.addPage([w, h], orientation);
      doc.addImage(part.bytes, 'JPEG', 0, 0, w, h);
    }
    onProgress?.(i + 1, pages.length);
  }
  if (!doc) throw new AppError('UNKNOWN', { message: 'Nothing to export', retryable: false });
  return new Uint8Array(doc.output('arraybuffer'));
}
