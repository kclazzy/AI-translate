import { AppError, bytesToBase64, checkReadiness, dataUrlToBytes, isOllama, ollamaUnloadAll, readinessText, toAppError, type Readiness } from '@ait/core';
import type { BackgroundToContent, ContentToBackground, FromOffscreen, JobStatus, ToOffscreen, UiToBackground } from '../shared/messages';
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
            condition: { requestDomains: [url.hostname], initiatorDomains: [new URL(chrome.runtime.getURL('')).host], resourceTypes: [chrome.declarativeNetRequest.ResourceType.XMLHTTPREQUEST, chrome.declarativeNetRequest.ResourceType.OTHER] },
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
      if ((await loadSettings()).enabled === false) {
        sendToTab(tabId, { type: 'job-error', id: msg.image.id, error: OFF_ERROR().toJSON() });
        return { queued: false };
      }
      const ready = await readiness();
      if (!ready.ok) {
        sendToTab(tabId, { type: 'job-error', id: msg.image.id, error: new AppError('SETUP_NEEDED', { retryable: false, detail: readinessText(ready) }).toJSON() });
        void offerSetup(tabId);
        return { queued: false };
      }
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
      if ((await loadSettings()).enabled === false) {
        sendToTab(tabId, { type: 'job-error', id: msg.image.id, error: OFF_ERROR().toJSON() });
        return { queued: false };
      }
      const readyArea = await readiness();
      if (!readyArea.ok) {
        sendToTab(tabId, { type: 'job-error', id: msg.image.id, error: new AppError('SETUP_NEEDED', { retryable: false, detail: readinessText(readyArea) }).toJSON() });
        void offerSetup(tabId);
        return { queued: false };
      }
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
    case 'status': {
      const res = await toOffscreen<Record<string, JobStatus>>({ target: 'offscreen', type: 'status', jobIds: msg.ids.map((id) => `${tabId}|${id}`) });
      return Object.fromEntries(msg.ids.map((id) => [id, res?.[`${tabId}|${id}`] ?? { state: 'unknown' }]));
    }
    case 'cancel':
      track(tabId, `${tabId}|${msg.id}`, false);
      return toOffscreen({ target: 'offscreen', type: 'cancel', jobId: `${tabId}|${msg.id}` });
    case 'get-page-state': {
      const s = await loadSettings();
      return { autoTranslate: s.autoTranslate.enabled || s.autoTranslate.sites.includes(msg.host), minImageSize: s.minImageSize, enabled: s.enabled !== false, targetLang: s.targetLang };
    }
    case 'build-download': {
      const s = await loadSettings();
      const r = await toOffscreen<{ url: string; name: string; pages: number; size: number } | { error: string }>({ target: 'offscreen', type: 'build-file', keys: msg.keys, title: msg.title, format: msg.format, lang: s.targetLang });
      if (!r || 'error' in r) throw new AppError('UNKNOWN', { retryable: false, detail: r && 'error' in r ? r.error : 'build failed' });
      let id: number;
      try {
        id = await chrome.downloads.download({ url: r.url, filename: r.name, saveAs: false, conflictAction: 'uniquify' });
      } catch (e) {
        // Some systems only accept Latin file names: transliterate, then fall back to a plain name.
        dlog('download name rejected', r.name, e);
        const latin = translit(r.name).replace(/[^A-Za-z0-9 ._,()-]+/g, ' ').replace(/\s+/g, ' ').trim();
        try {
          r.name = /^[ .]*\.[a-z]+$/.test(latin) ? '' : latin;
          if (!r.name) throw new Error('empty');
          id = await chrome.downloads.download({ url: r.url, filename: r.name, saveAs: false, conflictAction: 'uniquify' });
        } catch {
          r.name = `AI Translate ${new Date().toISOString().slice(0, 10)}.${msg.format}`;
          id = await chrome.downloads.download({ url: r.url, filename: r.name, saveAs: false, conflictAction: 'uniquify' });
        }
      }
      dlog('download', r.name, r.pages, r.size);
      return { ok: true, name: r.name, pages: r.pages, id };
    }
    case 'open-setup':
      readyCache = null;
      await offerSetup(tabId, true);
      return null;
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
    sendToTab(t.id, { type: 'state', autoTranslate: s.autoTranslate.enabled || s.autoTranslate.sites.includes(host), minImageSize: s.minImageSize, enabled: s.enabled !== false, targetLang: s.targetLang });
  }
  showEnabled(s.enabled !== false);
}

/** "OFF" on the toolbar icon while the extension is switched off. */
function showEnabled(on: boolean) {
  void chrome.action.setBadgeBackgroundColor({ color: on ? '#c8205f' : '#6b7280' }).catch(() => undefined);
  void chrome.action.setBadgeText({ text: on ? '' : 'OFF' }).catch(() => undefined);
}

