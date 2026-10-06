import { AppError, bytesToBase64, dataUrlToBytes, toAppError } from '@ait/core';
import type { BackgroundToContent, ContentToBackground, FromOffscreen, ToOffscreen, UiToBackground } from '../shared/messages';
import { hostOf, loadSettings, saveSettings } from '../shared/store';

/**
 * Service worker: a thin router. It fetches image bytes (with host permissions and the page's
 * Referer), takes screenshots, and hands the heavy work to the offscreen document.
 */

const OFFSCREEN_URL = 'offscreen.html';
/** Small in-memory diagnostics ring buffer (readable from DevTools as __aitLog). */
const debugLog: string[] = [];
(globalThis as unknown as { __aitLog: string[] }).__aitLog = debugLog;
function dlog(...args: unknown[]) {
  debugLog.push(`${new Date().toISOString().slice(11, 23)} ${args.map((a) => (a instanceof Error ? a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`);
  if (debugLog.length > 200) debugLog.shift();
  console.debug('[AIT]', ...args);
}
const MAX_FETCH_BYTES = 60 * 1024 * 1024;
let creating: Promise<void> | null = null;
const running = new Map<number, Set<string>>();

async function ensureOffscreen(): Promise<void> {
  const off = chrome.offscreen;
  if (!off) return;
  if (await off.hasDocument?.()) return;
  creating ??= off
    .createDocument({ url: OFFSCREEN_URL, reasons: [off.Reason.BLOBS], justification: 'Render translated manga pages on canvas and run the translation pipeline' })
    .catch((e) => {
      if (!String(e).includes('single offscreen')) throw e;
    })
    .finally(() => {
      creating = null;
    });
  await creating;
}

/** Firefox has no offscreen API but its background page has a DOM: run the handler in place. */
async function toOffscreen<T = unknown>(msg: ToOffscreen): Promise<T> {
  dlog('to offscreen', msg.type);
  if (chrome.offscreen) {
    await ensureOffscreen();
    return chrome.runtime.sendMessage(msg) as Promise<T>;
  }
  const { handleOffscreen } = await import('../offscreen/handler');
  return (await handleOffscreen(msg, relayFromOffscreen)) as T;
}

function sendToTab(tabId: number, msg: BackgroundToContent): void {
  void chrome.tabs.sendMessage(tabId, msg).catch(() => undefined);
}

function setBadge(tabId: number) {
  const n = running.get(tabId)?.size ?? 0;
  void chrome.action.setBadgeBackgroundColor({ tabId, color: '#c8205f' }).catch(() => undefined);
  void chrome.action.setBadgeText({ tabId, text: n ? String(n) : '' }).catch(() => undefined);
}

function track(tabId: number, jobId: string, on: boolean) {
  const set = running.get(tabId) ?? new Set<string>();
  if (on) set.add(jobId);
  else set.delete(jobId);
  running.set(tabId, set);
  setBadge(tabId);
}

function relayFromOffscreen(m: FromOffscreen) {
  const id = m.jobId.split('|')[1] ?? m.jobId;
  if (m.type === 'stage') sendToTab(m.tabId, { type: 'job-stage', id, event: m.event });
  else if (m.type === 'done') {
    track(m.tabId, m.jobId, false);
    sendToTab(m.tabId, { type: 'job-done', id, result: m.result });
  } else {
    track(m.tabId, m.jobId, false);
    sendToTab(m.tabId, { type: 'job-error', id, error: m.error });
  }
}

