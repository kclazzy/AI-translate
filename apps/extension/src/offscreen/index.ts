import '@ait/core/i18n/all';
import { toAppError } from '@ait/core';
import type { FromOffscreen, OffscreenFailure, ToOffscreen } from '../shared/messages';
import { handleOffscreen, logError } from './handler';

const emit = (m: FromOffscreen) => {
  if (m.type === 'error') void logError(m.error);
  void chrome.runtime.sendMessage(m).catch(() => undefined);
};

chrome.runtime.onMessage.addListener((msg: ToOffscreen, sender, sendResponse) => {
  if (!msg || (msg as { target?: string }).target !== 'offscreen') return false;
  // Only this extension's own background talks to the worker.
  if (sender.id !== chrome.runtime.id || sender.tab) return false;
  handleOffscreen(msg, emit).then(sendResponse, (e) => {
    const error = toAppError(e).toJSON();
    void logError(error, msg.type);
    sendResponse({ __aitError: error } satisfies OffscreenFailure);
  });
  return true;
});
