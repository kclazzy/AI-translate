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
  page: Pick<PageResult, 'blocks' | 'timings' | 'usage' | 'pipeline'>;
  cached: boolean;
}

// content → background
export type ContentToBackground =
  | { type: 'translate'; image: ImageRef; pageUrl: string; title: string; priority: number; force?: boolean }
  | { type: 'cancel'; id: string }
  | { type: 'capture-area'; image: ImageRef; pageUrl: string; title: string }
  | { type: 'get-page-state'; host: string }
  | { type: 'open-editor'; key: string }
  | { type: 'get-result'; key: string };

// background → content
export type BackgroundToContent =
  | { type: 'job-stage'; id: string; event: StageEvent }
  | { type: 'job-done'; id: string; result: RenderedTiles }
  | { type: 'job-error'; id: string; error: SerializedError }
  | { type: 'command'; command: 'translate-page' | 'select-area' | 'toggle-original' | 'set-auto'; value?: boolean }
  | { type: 'translate-src'; src: string }
  | { type: 'result-changed'; key: string }
  | { type: 'state'; autoTranslate: boolean; minImageSize: number };

// background ↔ offscreen
export type ToOffscreen =
  | { target: 'offscreen'; type: 'run'; jobId: string; tabId: number; bytesB64: string; mime?: string; pageUrl: string; title: string; priority: number; generic?: boolean; force?: boolean }
  | { target: 'offscreen'; type: 'crop-run'; jobId: string; tabId: number; screenshot: string; rect: { x: number; y: number; width: number; height: number }; dpr: number; pageUrl: string; title: string; generic?: boolean; priority?: number }
  | { target: 'offscreen'; type: 'cancel'; jobId: string }
  | { target: 'offscreen'; type: 'get-result'; key: string };

export type FromOffscreen =
  | { source: 'offscreen'; type: 'stage'; jobId: string; tabId: number; event: StageEvent }
  | { source: 'offscreen'; type: 'done'; jobId: string; tabId: number; result: RenderedTiles }
  | { source: 'offscreen'; type: 'error'; jobId: string; tabId: number; error: SerializedError };

// UI pages → background
export type UiToBackground =
  | { type: 'popup-command'; command: 'translate-page' | 'select-area' | 'toggle-original'; tabId: number }
  | { type: 'set-auto'; host: string; enabled: boolean; tabId: number }
  | { type: 'settings-changed' }
  | { type: 'result-changed'; key: string };
