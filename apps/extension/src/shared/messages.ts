import type { PageResult, SerializedError, StageEvent } from '@ait/core';

/** What the content script knows about an image on the page. */
export interface ImageRef {
  /** Stable id of the element within the page (data-ait-id). */
  id: string;
  kind: 'img' | 'background' | 'canvas' | 'area';
  /** URL to fetch (http/https/data). Absent when bytes come inline or from a capture. */
  src?: string;
  /** Inline image data (blob:, same-origin canvas) as data URL. */
  dataUrl?: string;
  /** Viewport rectangle in CSS px (used for capture fallback and screen areas). */
  rect?: { x: number; y: number; width: number; height: number };
  dpr?: number;
}

export interface RenderedTiles {
  key: string;
  width: number;
  height: number;
  tiles: { y: number; h: number; dataUrl: string }[];
  page: Pick<PageResult, 'blocks' | 'timings' | 'usage' | 'pipeline' | 'stripLang' | 'artText' | 'artRedrawn' | 'skippedNoText' | 'selfCheck'>;
  cached: boolean;
  /**
   * The tiles were too big for one message (browsers refuse messages over 64 MiB): `tiles` is
   * empty and this many tiles are fetched one by one with 'get-tile'.
   */
  tilesOmitted?: number;
}

/** One tile of a stored result (for results whose tiles do not fit in one message). */
export interface RenderedTile {
  y: number;
  h: number;
  dataUrl: string;
}

// content → background
export type ContentToBackground =
  | { type: 'translate'; image: ImageRef; pageUrl: string; title: string; priority: number; force?: boolean; redraw?: boolean }
  | { type: 'translate-strip'; images: ImageRef[]; pageUrl: string; title: string; priority: number; force?: boolean; redraw?: boolean }
  | { type: 'cancel'; id: string }
  | { type: 'capture-area'; image: ImageRef; pageUrl: string; title: string }
  | { type: 'get-page-state'; host: string }
  | { type: 'open-editor'; key: string; chapter?: string[] }
  | { type: 'get-result'; key: string }
  | { type: 'status'; ids: string[] }
  | { type: 'open-setup' }
  /** Should the page offer LaMa (text over artwork was painted over simply)? */
  | { type: 'lama-offer' }
  /** The LaMa offer: «Включить» opens the settings, «Не предлагать» remembers the choice. */
  | { type: 'lama-offer-answer'; accept: boolean }
  | { type: 'free-memory' }
  /** Pictures translated before: picture address → result key (results are fetched one by one). */
  | { type: 'lookup-cached'; srcs: string[] }
  | { type: 'get-tile'; key: string; index: number }
  | { type: 'build-download'; keys: string[]; title: string; format: ChapterFormat }
  /** «Сообщить о проблеме» on a page's ⓘ: a zip to reproduce it (page address only when ticked). */
  | { type: 'problem-report'; key: string; comment?: string; pageUrl?: string };

/** Time per translated page (kv 'speed'), written by the worker, shown in the popup. */
export interface SpeedStats {
  avgMs: number;
  pages: number;
  lastMs?: number;
  lastTokens?: number;
  at: string;
}

/** File formats for «Перевести и скачать». */
export type ChapterFormat = 'pdf' | 'cbz' | 'zip' | 'epub';

// background → content
export type BackgroundToContent =
  | { type: 'job-stage'; id: string; event: StageEvent }
  | { type: 'job-done'; id: string; result: RenderedTiles }
  | { type: 'job-error'; id: string; error: SerializedError }
  | { type: 'command'; command: 'translate-page' | 'select-area' | 'toggle-original' | 'set-auto' | 'download-chapter' | 'clear-page' | 'refresh-look'; value?: boolean | ChapterFormat }
  | { type: 'translate-src'; src: string }
  | { type: 'result-changed'; key: string }
  | { type: 'get-langs' }
  /** Right before a screenshot: hide our overlays over the picture and measure it again (null: not fully on screen). */
  | { type: 'prepare-capture'; id: string }
  | { type: 'end-capture'; id: string }
  | { type: 'state'; autoTranslate: boolean; minImageSize: number; enabled: boolean; targetLang: string; stitch?: boolean; ui?: UiStrings };

