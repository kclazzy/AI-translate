import '@ait/core/i18n/all';
import { toAppError } from '@ait/core';
import type { FromOffscreen, OffscreenFailure, ToOffscreen } from '../shared/messages';
import { handleOffscreen } from './handler';

const emit = (m: FromOffscreen) => {
  void chrome.runtime.sendMessage(m).catch(() => undefined);
};

chrome.runtime.onMessage.addListener((msg: ToOffscreen, sender, sendResponse) => {
  if (!msg || (msg as { target?: string }).target !== 'offscreen') return false;
  // Only this extension's own background talks to the worker.
  if (sender.id !== chrome.runtime.id || sender.tab) return false;
  handleOffscreen(msg, emit).then(sendResponse, (e) => sendResponse({ __aitError: toAppError(e).toJSON() } satisfies OffscreenFailure));
  return true;
});