let ruleSeq = 1000;
/** Fetch an image as the page would: with cookies and the page as Referer (hotlink protection). */
async function fetchImage(src: string, pageUrl: string): Promise<{ bytes: Uint8Array; mime: string }> {
  if (src.startsWith('data:')) return dataUrlToBytes(src);
  let url: URL;
  try {
    url = new URL(src);
  } catch {
    throw new AppError('IMAGE_FETCH_FAILED', { retryable: false, detail: 'Bad image URL' });
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new AppError('IMAGE_FETCH_FAILED', { retryable: false, detail: `Unsupported scheme ${url.protocol}` });
  const ruleId = ++ruleSeq;
  let ruleAdded = false;
  try {
    if (chrome.declarativeNetRequest?.updateSessionRules && pageUrl.startsWith('http')) {
      await chrome.declarativeNetRequest.updateSessionRules({
        addRules: [
          {
            id: ruleId,
            priority: 1,
            action: { type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS, requestHeaders: [{ header: 'referer', operation: chrome.declarativeNetRequest.HeaderOperation.SET, value: pageUrl }] },
            condition: { requestDomains: [url.hostname], initiatorDomains: [chrome.runtime.id], resourceTypes: [chrome.declarativeNetRequest.ResourceType.XMLHTTPREQUEST, chrome.declarativeNetRequest.ResourceType.OTHER] },
          },
        ],
      });
      ruleAdded = true;
    }
    const res = await fetch(url.href, { credentials: 'include', cache: 'force-cache' });
    if (!res.ok) throw new AppError('IMAGE_FETCH_FAILED', { detail: `HTTP ${res.status}` });
    const len = Number(res.headers.get('content-length') ?? 0);
    if (len > MAX_FETCH_BYTES) throw new AppError('IMAGE_TOO_LARGE', { retryable: false });
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length > MAX_FETCH_BYTES) throw new AppError('IMAGE_TOO_LARGE', { retryable: false });
    return { bytes: buf, mime: res.headers.get('content-type') ?? '' };
  } finally {
    if (ruleAdded) void chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] });
  }
}

async function capture(windowId: number): Promise<string> {
  return chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
}

async function handleContent(msg: ContentToBackground, sender: chrome.runtime.MessageSender): Promise<unknown> {
  const tabId = sender.tab?.id;
  const windowId = sender.tab?.windowId;
  if (tabId === undefined || windowId === undefined) return null;
  switch (msg.type) {
    case 'translate': {
      const jobId = `${tabId}|${msg.image.id}`;
      track(tabId, jobId, true);
      try {
        let bytes: Uint8Array | null = null;
        let mime = '';
        if (msg.image.dataUrl) ({ bytes, mime } = dataUrlToBytes(msg.image.dataUrl));
        else if (msg.image.src) {
          try {
            ({ bytes, mime } = await fetchImage(msg.image.src, msg.pageUrl));
          } catch (e) {
            if (!msg.image.rect) throw e;
          }
        }
        if (!bytes) {
          if (!msg.image.rect) throw new AppError('IMAGE_FETCH_FAILED', { retryable: false });
          // Protected reader (canvas, blob, blocked hotlink): translate what is on screen.
          const shot = await capture(windowId);
          await toOffscreen({ target: 'offscreen', type: 'crop-run', jobId, tabId, screenshot: shot, rect: msg.image.rect, dpr: msg.image.dpr ?? 1, pageUrl: msg.pageUrl, title: msg.title, generic: false, priority: msg.priority });
          return { queued: true, captured: true };
        }
        await toOffscreen({ target: 'offscreen', type: 'run', jobId, tabId, bytesB64: bytesToBase64(bytes), mime, pageUrl: msg.pageUrl, title: msg.title, priority: msg.priority, force: msg.force });
        return { queued: true };
      } catch (e) {
        dlog('translate failed', e);
        track(tabId, jobId, false);
        sendToTab(tabId, { type: 'job-error', id: msg.image.id, error: toAppError(e).toJSON() });
        return { queued: false };
      }
    }
    case 'capture-area': {
      const jobId = `${tabId}|${msg.image.id}`;
      track(tabId, jobId, true);
      try {
        const shot = await capture(windowId);
        await toOffscreen({ target: 'offscreen', type: 'crop-run', jobId, tabId, screenshot: shot, rect: msg.image.rect!, dpr: msg.image.dpr ?? 1, pageUrl: msg.pageUrl, title: msg.title, generic: true });
      } catch (e) {
        track(tabId, jobId, false);
        sendToTab(tabId, { type: 'job-error', id: msg.image.id, error: toAppError(e).toJSON() });
      }
      return { queued: true };
    }
    case 'cancel':
      track(tabId, `${tabId}|${msg.id}`, false);
      return toOffscreen({ target: 'offscreen', type: 'cancel', jobId: `${tabId}|${msg.id}` });
    case 'get-page-state': {
      const s = await loadSettings();
      return { autoTranslate: s.autoTranslate.enabled || s.autoTranslate.sites.includes(msg.host), minImageSize: s.minImageSize };
    }
    case 'open-editor':
      await chrome.tabs.create({ url: chrome.runtime.getURL(`studio.html?key=${encodeURIComponent(msg.key)}`), index: (sender.tab?.index ?? 0) + 1 });
      return null;
    case 'get-result':
      return toOffscreen({ target: 'offscreen', type: 'get-result', key: msg.key });
  }
}

