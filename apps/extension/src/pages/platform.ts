import { deleteLama, downloadLama, lamaDownloaded, lamaInpainter } from '../offscreen/lama';
import { browserBackend, TranslateService } from '@ait/core';
import { downloadFile, type StudioPlatform } from '@ait/studio';
import { db, loadSettings, saveSettings, secrets } from '../shared/store';
import { installExtensionUpdate } from './updater';

/** LaMa needs WebAssembly and the Cache API (where the model is kept). */
const lamaHere = typeof caches !== 'undefined' && typeof WebAssembly !== 'undefined';

export function extensionPlatform(): StudioPlatform {
  return {
    kind: 'extension',
    db,
    secrets,
    backend: browserBackend,
    service: new TranslateService(db, secrets, browserBackend, loadSettings),
    loadSettings,
    saveSettings,
    saveFile: downloadFile,
    ...(lamaHere ? { lama: { downloaded: lamaDownloaded, download: (p: (share: number) => void) => downloadLama(p), remove: deleteLama }, inpaint: lamaInpainter } : {}),
    notifyResultChanged: (key) => void chrome.runtime.sendMessage({ type: 'result-changed', key }).catch(() => undefined),
    version: chrome.runtime.getManifest().version,
    installUpdate: installExtensionUpdate,
    setupReady: (params) => {
      // Continue the translation the user started before the helper opened.
      const tabId = Number(params.get('resume'));
      const command = params.get('cmd');
      if (!tabId || (command !== 'translate-page' && command !== 'select-area' && command !== 'download-chapter')) return;
      void chrome.runtime.sendMessage({ type: 'popup-command', command, tabId, ...(command === 'download-chapter' ? { format: params.get('format') ?? 'pdf' } : {}) });
      setTimeout(() => {
        void chrome.tabs.update(tabId, { active: true }).catch(() => undefined);
        window.close();
      }, 2500);
    },
  };
}
