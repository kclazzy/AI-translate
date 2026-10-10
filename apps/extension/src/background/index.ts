import '@ait/core/i18n/all';
import { AppError, checkReadiness, dataUrlToBytes, isOllama, ollamaUnloadAll, readinessText, toAppError, type Readiness } from '@ait/core';
import { PAGE_PORT, type BackgroundToContent, type ContentToBackground, type FromOffscreen, type ImageRef, type JobStatus, type OffscreenFailure, type ToOffscreen, type UiToBackground, type UiStrings } from '../shared/messages';
import { deleteJobBytes, hashBytes, putJobBytes } from '../shared/jobstore';
import { hostOf, loadSettings, saveSettings } from '../shared/store';
import { dictionaryFor, setUiLang, tr, uiLang } from '@ait/core/i18n';

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
/** Bigger pictures are refused with a clear reason (they would also not fit in browser messages). */
const MAX_FETCH_BYTES = 40 * 1024 * 1024;
let creating: Promise<void> | null = null;
const running = new Map<number, Set<string>>();

// The job counts on the toolbar badge survive the service worker being stopped while idle.
let saveRunningTimer: ReturnType<typeof setTimeout> | null = null;
function saveRunning() {
  if (saveRunningTimer) return;
  saveRunningTimer = setTimeout(() => {
    saveRunningTimer = null;
    const data = Object.fromEntries([...running].filter(([, s]) => s.size).map(([t, s]) => [t, [...s]]));
    void chrome.storage.session?.set({ running: data }).catch(() => undefined);
  }, 200);
}
const runningRestored = (async () => {
  try {
    const { running: saved } = (await chrome.storage.session.get('running')) as { running?: Record<string, string[]> };
    for (const [t, ids] of Object.entries(saved ?? {})) {
      const set = running.get(Number(t)) ?? new Set<string>();
      for (const id of ids) set.add(id);
      running.set(Number(t), set);
    }
  } catch {
    /* no session storage */
  }
})();

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
    // The document may exist but not listen yet (just created, or being recreated after the
    // browser closed it): retry for a few seconds instead of failing the picture.
    for (let attempt = 0; ; attempt++) {
      await ensureOffscreen();
      let r: unknown;
      try {
        r = await chrome.runtime.sendMessage(msg);
      } catch (e) {
        if (attempt >= 30 || !/Receiving end does not exist|Could not establish connection|message port closed/i.test(String(e))) throw e;
        await new Promise((res) => setTimeout(res, 150));
        continue;
      }
      // The worker failed: an error, not a result.
      if (r && typeof r === 'object' && '__aitError' in r) throw toAppError((r as OffscreenFailure).__aitError);
      return r as T;
    }
  }
  const { handleOffscreen } = await import('../offscreen/handler');
  return (await handleOffscreen(msg, relayFromOffscreen)) as T;
}

function sendToTab(tabId: number, msg: BackgroundToContent): void {
  void chrome.tabs.sendMessage(tabId, msg).catch(() => undefined);
}

function setBadge(tabId: number) {
  const n = running.get(tabId)?.size ?? 0;
  if (n) {
    void chrome.action.setBadgeBackgroundColor({ tabId, color: '#c8205f' }).catch(() => undefined);
    void chrome.action.setBadgeText({ tabId, text: String(n) }).catch(() => undefined);
    return;
  }
  // null (not '') hands the tab back to the global badge, so "OFF" shows on every tab. Older
  // browsers reject null (synchronously): then clear the tab's own text instead.
  try {
    void chrome.action.setBadgeText({ tabId, text: null as unknown as string }).catch(() => undefined);
  } catch {
    void chrome.action.setBadgeText({ tabId, text: '' }).catch(() => undefined);
  }
}

function track(tabId: number, jobId: string, on: boolean) {
  const set = running.get(tabId) ?? new Set<string>();
  if (on) set.add(jobId);
  else set.delete(jobId);
  if (set.size) running.set(tabId, set);
  else running.delete(tabId);
  setBadge(tabId);
  saveRunning();
}

