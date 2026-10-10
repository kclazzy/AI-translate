import JSZip from 'jszip';
import { sniffImageMime, type AppSettings, type ImageBackend, type PageResult } from '@ait/core';
import { sanitizeSettings, sanitizeUrl } from './settingsFile';

type Tile = { y: number; h: number; bytes: Uint8Array };

/**
 * «Сообщить о проблеме со страницей»: everything needed to reproduce one page exactly — the
 * original picture, the result, the cleaned picture, the page data with what the model answered,
 * the settings without keys. The page address only when the user asks for it.
 */
export interface ProblemReportInput {
  page: PageResult;
  original?: { bytes: Uint8Array; mime?: string };
  rendered?: Tile[];
  cleaned?: Tile[];
  settings?: AppSettings;
  version: string;
  /** extension / mobile / web / editor… */
  platform: string;
  /** Joins tiles into one picture; without it the tiles go in as they are. */
  backend?: ImageBackend;
  sourceUrl?: string;
  /** «включить адрес страницы» (off by default). */
  includeUrl?: boolean;
  /** «Что не так?» */
  comment?: string;
  /** The page as edited in the editor (not the model's own result). */
  edited?: boolean;
  userAgent?: string;
  date?: Date;
}

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/bmp': 'bmp', 'image/avif': 'avif' };
const extOf = (bytes: Uint8Array, mime?: string) => EXT[sniffImageMime(bytes) ?? mime ?? ''] ?? 'bin';

const pad = (n: number) => String(n).padStart(2, '0');

/** ait-problem-20261010-1844-1a2b3c4d.zip (Latin only: safe as a download name everywhere). */
export function problemReportName(page: Pick<PageResult, 'pageId'>, date = new Date()): string {
  const d = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
  const id = (page.pageId || '').replace(/[^0-9a-z]/gi, '').slice(0, 8).toLowerCase() || Math.random().toString(36).slice(2, 10);
  return `ait-problem-${d}-${id}.zip`;
}

/** The tiles as one PNG (or numbered parts for a very tall page). */
async function pictures(zip: JSZip, base: string, tiles: Tile[], width: number, height: number, backend?: ImageBackend): Promise<void> {
  if (!tiles.length) return;
  if (tiles.length === 1 && sniffImageMime(tiles[0].bytes) === 'image/png') return void zip.file(`${base}.png`, tiles[0].bytes);
  if (backend && height <= 16_000) {
    try {
      const canvas = backend.createCanvas(width, height);
      const ctx = canvas.getContext('2d');
      for (const t of tiles) {
        const img = await backend.decode(t.bytes, sniffImageMime(t.bytes) ?? 'image/png');
        ctx.drawImage(img.source, 0, t.y);
        img.close?.();
      }
      return void zip.file(`${base}.png`, await backend.encode(canvas, 'image/png'));
    } catch {
      /* the parts as they are */
    }
  }
  for (const [i, t] of tiles.entries()) zip.file(`${base}-part${pad(i + 1)}-y${t.y}.${extOf(t.bytes)}`, t.bytes);
}

const README = `Отчёт о проблеме со страницей — AI Translate

Пришлите этот файл разработчику (например, приложите к сообщению в обратную связь или к задаче на GitHub). По нему страницу можно воспроизвести в точности.

Что внутри:
- original.* — исходная картинка;
- result.png — результат перевода;
- cleaned.png — картинка с убранным текстом (до наложения перевода);
- page.json — найденные блоки текста, ответы модели и решения программы;
- settings.json — настройки без ключей API, токенов и паролей;
- info.txt — версия, браузер, модели и ваш комментарий.

Ключей API здесь нет. Адрес страницы включён, только если вы сами отметили «включить адрес страницы».
Если картинка личная — не отправляйте файл.
`;

function modelsOf(page: PageResult, settings?: AppSettings): string[] {
  const out = new Set<string>();
  if (settings) {
    for (const [role, id] of [['vision', settings.visionProviderId], ['translation', settings.translationProviderId]] as const) {
      const p = id ? settings.providers.find((x) => x.id === id) : undefined;
      if (p) out.add(`${role}: ${p.label} — ${p.model}`);
    }
  }
  for (const u of page.usage ?? []) out.add(`used: ${u.provider} — ${u.model}`);
  for (const a of page.debug?.answers ?? []) out.add(`answered (${a.stage}): ${a.model}`);
  return [...out];
}

export async function buildProblemReport(input: ProblemReportInput): Promise<{ name: string; bytes: Uint8Array }> {
  const date = input.date ?? new Date();
  const { page } = input;
  const zip = new JSZip();
  zip.file('README.txt', README);
  if (input.original?.bytes?.length) zip.file(`original.${extOf(input.original.bytes, input.original.mime)}`, input.original.bytes);
  await pictures(zip, 'result', input.rendered ?? [], page.width, page.height, input.backend);
  await pictures(zip, 'cleaned', input.cleaned ?? [], page.width, page.height, input.backend);
  zip.file('page.json', JSON.stringify(page, null, 2));
  if (input.settings) zip.file('settings.json', JSON.stringify(sanitizeSettings(input.settings), null, 2));
  const ua = input.userAgent ?? (typeof navigator !== 'undefined' ? navigator.userAgent : '');
  const info = [
    'AI Translate — problem report',
    `version: ${input.version}`,
    `platform: ${input.platform}`,
    `date: ${date.toISOString()}`,
    `browser: ${ua}`,
    `page: ${page.pageId} ${page.width}×${page.height}, ${page.source?.lang ?? '?'} → ${page.targetLang}, mode ${page.pipeline?.mode ?? '?'}, ${page.blocks.length} blocks${input.edited ? ', edited in the editor' : ''}`,
    `result made: ${page.createdAt}`,
    'models:',
    ...modelsOf(page, input.settings).map((m) => `  ${m}`),
    `page url: ${input.includeUrl && input.sourceUrl ? sanitizeUrl(input.sourceUrl) : '(not included)'}`,
    '',
    'Что не так:',
    (input.comment ?? '').trim() || '(не указано)',
    '',
  ].join('\n');
  zip.file('info.txt', info);
  const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
  return { name: problemReportName(page, date), bytes };
}
