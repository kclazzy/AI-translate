import { createContext, useContext } from 'react';
import type { AppSettings, IdbStore, ImageBackend, SecretStore, TranslateService } from '@ait/core';

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
}

export const PlatformContext = createContext<StudioPlatform | null>(null);

export function usePlatform(): StudioPlatform {
  const p = useContext(PlatformContext);
  if (!p) throw new Error('StudioPlatform missing');
  return p;
}

/** Browser download used by extension and web builds. */
export async function downloadFile(name: string, bytes: Uint8Array, mime: string): Promise<void> {
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