/**
 * A stored result changed (edited, or fixed by the batched translation check): every tab gets the
 * key and the page that shows that result fetches it again (others ignore it — the key is a hash
 * of the picture, so no page learns anything it does not show).
 */
async function broadcastResultChanged(key: string): Promise<void> {
  const tabs = await chrome.tabs.query({}).catch(() => [] as chrome.tabs.Tab[]);
  for (const t of tabs) if (t.id !== undefined) sendToTab(t.id, { type: 'result-changed', key });
}

function relayFromOffscreen(m: FromOffscreen) {
  if (m.type === 'result-changed') {
    void broadcastResultChanged(m.key);
    return;
  }
  if (m.type === 'save') {
    // Only files the worker made itself (blob: URLs of this extension).
    if (!m.url.startsWith(`blob:${chrome.runtime.getURL('').replace(/\/$/, '')}`)) return;
    // Some systems accept only Latin file names: transliterate each folder name if refused.
    const latin = m.filename.split('/').map((x) => translit(x).replace(/[^A-Za-z0-9 ._,()-]+/g, ' ').replace(/\s+/g, ' ').trim() || 'page').join('/');
    void chrome.downloads
      .download({ url: m.url, filename: m.filename, saveAs: false, conflictAction: 'uniquify' })
      .catch(() => chrome.downloads.download({ url: m.url, filename: latin, saveAs: false, conflictAction: 'uniquify' }))
      .catch((e) => dlog('auto-save failed', m.filename, e));
    return;
  }
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

// ---- image fetching ----------------------------------------------------------------------------

/** Session rules from 1000 up are ours (Referer for picture requests); older ones are left-overs. */
const RULE_MIN = 1000;
const RULE_SPAN = 2_000_000_000;
/** A worker stopped mid-fetch leaves its rule behind (session rules outlive the worker): clear them. */
const rulesReady: Promise<void> = (async () => {
  const dnr = chrome.declarativeNetRequest;
  if (!dnr?.getSessionRules) return;
  const ids = (await dnr.getSessionRules()).map((r) => r.id).filter((id) => id >= RULE_MIN);
  if (ids.length) await dnr.updateSessionRules({ removeRuleIds: ids });
})().catch((e) => dlog('stale rules not cleared', e));

/**
 * One Referer rule per picture host at a time: requests to the same host from two pages with
 * different Referers wait for each other instead of getting each other's header.
 */
interface RefererRule {
  referer: string;
  id: number;
  users: number;
  ready: Promise<void>;
  done: Promise<void>;
  release: () => void;
}
const refererRules = new Map<string, RefererRule>();

async function acquireReferer(host: string, referer: string): Promise<RefererRule | null> {
  const dnr = chrome.declarativeNetRequest;
  if (!dnr?.updateSessionRules) return null;
  await rulesReady;
  for (;;) {
    const cur = refererRules.get(host);
    if (!cur) break;
    if (cur.referer === referer) {
      cur.users++;
      await cur.ready;
      return cur;
    }
    await cur.done;
  }
  let release!: () => void;
  const done = new Promise<void>((r) => (release = r));
  const id = RULE_MIN + Math.floor(Math.random() * RULE_SPAN);
  const rule: RefererRule = { referer, id, users: 1, ready: Promise.resolve(), done, release };
  rule.ready = dnr.updateSessionRules({
    addRules: [
      {
        id,
        priority: 1,
        action: { type: dnr.RuleActionType.MODIFY_HEADERS, requestHeaders: [{ header: 'referer', operation: dnr.HeaderOperation.SET, value: referer }] },
        condition: {
          requestDomains: [host],
          initiatorDomains: [new URL(chrome.runtime.getURL('')).host],
          // Only requests made by the extension itself outside any tab (this worker's fetch).
          tabIds: [-1],
          resourceTypes: [dnr.ResourceType.XMLHTTPREQUEST, dnr.ResourceType.OTHER],
        },
      },
    ],
  });
  refererRules.set(host, rule);
  try {
    await rule.ready;
  } catch (e) {
    refererRules.delete(host);
    release();
    throw e;
  }
  return rule;
}

function releaseReferer(host: string, rule: RefererRule) {
  if (--rule.users > 0) return;
  void chrome.declarativeNetRequest
    .updateSessionRules({ removeRuleIds: [rule.id] })
    .catch(() => undefined)
    .finally(() => {
      if (refererRules.get(host) === rule) refererRules.delete(host);
      rule.release();
    });
}

/** Addresses inside the user's own network (router, NAS, local servers). */
function isPrivateHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || /\.(localhost|local|lan|internal|home\.arpa)$/.test(h)) return true;
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (h.includes(':')) return h === '::1' || h === '::' || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h) || /^::ffff:(7f|a|c0a8|ac1)/.test(h);
  // A name without dots (http://nas/) only exists inside a local network.
  return !h.includes('.');
}

