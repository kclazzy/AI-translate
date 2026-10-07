import '@ait/core/i18n/all';
import type { FromOffscreen, ToOffscreen } from '../shared/messages';
import { handleOffscreen } from './handler';

const emit = (m: FromOffscreen) => {
  void chrome.runtime.sendMessage(m).catch(() => undefined);
};

chrome.runtime.onMessage.addListener((msg: ToOffscreen, _sender, sendResponse) => {
  if (!msg || (msg as { target?: string }).target !== 'offscreen') return false;
  handleOffscreen(msg, emit).then(sendResponse, (e) => sendResponse({ error: String(e) }));
  return true;
});