/** Switch the extension on or off. Off: stop all work and free the video memory held by Ollama. */
async function setEnabled(enabled: boolean): Promise<{ unloaded: string[] }> {
  const s = await loadSettings();
  await saveSettings({ ...s, enabled });
  let unloaded: string[] = [];
  if (!enabled) {
    running.clear();
    await toOffscreen({ target: 'offscreen', type: 'cancel-tab' }).catch(() => undefined);
    const urls = new Set(s.providers.filter((p) => isOllama(p)).map((p) => p.baseUrl));
    for (const url of urls) unloaded = unloaded.concat(await ollamaUnloadAll(url));
    dlog('switched off, unloaded', unloaded);
  }
  await broadcastState();
  return { unloaded };
}

const TRANSLIT: Record<string, string> = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya', і: 'i', ї: 'yi', є: 'ye', ґ: 'g' };
/** Russian/Ukrainian letters → Latin, keeping capitals. */
function translit(s: string): string {
  return [...s]
    .map((ch) => {
      const lower = ch.toLowerCase();
      const t = TRANSLIT[lower];
      if (t === undefined) return ch;
      return ch !== lower && t ? t[0].toUpperCase() + t.slice(1) : t;
    })
    .join('');
}

let readyCache: { at: number; r: Readiness } | null = null;
/** Are the local programs this setup needs running? Cached briefly: it runs for every picture. */
async function readiness(): Promise<Readiness> {
  const now = Date.now();
  if (readyCache && now - readyCache.at < (readyCache.r.ok ? 30_000 : 4_000)) return readyCache.r;
  const r = await checkReadiness(await loadSettings());
  readyCache = { at: now, r };
  return r;
}

/** Open the setup helper (at most every 10 minutes unless the user asks). */
async function offerSetup(tabId: number | undefined, force = false) {
  const { setupOfferedAt } = (await chrome.storage.session.get('setupOfferedAt').catch(() => ({}))) as { setupOfferedAt?: number };
  if (!force && setupOfferedAt && Date.now() - setupOfferedAt < 10 * 60_000) return;
  await chrome.storage.session.set({ setupOfferedAt: Date.now() }).catch(() => undefined);
  await chrome.tabs.create({ url: chrome.runtime.getURL(`studio.html?view=settings&setup=1${tabId !== undefined ? `&resume=${tabId}&cmd=translate-page` : ''}`) });
}

const OFF_ERROR = () => new AppError('NOT_CONFIGURED', { retryable: false, detail: 'AI Translate выключен. Включите его в окне расширения (значок на панели).' });

async function handleUi(msg: UiToBackground): Promise<unknown> {
  switch (msg.type) {
    case 'popup-command':
      // A user command (or the setup helper continuing one) re-checks the programs right away.
      readyCache = null;
      sendToTab(msg.tabId, { type: 'command', command: msg.command, value: msg.format });
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
    case 'set-enabled':
      return setEnabled(msg.enabled);
    case 'cancel-all': {
      if (msg.tabId === undefined) running.clear();
      else running.delete(msg.tabId);
      if (msg.tabId !== undefined) setBadge(msg.tabId);
      return toOffscreen({ target: 'offscreen', type: 'cancel-tab', tabId: msg.tabId });
    }
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

/**
 * Ollama rejects requests whose Origin is chrome-extension://… unless OLLAMA_ORIGINS is set.
 * For our own requests to Ollama on this computer we present a localhost origin, which Ollama
 * allows by default — so no environment variable is needed. Only this extension's requests
 * to port 11434 on the loopback address are touched.
 */
const OLLAMA_ORIGIN_RULE_ID = 11434;
async function installOllamaOriginRule(): Promise<void> {
  const dnr = chrome.declarativeNetRequest;
  if (!dnr?.updateDynamicRules) return;
  try {
    await dnr.updateDynamicRules({
      removeRuleIds: [OLLAMA_ORIGIN_RULE_ID],
      addRules: [
        {
          id: OLLAMA_ORIGIN_RULE_ID,
          priority: 2,
          action: {
            type: dnr.RuleActionType.MODIFY_HEADERS,
            requestHeaders: [{ header: 'origin', operation: dnr.HeaderOperation.SET, value: 'http://127.0.0.1' }],
          },
          condition: {
            regexFilter: '^https?://(localhost|127\\.0\\.0\\.1|\\[::1\\]):11434/',
            // Firefox uses an internal UUID host for moz-extension:// pages, not the add-on id.
            initiatorDomains: [new URL(chrome.runtime.getURL('')).host],
            resourceTypes: [dnr.ResourceType.XMLHTTPREQUEST, dnr.ResourceType.OTHER],
          },
        },
      ],
    });
  } catch (e) {
    dlog('ollama origin rule failed', e);
  }
}
void installOllamaOriginRule();
chrome.runtime.onStartup?.addListener(() => void installOllamaOriginRule());

chrome.runtime.onInstalled.addListener((details) => {
  // After an in-app update: show the settings page with a confirmation.
  if (details.reason === 'update') {
    void chrome.storage.local.get('justUpdated').then(({ justUpdated }) => {
      if (!justUpdated) return;
      void chrome.storage.local.remove('justUpdated');
      void chrome.tabs.create({ url: chrome.runtime.getURL(`studio.html?view=settings&updated=${encodeURIComponent((justUpdated as { to: string }).to)}`) });
    });
  }
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

// Show the on/off state on the icon after the browser or the extension starts.
void loadSettings().then((s) => showEnabled(s.enabled !== false));