/** The "site" of a host (registrable domain, approximately: no public-suffix list in the extension). */
function siteOf(host: string): string {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (/^[\d.]+$/.test(h) || h.includes(':')) return h;
  const parts = h.split('.');
  if (parts.length <= 2) return h;
  const tld = parts[parts.length - 1];
  const second = parts[parts.length - 2];
  // co.uk, com.au, ne.jp, or.kr… keep three labels.
  const n = tld.length === 2 && /^(co|com|net|org|gov|edu|ac|or|ne|go|gr|lg|ad|ed|mil|nom)$/.test(second) ? 3 : 2;
  return parts.slice(-n).join('.');
}

/** Read a response body, refusing it as soon as it grows past the limit. */
async function readCapped(res: Response): Promise<Uint8Array> {
  const tooBig = () => new AppError('IMAGE_TOO_LARGE', { retryable: false, detail: tr('Картинка больше {0} МБ — такую не перевести.', MAX_FETCH_BYTES / 1024 / 1024) });
  if (!res.body) {
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length > MAX_FETCH_BYTES) throw tooBig();
    return buf;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    got += value.length;
    if (got > MAX_FETCH_BYTES) {
      void reader.cancel().catch(() => undefined);
      throw tooBig();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(got);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/**
 * Fetch an image as the page would: with the page as Referer (hotlink protection), and with cookies
 * only when the picture is on the page's own site. Addresses inside the local network are fetched
 * only for a page on that same address (a site cannot use the extension to read the user's router).
 */
async function fetchImage(src: string, pageUrl: string): Promise<{ bytes: Uint8Array; mime: string }> {
  if (src.startsWith('data:')) return dataUrlToBytes(src);
  let url: URL;
  try {
    url = new URL(src);
  } catch {
    throw new AppError('IMAGE_FETCH_FAILED', { retryable: false, detail: 'Bad image URL' });
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new AppError('IMAGE_FETCH_FAILED', { retryable: false, detail: `Unsupported scheme ${url.protocol}` });
  const pageHost = hostOf(pageUrl);
  if (isPrivateHost(url.hostname) && url.hostname !== pageHost) {
    throw new AppError('IMAGE_FETCH_FAILED', { retryable: false, detail: tr('Картинка лежит во внутренней сети, а страница — нет: такую картинку расширение не загружает.') });
  }
  const sameSite = !!pageHost && siteOf(url.hostname) === siteOf(pageHost);
  const rule = pageUrl.startsWith('http') ? await acquireReferer(url.hostname, pageUrl) : null;
  try {
    const res = await fetch(url.href, { credentials: sameSite ? 'include' : 'omit', cache: 'force-cache' });
    if (!res.ok) throw new AppError('IMAGE_FETCH_FAILED', { detail: `HTTP ${res.status}` });
    const len = Number(res.headers.get('content-length') ?? 0);
    if (len > MAX_FETCH_BYTES) throw new AppError('IMAGE_TOO_LARGE', { retryable: false, detail: tr('Картинка больше {0} МБ — такую не перевести.', MAX_FETCH_BYTES / 1024 / 1024) });
    const bytes = await readCapped(res);
    return { bytes, mime: res.headers.get('content-type') ?? '' };
  } finally {
    if (rule) releaseReferer(url.hostname, rule);
  }
}

// ---- screenshots -------------------------------------------------------------------------------

/** Browsers allow about two captures a second: take them one after another, spaced out. */
const CAPTURE_GAP_MS = 550;
let captureChain: Promise<unknown> = Promise.resolve();
let lastCapture = 0;

/**
 * Screenshot of the picture `imageId` in tab `tabId`. Only when that tab is the one on screen (the
 * active tab of a focused window): otherwise the screenshot would show another tab. The page hides
 * our overlays over the picture and measures it again right before the shot.
 */
function captureFor(tabId: number, windowId: number, imageId: string): Promise<{ shot: string; rect: { x: number; y: number; width: number; height: number }; dpr: number }> {
  const run = async () => {
    const wait = lastCapture + CAPTURE_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const onScreen = async () => {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      const win = chrome.windows?.get ? await chrome.windows.get(windowId).catch(() => null) : { focused: true };
      return !!tab?.active && tab.windowId === windowId && !!win?.focused;
    };
    if (!(await onScreen())) throw new AppError('IMAGE_FETCH_FAILED', { retryable: true, detail: tr('Картинку можно перевести только снимком экрана, а вкладка не на экране. Откройте вкладку и нажмите «Повторить».') });
    const prep = (await chrome.tabs.sendMessage(tabId, { type: 'prepare-capture', id: imageId } satisfies BackgroundToContent).catch(() => null)) as { rect: { x: number; y: number; width: number; height: number }; dpr: number } | null;
    if (!prep) throw new AppError('IMAGE_FETCH_FAILED', { retryable: true, detail: tr('Картинку можно перевести только снимком экрана, а она видна не целиком. Прокрутите к ней и нажмите «Повторить».') });
    try {
      // The user may have switched tabs while the page was getting ready.
      if (!(await onScreen())) throw new AppError('IMAGE_FETCH_FAILED', { retryable: true, detail: tr('Картинку можно перевести только снимком экрана, а вкладка не на экране. Откройте вкладку и нажмите «Повторить».') });
      const shot = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
      return { shot, ...prep };
    } finally {
      lastCapture = Date.now();
      sendToTab(tabId, { type: 'end-capture', id: imageId });
    }
  };
  const p = captureChain.then(run, run);
  captureChain = p.catch(() => undefined);
  return p;
}

/** Bytes go to the job store; the worker gets their id and hash (see ToOffscreen 'run'). */
async function stash(jobId: string, bytes: Uint8Array, mime: string): Promise<{ blobId: string; hash: string }> {
  const blobId = `${jobId}#${Date.now().toString(36)}`;
  const [hash] = await Promise.all([hashBytes(bytes), putJobBytes(blobId, bytes, mime)]);
  return { blobId, hash };
}

async function handleContent(msg: ContentToBackground, sender: chrome.runtime.MessageSender): Promise<unknown> {
  const tabId = sender.tab?.id;
  const windowId = sender.tab?.windowId;
  if (tabId === undefined || windowId === undefined) return null;
  // The page shown in the tab (a reload or a new page in it is another one; Firefox has no id).
  const doc = sender.documentId ?? '';
  switch (msg.type) {
    case 'translate': {
      const jobId = `${tabId}|${msg.image.id}`;
      if ((await loadSettings()).enabled === false) {
        sendToTab(tabId, { type: 'job-error', id: msg.image.id, error: OFF_ERROR().toJSON() });
        return { queued: false };
      }
      // Redrawing pictures already translated (new text size) comes from the cache: no model needed.
      const ready = msg.redraw ? { ok: true as const } : await readiness();
      if (!ready.ok) {
        sendToTab(tabId, { type: 'job-error', id: msg.image.id, error: new AppError('SETUP_NEEDED', { retryable: false, detail: readinessText(ready) }).toJSON() });
        void offerSetup(tabId);
        return { queued: false };
      }
      track(tabId, jobId, true);
      let blobId = '';
      try {
        let bytes: Uint8Array | null = null;
        let mime = '';
        if (msg.image.dataUrl) ({ bytes, mime } = dataUrlToBytes(msg.image.dataUrl));
        else if (msg.image.src) {
          try {
            ({ bytes, mime } = await fetchImage(msg.image.src, msg.pageUrl));
          } catch (e) {
            // Too big stays too big on screen; anything else: try what is on screen.
            if (!msg.image.rect || (e instanceof AppError && e.code === 'IMAGE_TOO_LARGE')) throw e;
          }
        }
        if (!bytes) {
          if (!msg.image.rect) throw new AppError('IMAGE_FETCH_FAILED', { retryable: false });
          // Protected reader (canvas, blob, blocked hotlink): translate what is on screen.
          const { shot, rect, dpr } = await captureFor(tabId, windowId, msg.image.id);
          await toOffscreen({ target: 'offscreen', type: 'crop-run', jobId, tabId, doc, screenshot: shot, rect, dpr, pageUrl: msg.pageUrl, title: msg.title, generic: false, priority: msg.priority });
          return { queued: true, captured: true };
        }
        const stashed = await stash(jobId, bytes, mime);
        blobId = stashed.blobId;
        await toOffscreen({ target: 'offscreen', type: 'run', jobId, tabId, doc, blobId, hash: stashed.hash, mime, pageUrl: msg.pageUrl, title: msg.title, priority: msg.priority, force: msg.force, imageSrc: msg.image.src });
        return { queued: true };
      } catch (e) {
        dlog('translate failed', e);
        if (blobId) void deleteJobBytes(blobId);
        track(tabId, jobId, false);
        sendToTab(tabId, { type: 'job-error', id: msg.image.id, error: toAppError(e).toJSON() });
        return { queued: false };
      }
    }
    case 'translate-strip': {
      // Neighbouring pictures of one strip: fetch them all and translate them as one page.
      const one = (image: ImageRef) => handleContent({ type: 'translate', image, pageUrl: msg.pageUrl, title: msg.title, priority: msg.priority, force: msg.force, redraw: msg.redraw }, sender);
      const settings = await loadSettings();
      if (settings.enabled === false || (!msg.redraw && !(await readiness()).ok) || msg.images.length < 2) {
        for (const image of msg.images) void one(image);
        return { queued: false };
      }
      const jobIds = msg.images.map((im) => `${tabId}|${im.id}`);
      for (const j of jobIds) track(tabId, j, true);
      const parts: { blobId: string; hash: string; mime?: string; src?: string }[] = [];
      try {
        for (const [i, image] of msg.images.entries()) {
          let got: { bytes: Uint8Array; mime: string } | null = null;
          if (image.dataUrl) got = dataUrlToBytes(image.dataUrl);
          else if (image.src) got = await fetchImage(image.src, msg.pageUrl).catch(() => null);
          if (!got) throw new Error('fetch');
          parts.push({ ...(await stash(jobIds[i], got.bytes, got.mime)), mime: got.mime, src: image.src });
        }
      } catch {
        // A picture that cannot be fetched (protected reader): each one on its own, as before.
        for (const p of parts) void deleteJobBytes(p.blobId);
        for (const j of jobIds) track(tabId, j, false);
        for (const image of msg.images) void one(image);
        return { queued: false };
      }
      try {
        await toOffscreen({ target: 'offscreen', type: 'run-strip', jobIds, tabId, doc, parts, pageUrl: msg.pageUrl, title: msg.title, priority: msg.priority, force: msg.force });
      } catch (e) {
        dlog('strip failed', e);
        for (const p of parts) void deleteJobBytes(p.blobId);
        const error = toAppError(e).toJSON();
        for (const [i, j] of jobIds.entries()) {
          track(tabId, j, false);
          sendToTab(tabId, { type: 'job-error', id: msg.images[i].id, error });
        }
        return { queued: false };
      }
      return { queued: true };
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
        const { shot, rect, dpr } = await captureFor(tabId, windowId, msg.image.id);
        await toOffscreen({ target: 'offscreen', type: 'crop-run', jobId, tabId, doc, screenshot: shot, rect, dpr, pageUrl: msg.pageUrl, title: msg.title, generic: true });
        return { queued: true };
      } catch (e) {
        track(tabId, jobId, false);
        sendToTab(tabId, { type: 'job-error', id: msg.image.id, error: toAppError(e).toJSON() });
        return { queued: false };
      }
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
      applyLang(s.interfaceLang);
      return { autoTranslate: s.autoTranslate.enabled || s.autoTranslate.sites.includes(msg.host), minImageSize: s.minImageSize, enabled: s.enabled !== false, targetLang: s.targetLang, stitch: s.stitchStrips !== false, ui: uiStrings() };
    }
    case 'build-download': {
      const s = await loadSettings();
      const r = await toOffscreen<{ url: string; name: string; pages: number; size: number }>({ target: 'offscreen', type: 'build-file', keys: msg.keys, title: msg.title, format: msg.format, lang: s.targetLang });
      if (!r?.url) throw new AppError('UNKNOWN', { retryable: false, detail: 'build failed' });
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
    case 'lookup-cached': {
      const s = await loadSettings();
      if (s.enabled === false || s.autoApplyCached === false || !msg.srcs.length) return {};
      return toOffscreen<Record<string, string>>({ target: 'offscreen', type: 'lookup-cached', srcs: msg.srcs });
    }
    case 'free-memory': {
      // Unload every local model from video memory; the next picture loads only the one it needs.
      const s = await loadSettings();
      const urls = new Set(s.providers.filter((p) => isOllama(p)).map((p) => p.baseUrl));
      for (const u of urls) await ollamaUnloadAll(u).catch(() => undefined);
      return { ok: true };
    }
    case 'lama-offer': {
      // Offered only where LaMa can run in this browser, while it is off and the user did not refuse it.
      const s = await loadSettings();
      const mode = s.lamaMode ?? (s.lamaEngine ? 'engine' : 'off');
      return { offer: lamaSupported() && mode === 'off' && !s.lamaOfferDismissed };
    }
    case 'lama-offer-answer': {
      if (msg.accept) {
        await chrome.tabs.create({ url: chrome.runtime.getURL('studio.html?view=settings&offer=lama'), index: (sender.tab?.index ?? 0) + 1 });
      } else {
        const s = await loadSettings();
        await saveSettings({ ...s, lamaOfferDismissed: true });
      }
      return null;
    }
    case 'open-editor':
      await chrome.tabs.create({ url: chrome.runtime.getURL(`studio.html?key=${encodeURIComponent(msg.key)}${msg.chapter?.length ? `&chapter=${msg.chapter.map(encodeURIComponent).join(',')}` : ''}`), index: (sender.tab?.index ?? 0) + 1 });
      return null;
    case 'get-result':
      return toOffscreen({ target: 'offscreen', type: 'get-result', key: msg.key });
    case 'get-tile':
      return toOffscreen({ target: 'offscreen', type: 'get-tile', key: msg.key, index: msg.index });
  }
}

/** LaMa runs in the extension pages (ONNX Runtime on WebAssembly / WebGPU, model kept in the Cache API). */
function lamaSupported(): boolean {
  return typeof caches !== 'undefined' && typeof WebAssembly !== 'undefined';
}

/** The interface dictionary for content scripts (they carry none to stay small). */
function uiStrings(): UiStrings {
  const lang = uiLang();
  return { lang, dict: lang === 'ru' ? {} : dictionaryFor(lang) ?? {} };
}

/** Follow the language from the settings; the context menu is re-labelled when it changes. */
let menusLang = '';
function applyLang(pref: string | undefined): void {
  setUiLang(pref, false);
  if (menusLang !== uiLang()) createMenus();
}

function createMenus(): void {
  menusLang = uiLang();
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'ait-translate-image', title: tr('Перевести изображение'), contexts: ['image'] });
    chrome.contextMenus.create({ id: 'ait-translate-page', title: tr('Перевести все картинки на странице'), contexts: ['page'] });
    chrome.contextMenus.create({ id: 'ait-select-area', title: tr('Перевести область экрана'), contexts: ['page', 'image'] });
  });
}