/** Interface language for the page overlays: the content script has no dictionaries of its own. */
export interface UiStrings {
  lang: string;
  dict: Record<string, string>;
}

/** Popup → content: languages for the "original ⇄ translation" button. */
export interface PageLangs {
  source?: string;
  target: string;
  showingOriginal: boolean;
  translated: number;
}

/** Where a job is. "unknown" means the worker has never heard of it (lost after a restart) or it just finished. */
export type JobStatus =
  | { state: 'pending'; ahead: number }
  | { state: 'running'; elapsedMs: number; stage?: StageEvent['stage'] }
  | { state: 'unknown' };

// background ↔ offscreen
export type ToOffscreen =
  // Picture bytes do not travel in messages (64 MiB limit, memory held by waiting jobs): the
  // background puts them into the job store (shared/jobstore.ts) and passes their id. `hash` is the
  // SHA-256 of the bytes: the same picture asked for twice (two tabs, a resend) is one queue job.
  | { target: 'offscreen'; type: 'run'; jobId: string; tabId: number; doc?: string; blobId: string; hash: string; mime?: string; pageUrl: string; title: string; priority: number; generic?: boolean; force?: boolean; imageSrc?: string }
  | { target: 'offscreen'; type: 'crop-run'; jobId: string; tabId: number; doc?: string; screenshot: string; rect: { x: number; y: number; width: number; height: number }; dpr: number; pageUrl: string; title: string; generic?: boolean; priority?: number }
  | { target: 'offscreen'; type: 'run-strip'; jobIds: string[]; tabId: number; doc?: string; parts: { blobId: string; hash: string; mime?: string; src?: string }[]; pageUrl: string; title: string; priority: number; force?: boolean }
  | { target: 'offscreen'; type: 'cancel'; jobId: string }
  /** Stop every job of a tab (or of one page shown in it: `doc`), or of all tabs. */
  | { target: 'offscreen'; type: 'cancel-tab'; tabId?: number; doc?: string }
  | { target: 'offscreen'; type: 'status'; jobIds: string[] }
  | { target: 'offscreen'; type: 'build-file'; keys: string[]; title: string; format: ChapterFormat; lang: string }
  | { target: 'offscreen'; type: 'build-problem-report'; key: string; comment?: string; pageUrl?: string; version: string }
  | { target: 'offscreen'; type: 'get-result'; key: string }
  | { target: 'offscreen'; type: 'get-tile'; key: string; index: number }
  | { target: 'offscreen'; type: 'lookup-cached'; srcs: string[] }
  | { target: 'offscreen'; type: 'free-memory' };

export type FromOffscreen =
  | { source: 'offscreen'; type: 'stage'; jobId: string; tabId: number; event: StageEvent }
  | { source: 'offscreen'; type: 'done'; jobId: string; tabId: number; result: RenderedTiles }
  | { source: 'offscreen'; type: 'error'; jobId: string; tabId: number; error: SerializedError }
  | { source: 'offscreen'; type: 'save'; tabId: number; url: string; filename: string }
  /** A stored result changed in the background (batched translation check): redraw it where shown. */
  | { source: 'offscreen'; type: 'result-changed'; key: string };

/** An error thrown in the offscreen document, sent back as the response (not a normal result). */
export interface OffscreenFailure {
  __aitError: SerializedError;
}

/** Detail of the CANCELLED error sent when a whole tab was stopped (popup, switching off, page closed). */
export const CANCELLED_ALL = 'all';

/** Name of the port a page keeps open while it has pictures in work (liveness, cancel on close). */
export const PAGE_PORT = 'ait-page';

// UI pages → background
export type UiToBackground =
  | { type: 'popup-command'; command: 'translate-page' | 'select-area' | 'toggle-original' | 'download-chapter' | 'clear-page' | 'refresh-look'; tabId: number; format?: ChapterFormat }
  | { type: 'set-auto'; host: string; enabled: boolean; tabId: number }
  | { type: 'settings-changed' }
  | { type: 'cancel-all'; tabId?: number }
  | { type: 'set-enabled'; enabled: boolean }
  | { type: 'result-changed'; key: string };
