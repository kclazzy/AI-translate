import { createContext, useContext } from 'react';
import type { AppSettings, IdbStore, ImageBackend, Inpainter, SecretStore, TranslateService, UpdateInfo } from '@ait/core';

/** What the studio needs from its host (extension page, mobile app, web app). */
export interface StudioPlatform {
  kind: 'extension' | 'mobile' | 'web';
  db: IdbStore;
  secrets: SecretStore;
  backend: ImageBackend;
  service: TranslateService;
  loadSettings(): Promise<AppSettings>;
  saveSettings(s: AppSettings): Promise<void>;
  /** Save or share a generated file. */
  saveFile(name: string, bytes: Uint8Array, mime: string): Promise<void>;
  /** Optional: tell the host that a cached page result changed (extension updates overlays). */
  notifyResultChanged?(key: string): void;
  version: string;
  /** Optional: install an update from inside the app (reports progress as text + percent). */
  installUpdate?(info: UpdateInfo, progress: (text: string, pct?: number) => void): Promise<void>;
  /** Choose (or allow again) the folder the update writes to; call it first thing in a click handler. */
  pickUpdateFolder?(): Promise<void>;
  /** Optional: the setup helper finished; continue what the user started (params of the page URL). */
  setupReady?(params: URLSearchParams): void;
  /** Optional: LaMa running in this browser (download the model once, then it redraws art under text). */
  lama?: { downloaded(): Promise<boolean>; download(progress: (share: number) => void): Promise<void>; remove(): Promise<void> };
  /** Optional: LaMa itself (needs the downloaded model), for the editor's «Дорисовать фон». */
  inpaint?: Inpainter;
}

export const PlatformContext = createContext<StudioPlatform | null>(null);

/** Change the app settings from anywhere inside the studio (saved at once, like the settings page does). */
export const UpdateSettingsContext = createContext<((patch: Partial<AppSettings>) => void) | null>(null);

export function useUpdateSettings(): ((patch: Partial<AppSettings>) => void) | null {
  return useContext(UpdateSettingsContext);
}

export function usePlatform(): StudioPlatform {
  const p = useContext(PlatformContext);
  if (!p) throw new Error('StudioPlatform missing');
  return p;
}

/**
 * A file name that is safe everywhere: titles and page addresses ("https://site/ch/1.png") become
 * names without path separators or characters Windows / Android refuse.
 */
export function safeFileName(name: string, fallback = 'file'): string {
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 && dot >= name.length - 8 && /^\.[\w-]+$/.test(name.slice(dot)) ? name.slice(dot) : '';
  const base = (ext ? name.slice(0, dot) : name)
    .replace(/^[a-z][\w+.-]*:\/\//i, '')
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[\s._]+|[\s.]+$/g, '')
    .slice(0, 100);
  return (base || fallback) + ext;
}

/** The platform with every saved file name made safe. */
export function withSafeFileNames(p: StudioPlatform): StudioPlatform {
  return { ...p, saveFile: (name, bytes, mime) => p.saveFile(safeFileName(name), bytes, mime) };
}

/** Browser download used by extension and web builds. */
export async function downloadFile(name: string, bytes: Uint8Array, mime: string): Promise<void> {
  name = safeFileName(name);
  const blob = new Blob([bytes as BlobPart], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