async function broadcastState() {
  const s = await loadSettings();
  applyLang(s.interfaceLang);
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) {
    if (t.id === undefined) continue;
    const host = hostOf(t.url);
    sendToTab(t.id, { type: 'state', autoTranslate: s.autoTranslate.enabled || s.autoTranslate.sites.includes(host), minImageSize: s.minImageSize, enabled: s.enabled !== false, targetLang: s.targetLang, stitch: s.stitchStrips !== false, ui: uiStrings() });
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
    const busyTabs = [...running.keys()];
    running.clear();
    saveRunning();
    for (const t of busyTabs) setBadge(t);
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

const OFF_ERROR = () => new AppError('DISABLED', { retryable: false, detail: tr('AI Translate выключен. Включите его в окне расширения (значок на панели).') });

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
      saveRunning();
      return toOffscreen({ target: 'offscreen', type: 'cancel-tab', tabId: msg.tabId });
    }
    case 'result-changed':
      await broadcastResultChanged(msg.key);
      return null;
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return false;
  dlog('message', (msg as { type?: string }).type, sender.url);
  if ((msg as { target?: string }).target === 'offscreen') return false; // for the offscreen document
  // Only our own extension pages and content scripts can reach this listener.
  if (sender.id !== chrome.runtime.id) return false;
  if ((msg as { source?: string }).source === 'offscreen') {
    // Worker reports come only from the offscreen document (in Firefox the worker runs right here
    // and reports by a direct call, never by message).
    if (chrome.offscreen && !sender.tab && (sender.url ?? '').startsWith(chrome.runtime.getURL(OFFSCREEN_URL))) relayFromOffscreen(msg as FromOffscreen);
    else dlog('rejected worker report from', sender.url);
    return false;
  }
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
  // First install: a short welcome page with the first steps.
  if (details.reason === 'install') void chrome.tabs.create({ url: chrome.runtime.getURL('studio.html?view=welcome') });
  // After an in-app update: show the settings page with a confirmation.
  if (details.reason === 'update') {
    void chrome.storage.local.get('justUpdated').then(({ justUpdated }) => {
      if (!justUpdated) return;
      void chrome.storage.local.remove('justUpdated');
      void chrome.tabs.create({ url: chrome.runtime.getURL(`studio.html?view=settings&updated=${encodeURIComponent((justUpdated as { to: string }).to)}`) });
    });
  }
  void loadSettings().then((s) => {
    setUiLang(s.interfaceLang, false);
    createMenus();
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

// A page with pictures in work keeps a port open (content script). When the page goes away —
// tab closed, reload, another page in the tab — the port closes and its pictures leave the queue.
// This works after the service worker was stopped and started again, unlike in-memory bookkeeping.
const cancelPage = (tabId: number, doc?: string) => {
  const set = running.get(tabId);
  if (set && !doc) {
    running.delete(tabId);
    setBadge(tabId);
    saveRunning();
  }
  void toOffscreen({ target: 'offscreen', type: 'cancel-tab', tabId, doc }).catch(() => undefined);
};
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PAGE_PORT || port.sender?.id !== chrome.runtime.id) return;
  const tabId = port.sender.tab?.id;
  if (tabId === undefined) return;
  const doc = port.sender.documentId;
  let idle = false;
  port.onMessage.addListener((m: { type?: string }) => {
    // 'ping' only keeps the worker awake while pictures are in work; 'idle' comes right before a
    // deliberate close (nothing left in work).
    if (m?.type === 'idle') idle = true;
  });
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    if (!idle) cancelPage(tabId, doc);
  });
});
chrome.tabs.onRemoved.addListener((tabId) => {
  // Nothing to stop unless this tab had work (the worker is not woken up for every closed tab).
  void runningRestored.then(() => running.get(tabId)?.size && cancelPage(tabId));
});

// Show the on/off state on the icon after the browser or the extension starts.
void loadSettings().then((s) => {
  setUiLang(s.interfaceLang, false);
  showEnabled(s.enabled !== false);
});
