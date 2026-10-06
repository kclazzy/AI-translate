import { Capacitor } from '@capacitor/core';
import { createRoot } from 'react-dom/client';
import { browserBackend, bytesToBase64, IdbStore, migrateSettings, SecretStore, TranslateService, type AppSettings } from '@ait/core';
import { downloadFile, StudioApp, type StudioPlatform } from '@ait/studio';
import '@ait/studio/styles.css';
import './mobile.css';

const db = new IdbStore('ai-translate', 1);
const secrets = new SecretStore(db);

async function loadSettings(): Promise<AppSettings> {
  const s = migrateSettings(await db.get('kv', 'settings'));
  // On phones the engine (if any) is reached over Wi-Fi, never 127.0.0.1.
  if (s.engine.url.includes('127.0.0.1') && !(await db.get('kv', 'settings'))) s.engine.url = '';
  return s;
}

async function saveSettings(s: AppSettings): Promise<void> {
  await db.put('kv', 'settings', { ...s, providers: s.providers.map(({ apiKey: _k, ...p }) => p) });
}

/** Save or share a file: native share sheet in the app, Web Share or download in the browser. */
async function saveFile(name: string, bytes: Uint8Array, mime: string): Promise<void> {
  if (Capacitor.isNativePlatform()) {
    const { Filesystem, Directory } = await import('@capacitor/filesystem');
    const { Share } = await import('@capacitor/share');
    const written = await Filesystem.writeFile({ path: name, data: bytesToBase64(bytes), directory: Directory.Cache });
    await Share.share({ title: name, files: [written.uri] });
    return;
  }
  const file = new File([bytes as BlobPart], name, { type: mime });
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  if (nav.canShare?.({ files: [file] }) && /Android|iPhone|iPad/.test(navigator.userAgent)) {
    try {
      await navigator.share({ files: [file], title: name });
      return;
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
    }
  }
  await downloadFile(name, bytes, mime);
}

async function takeSharedFiles(): Promise<File[] | undefined> {
  if (!new URLSearchParams(location.search).has('shared')) return undefined;
  const stored = await db.get<{ name: string; type: string; bytes: Uint8Array }[]>('kv', 'shared-files');
  await db.delete('kv', 'shared-files');
  history.replaceState(null, '', location.pathname);
  return stored?.map((f) => new File([f.bytes as BlobPart], f.name, { type: f.type }));
}

const platform: StudioPlatform = {
  kind: 'mobile',
  db,
  secrets,
  backend: browserBackend,
  service: new TranslateService(db, secrets, browserBackend, loadSettings),
  loadSettings,
  saveSettings,
  saveFile,
  version: '0.2.2',
};

if ('serviceWorker' in navigator && !Capacitor.isNativePlatform() && location.protocol === 'https:') {
  void navigator.serviceWorker.register('./sw.js');
}

void takeSharedFiles().then((shared) => {
  createRoot(document.getElementById('root')!).render(<StudioApp platform={platform} sharedFiles={shared} initialView={shared && shared.length > 1 ? 'projects' : 'quick'} />);
});
