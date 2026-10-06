import { browserBackend, TranslateService } from '@ait/core';
import { downloadFile, type StudioPlatform } from '@ait/studio';
import { db, loadSettings, saveSettings, secrets } from '../shared/store';

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
    notifyResultChanged: (key) => void chrome.runtime.sendMessage({ type: 'result-changed', key }).catch(() => undefined),
    version: chrome.runtime.getManifest().version,
  };
}
