import { useSyncExternalStore } from 'react';
import { BROWSER_TRANSLATOR_ID, translatorLang, translatorPairs, type AppSettings } from '@ait/core';
import { tr } from '@ait/core/i18n';
import type { StudioPlatform } from './platform';

/**
 * Everything the AI mode «Распознавание» needs, set up in one go when the mode is chosen: the text
 * detector, the line reader (the Korean one for Korean), Manga OCR for Japanese and the language pack
 * of the browser's translator. Nothing to look for in the settings: the card only shows the progress.
 */
export interface OcrNeeds {
  det: boolean;
  ocr: boolean;
  /** Manga OCR (only asked for Japanese). */
  manga: boolean;
  /** The translator's language pack: 'ok', 'download' (a click downloads it), 'none' (not this pair / no translator). */
  pack: 'ok' | 'download' | 'none';
}

export interface OcrSetupState {
  running: boolean;
  /** 0–1 over the model downloads. */
  pct: number;
  err: string | null;
  /** The last check (null before the first). */
  needs: OcrNeeds | null;
}

let state: OcrSetupState = { running: false, pct: 0, err: null, needs: null };
const subs = new Set<() => void>();
const set = (p: Partial<OcrSetupState>) => {
  state = { ...state, ...p };
  for (const f of subs) f();
};

export function useOcrSetup(): OcrSetupState {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => state,
  );
}

const lang = (s: AppSettings) => s.sourceLang.split('-')[0];
/** The translator's packs to have: the chosen language and the ten main ones, into the target language. */
const packPairs = (s: AppSettings): [string, string][] => (s.visionProviderId === BROWSER_TRANSLATOR_ID ? translatorPairs(s.sourceLang, s.targetLang) : []);

/** What is still missing for these settings (also kept for the card). */
export async function checkOcrNeeds(platform: StudioPlatform, s: AppSettings): Promise<OcrNeeds> {
  const det = (await platform.detector?.downloaded().catch(() => false)) ?? false;
  const ocr = (await platform.ocr?.downloaded(lang(s) === 'ko').catch(() => false)) ?? false;
  const manga = lang(s) !== 'ja' || ((await platform.ocr?.manga?.downloaded().catch(() => false)) ?? true);
  let pack: OcrNeeds['pack'] = 'ok';
  const bt = platform.browserTranslator;
  const pairs = packPairs(s);
  if (bt && pairs.length) {
    const states = await Promise.all(pairs.map(([a, b]) => bt.status(a, b).catch(() => 'unavailable' as const)));
    const chosen = s.sourceLang === 'auto' ? null : states[0];
    // A pack still to get (of the chosen language or a main one) → 'download'; the chosen pair impossible → 'none'.
    pack = chosen === 'unavailable' ? 'none' : states.some((x) => x === 'downloadable' || x === 'downloading') ? 'download' : 'ok';
  }
  const needs = { det, ocr, manga, pack };
  set({ needs });
  return needs;
}

/** Megabytes still to download for the models. */
export function needsMb(n: OcrNeeds, s: AppSettings): number {
  return (n.det ? 0 : 45) + (n.ocr ? 0 : lang(s) === 'ko' ? 23 : 31) + (n.manga ? 0 : 117);
}

/** Is everything there? */
export const ocrComplete = (n: OcrNeeds | null): boolean => !!n && n.det && n.ocr && n.manga && n.pack !== 'download';

/**
 * Download whatever is missing. Call it straight from a click: the browser's translator downloads
 * its language pack only right after one (it is started first, before anything is awaited).
 */
export function startOcrSetup(platform: StudioPlatform, s: AppSettings): Promise<void> {
  // All the packs at once, straight from the click (the chosen language's failure is the one reported).
  const bt = platform.browserTranslator;
  const pairs = bt ? packPairs(s) : [];
  const runs = pairs.map(([a, b]) => bt!.prepare(a, b).then(() => null, (e: unknown) => e));
  const pack = Promise.all(runs).then((r) => (s.sourceLang !== 'auto' ? r[0] : null) ?? null);
  if (state.running) return pack.then(() => undefined);
  set({ running: true, err: null, pct: 0 });
  return (async () => {
    try {
      const n = await checkOcrNeeds(platform, s);
      const parts: { mb: number; run: (p: (x: number) => void) => Promise<void> }[] = [];
      if (!n.det && platform.detector) parts.push({ mb: 45, run: (p) => platform.detector!.download(p) });
      if (!n.ocr && platform.ocr) parts.push({ mb: lang(s) === 'ko' ? 23 : 31, run: (p) => platform.ocr!.download(p, lang(s) === 'ko') });
      if (!n.manga && platform.ocr?.manga) parts.push({ mb: 117, run: (p) => platform.ocr!.manga!.download(p) });
      const total = parts.reduce((a, b) => a + b.mb, 0) || 1;
      let done = 0;
      for (const part of parts) {
        await part.run((x) => {
          // The bar moves by whole per cent: a download reports every few kilobytes.
          const pct = Math.floor(((done + x * part.mb) / total) * 100) / 100;
          if (pct !== state.pct) set({ pct });
        });
        done += part.mb;
      }
      const packErr = await pack;
      await checkOcrNeeds(platform, s);
      if (packErr && state.needs?.pack === 'download') set({ err: tr('Языковой пакет переводчика не скачался: {0}', packErr instanceof Error ? packErr.message : String(packErr)) });
    } catch (e) {
      set({ err: e instanceof Error ? e.message : String(e) });
    } finally {
      set({ running: false, pct: 1 });
    }
  })();
}