async function broadcastState() {
  const s = await loadSettings();
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) {
    if (t.id === undefined) continue;
    const host = hostOf(t.url);
    sendToTab(t.id, { type: 'state', autoTranslate: s.autoTranslate.enabled || s.autoTranslate.sites.includes(host), minImageSize: s.minImageSize });
  }
}

async function handleUi(msg: UiToBackground): Promise<unknown> {
  switch (msg.type) {
    case 'popup-command':
      sendToTab(msg.tabId, { type: 'command', command: msg.command });
      return null;
    case 'set-auto': {
      const s = await loadSettings();
      const sites = new Set(s.autoTranslate.sites);
      if (msg.enabled) sites.add(msg.host);
      else sites.delete(msg.host);
      await saveSettings({ ...s, autoTranslate: { ...s.autoTranslate, sites: [...sites] } });
      sendToTab(msg.tabId, { type: 'command', command: 'set-auto', value: msg.enabled });
      return null;
    }
    case 'settings-changed':
      await broadcastState();
      return null;
    case 'result-changed': {
      const tabs = await chrome.tabs.query({});
      for (const t of tabs) if (t.id !== undefined) sendToTab(t.id, { type: 'result-changed', key: msg.key });
      return null;
    }
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return false;
  dlog('message', (msg as { type?: string }).type, sender.url);
  if ((msg as { target?: string }).target === 'offscreen') return false; // for the offscreen document
  if ((msg as { source?: string }).source === 'offscreen') {
    relayFromOffscreen(msg as FromOffscreen);
    return false;
  }
  // Only our own extension pages and content scripts can reach this listener.
  if (sender.id !== chrome.runtime.id) return false;
  const fromExtensionPage = (sender.url ?? '').startsWith(chrome.runtime.getURL(''));
  const p = fromExtensionPage ? handleUi(msg as UiToBackground) : handleContent(msg as ContentToBackground, sender);
  p.then(sendResponse, (e) => sendResponse({ error: toAppError(e).toJSON() }));
  return true;
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'ait-translate-image', title: 'Перевести изображение', contexts: ['image'] });
    chrome.contextMenus.create({ id: 'ait-translate-page', title: 'Перевести все картинки на странице', contexts: ['page'] });
    chrome.contextMenus.create({ id: 'ait-select-area', title: 'Перевести область экрана', contexts: ['page', 'image'] });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (tab?.id === undefined) return;
  if (info.menuItemId === 'ait-translate-image' && info.srcUrl) sendToTab(tab.id, { type: 'translate-src', src: info.srcUrl });
  else if (info.menuItemId === 'ait-translate-page') sendToTab(tab.id, { type: 'command', command: 'translate-page' });
  else if (info.menuItemId === 'ait-select-area') sendToTab(tab.id, { type: 'command', command: 'select-area' });
});

chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) return;
  if (command === 'translate-page' || command === 'select-area' || command === 'toggle-original') sendToTab(tab.id, { type: 'command', command });
});

chrome.tabs.onRemoved.addListener((tabId) => running.delete(tabId));
