import { errorMessage } from '@ait/core/errors';
import { dominantLanguage, nativeName } from '@ait/core/languages';
import type { BackgroundToContent, ChapterFormat, ContentToBackground, ImageRef, JobStatus, PageLangs, RenderedTiles } from '../shared/messages';
import { Overlay } from './overlay';
import { asCandidate, candidateAt, imgSrc, inlineData, lazySrc, markUi, scanPage, viewportRect, type Candidate } from './scanner';

/**
 * Content script: finds images, shows the hover button, runs auto-translate on
 * infinite-scroll readers, draws results over the originals and offers the
 * screen-area tool. All heavy work happens in the extension, not in the page.
 */

interface Item {
  id: string;
  cand: Candidate;
  src?: string;
  status: 'queued' | 'working' | 'done' | 'error';
  overlay: Overlay;
  /** When the background accepted the job; until then the worker may not know about it yet. */
  sentAt?: number;
  /** Consecutive status polls in which the worker did not know the job. */
  lost?: number;
  result?: RenderedTiles;
  docRect?: { x: number; y: number; width: number; height: number };
}

declare global {
  interface Window {
    __aitContentLoaded?: boolean;
  }
}

if (!window.__aitContentLoaded && window.top === window) {
  window.__aitContentLoaded = true;
  main();
}

function main() {
  const items = new Map<string, Item>();
  const byElement = new WeakMap<Element, string>();
  let minSize = 200;
  let autoTranslate = false;
  let enabled = true;
  let targetLang = 'ru';
  const langsOf = (r: RenderedTiles) => ({ source: nativeName(dominantLanguage(r.page.blocks.map((b) => b.language)) ?? 'auto') || 'Оригинал', target: nativeName(targetLang) });
  let originalsShown = false;
  let seq = 0;

  const send = <T = unknown>(msg: ContentToBackground): Promise<T> => chrome.runtime.sendMessage(msg) as Promise<T>;

  const idFor = (el: Element) => {
    let id = byElement.get(el);
    if (!id) {
      id = `i${Date.now().toString(36)}${(seq++).toString(36)}`;
      byElement.set(el, id);
    }
    return id;
  };

  // ---- translate one candidate -------------------------------------------------------------
  async function translate(c: Candidate, opts: { priority?: number; force?: boolean } = {}) {
    const id = idFor(c.el);
    const existing = items.get(id);
    if (existing && !opts.force && existing.src === (c.src ?? existing.src) && existing.status !== 'error') return;
    existing?.overlay.destroy();
    const overlay = new Overlay(() => (c.el.isConnected ? contentRect(c.el) : null), {
      onToggle: () => {
        const it = items.get(id);
        if (it) it.overlay.setOriginal(!it.overlay.showingOriginal);
      },
      onEdit: () => {
        const it = items.get(id);
        if (it?.result) void send({ type: 'open-editor', key: it.result.key });
      },
      onRetry: () => void translate(c, { priority: 50, force: true }),
      onCancel: () => {
        void send({ type: 'cancel', id });
        items.get(id)?.overlay.destroy();
        items.delete(id);
      },
    });
    const item: Item = { id, cand: c, src: c.src, status: 'queued', overlay };
    items.set(id, item);
    overlay.stage({ stage: 'queued' });
    try {
      const image: ImageRef = { id, kind: c.kind, src: c.src, dataUrl: await inlineData(c), rect: viewportRect(c.el), dpr: devicePixelRatio };
      if (image.dataUrl) image.src = undefined;
      await send({ type: 'translate', image, pageUrl: location.href, title: document.title, priority: opts.priority ?? priorityOf(c.el), force: opts.force });
      item.sentAt = Date.now();
      startWatch();
    } catch (e) {
      // Without this the overlay would say "В очереди" forever.
      if (items.get(id) !== item) return;
      item.status = 'error';
      overlay.error('Не удалось отправить картинку на перевод', e instanceof Error ? e.message : String(e));
    }
  }

  // ---- live status: queue position, elapsed time, lost jobs --------------------------------
  let watchTimer: ReturnType<typeof setInterval> | null = null;
  /** How many times a lost picture was sent again automatically. */
  const resent = new Map<string, number>();
  function startWatch() {
    watchTimer ??= setInterval(() => void pollStatus(), 3000);
  }
  const fmt = (ms: number) => {
    const sec = Math.floor(ms / 1000);
    return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
  };
  async function pollStatus() {
    const active = [...items.values()].filter((it) => (it.status === 'queued' || it.status === 'working') && it.sentAt);
    if (!active.length) {
      if (watchTimer) clearInterval(watchTimer);
      watchTimer = null;
      return;
    }
    let res: Record<string, JobStatus>;
    try {
      res = await send<Record<string, JobStatus>>({ type: 'status', ids: active.map((it) => it.id) });
    } catch {
      return; // the service worker is restarting; try again on the next tick
    }
    for (const it of active) {
      if (items.get(it.id) !== it || it.status === 'done' || it.status === 'error') continue;
      const st = res?.[it.id] ?? { state: 'unknown' };
      if (st.state === 'pending') {
        it.lost = 0;
        it.overlay.note(st.ahead ? `перед ней ${st.ahead}` : 'следующая', st.ahead > 1 ? 'Локальная модель переводит по одной картинке за раз' : undefined);
      } else if (st.state === 'running') {
        it.lost = 0;
        const slow = st.elapsedMs > 90_000;
        it.overlay.note(fmt(st.elapsedMs), slow ? 'Модель отвечает долго: проверьте её в настройках или выберите модель полегче' : undefined);
      } else if (Date.now() - (it.sentAt ?? 0) > 5000 && (it.lost = (it.lost ?? 0) + 1) >= 2) {
        // The worker restarted (the browser closed it to save memory, the extension updated)
        // and forgot the job: send the picture again by itself, twice at most.
        const tries = (resent.get(it.id) ?? 0) + 1;
        resent.set(it.id, tries);
        it.status = 'error';
        if (tries <= 2) void translate(it.cand, { priority: 40 });
        else it.overlay.error('Задача потерялась', 'Расширение несколько раз перезапускалось. Нажмите «Повторить».');
      }
    }
  }

  function priorityOf(el: Element): number {
    const r = el.getBoundingClientRect();
    if (r.bottom > 0 && r.top < innerHeight) return 10;
    const dist = r.top > innerHeight ? r.top - innerHeight : -r.bottom;
    return Math.max(-50, -Math.round(dist / 400));
  }

  function contentRect(el: Element): DOMRect {
    const r = el.getBoundingClientRect();
    if (!(el instanceof HTMLImageElement)) return r;
    // Respect padding/border so the overlay sits on the picture itself.
    const cs = getComputedStyle(el);
    const l = parseFloat(cs.paddingLeft) + parseFloat(cs.borderLeftWidth);
    const t = parseFloat(cs.paddingTop) + parseFloat(cs.borderTopWidth);
    const w = r.width - l - parseFloat(cs.paddingRight) - parseFloat(cs.borderRightWidth);
    const h = r.height - t - parseFloat(cs.paddingBottom) - parseFloat(cs.borderBottomWidth);
    return new DOMRect(r.left + l, r.top + t, w, h);
  }

  // ---- messages from the background --------------------------------------------------------
  chrome.runtime.onMessage.addListener((msg: BackgroundToContent, _sender, sendResponse) => {
    switch (msg.type) {
      case 'get-langs': {
        const done = [...items.values()].filter((it) => it.status === 'done' && it.result);
        const langs: PageLangs = {
          source: dominantLanguage(done.flatMap((it) => it.result!.page.blocks.map((b) => b.language))),
          target: targetLang,
          showingOriginal: originalsShown,
          translated: done.length,
        };
        sendResponse(langs);
        return false;
      }
      case 'job-stage': {
        const it = items.get(msg.id);
        if (it && it.status !== 'done') {
          it.status = 'working';
          it.overlay.stage(msg.event);
        }
        break;
      }
      case 'job-done': {
        const it = items.get(msg.id);
        if (!it) break;
        it.status = 'done';
        it.result = msg.result;
        it.overlay.setTiles(msg.result.tiles, langsOf(msg.result));
        it.overlay.setOriginal(originalsShown);
        {
          const qa = msg.result.page.blocks.flatMap((b) => (b.qa?.issues ?? []).map((q) => `• ${q.note}${b.qa?.before !== undefined ? ' (исправлено)' : ''}`));
          it.overlay.setQa(qa.length, qa.slice(0, 8).join('\n'));
        }
        it.overlay.position();
        break;
      }
      case 'job-error': {
        const it = items.get(msg.id);
        if (!it) break;
        if (msg.error.code === 'CANCELLED') {
          it.overlay.destroy();
          items.delete(msg.id);
          break;
        }
        it.status = 'error';
        if (msg.error.code === 'SETUP_NEEDED') {
          it.overlay.error(errorMessage(msg.error), msg.error.detail, ['Установить и запустить', () => void send({ type: 'open-setup' })]);
          break;
        }
        it.overlay.error(errorMessage(msg.error), msg.error.detail);
        break;
      }
      case 'command':
        if (!enabled && msg.command !== 'toggle-original' && msg.command !== 'set-auto') {
          toastOnce('AI Translate выключен — включите его в окне расширения');
          break;
        }
        if (msg.command === 'translate-page') translatePage();
        else if (msg.command === 'download-chapter') downloadChapter((msg.value as ChapterFormat) || 'pdf');
        else if (msg.command === 'select-area') selectArea();
        else if (msg.command === 'toggle-original') {
          originalsShown = !originalsShown;
          for (const it of items.values()) if (it.status === 'done') it.overlay.setOriginal(originalsShown);
        } else if (msg.command === 'set-auto') setAuto(!!msg.value);
        break;
      case 'translate-src': {
        const img = [...document.images].find((i) => imgSrc(i) === msg.src || i.src === msg.src);
        if (img) {
          const c = asCandidate(img, 1) ?? { el: img, kind: 'img' as const, src: msg.src };
          void translate(c, { priority: 20, force: true });
        }
        break;
      }
      case 'result-changed':
        for (const it of items.values()) {
          if (it.result?.key !== msg.key) continue;
          void send<RenderedTiles | null>({ type: 'get-result', key: msg.key }).then((r) => {
            if (r) {
              it.result = r;
              it.overlay.setTiles(r.tiles, langsOf(r));
            }
          });
        }
        break;
      case 'state':
        minSize = msg.minImageSize;
        enabled = msg.enabled;
        targetLang = msg.targetLang;
        if (!enabled) hoverBtn.style.display = 'none';
        setAuto(msg.autoTranslate);
        break;
    }
    return false;
  });

  /** «Перевести страницу» also covers pictures that load later while scrolling (until reload). */
  let pageMode = false;

  // ---- «Перевести и скачать»: the whole chapter as one file --------------------------------
  let chapter: { format: ChapterFormat; timer: ReturnType<typeof setInterval>; panel: HTMLElement; text: HTMLElement; lastChange: number; lastDone: number } | null = null;

  function downloadChapter(format: ChapterFormat) {
    if (chapter) return;
    translatePage();
    const host = document.createElement('div');
    markUi(host);
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>
      .p { position: fixed; z-index: 2147483602; right: 16px; bottom: 16px; background: #1c2230; color: #fff; font: 14px/1.35 system-ui, sans-serif;
        padding: 10px 12px; border-radius: 10px; box-shadow: 0 4px 16px rgba(0,0,0,.3); display: flex; gap: 10px; align-items: center; max-width: 360px; }
      button { all: initial; cursor: pointer; color: #fff; font: inherit; border: 1px solid #fff6; border-radius: 6px; padding: 2px 8px; }
    </style><div class="p" role="status"><span class="t"></span><button type="button">Отменить</button></div>`;
    const text = root.querySelector('.t') as HTMLElement;
    (root.querySelector('button') as HTMLButtonElement).addEventListener('click', () => {
      if (!chapter) return host.remove();
      clearInterval(chapter.timer);
      chapter = null;
      for (const it of pageItemsInOrder()) if (it.status === 'queued' || it.status === 'working') void send({ type: 'cancel', id: it.id }).catch(() => undefined);
      host.remove();
    });
    document.documentElement.appendChild(host);
    chapter = { format, timer: setInterval(() => void tickChapter(), 1000), panel: host, text, lastChange: Date.now(), lastDone: -1 };
    void tickChapter();
  }

  /** Items of the page (not screen-area results), in reading (document) order. */
  function pageItemsInOrder(): Item[] {
    return [...items.values()]
      .filter((it) => !it.docRect && it.cand.el.isConnected)
      .sort((a, b) => (a.cand.el.compareDocumentPosition(b.cand.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  }

  async function tickChapter() {
    const c = chapter;
    if (!c) return;
    const list = pageItemsInOrder();
    const done = list.filter((it) => it.status === 'done').length;
    const failed = list.filter((it) => it.status === 'error').length;
    const pending = list.length - done - failed;
    if (done + failed !== c.lastDone) {
      c.lastDone = done + failed;
      c.lastChange = Date.now();
    }
    const label = c.format.toUpperCase();
    c.text.textContent = `Глава → ${label}: готово ${done} из ${list.length}${failed ? `, не удалось ${failed}` : ''}`;
    // Everything finished (or nothing moved for 15 minutes): build the file from what is ready.
    const stalled = Date.now() - c.lastChange > 15 * 60_000;
    if (list.length && (pending === 0 || stalled)) {
      clearInterval(c.timer);
      const keys = list.filter((it) => it.status === 'done' && it.result).map((it) => it.result!.key);
      if (!keys.length) {
        c.text.textContent = 'Ни одна картинка не переведена — файл не создан.';
        chapter = null;
        setTimeout(() => c.panel.remove(), 8000);
        return;
      }
      c.text.textContent = `Собираю ${label}: ${keys.length} стр.…`;
      try {
        const r = await send<{ ok: boolean; name: string; pages: number; error?: { detail?: string } }>({ type: 'build-download', keys, title: document.title, format: c.format });
        if (!r?.ok) throw new Error(r?.error?.detail ?? 'не удалось собрать файл');
        c.text.textContent = `Скачано: ${r.name}${failed ? ` (без ${failed} непереведённых картинок)` : ''}`;
      } catch (e) {
        c.text.textContent = `Не удалось собрать файл: ${e instanceof Error ? e.message : String(e)}`;
      }
      chapter = null;
      setTimeout(() => c.panel.remove(), 12_000);
    }
  }

  function translatePage() {
    pageMode = true;
    const cands = scanPage(minSize);
    if (!cands.length) toastOnce('На странице не найдено подходящих изображений');
    // Pictures on screen first, then the rest of the chapter in reading order.
    for (const c of cands) void translate(c);
  }

  // ---- auto translate (infinite scroll) ----------------------------------------------------
  const io = new IntersectionObserver(
    (entries) => {
      if (!autoTranslate) return;
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const c = asCandidate(e.target, minSize);
        if (c) void translate(c);
      }
    },
    { rootMargin: '150% 0px 150% 0px' },
  );
  const observed = new WeakSet<Element>();
  let rescanTimer: ReturnType<typeof setTimeout> | null = null;

  function rescan() {
    if (rescanTimer) clearTimeout(rescanTimer);
    rescanTimer = setTimeout(() => {
      // Lazy loaders swap src: drop stale overlays so the new image gets translated.
      for (const [id, it] of items) {
        if (it.docRect) continue; // screen-area results are not tied to an element
        if (!it.cand.el.isConnected) {
          it.overlay.destroy();
          items.delete(id);
          continue;
        }
        if (it.cand.kind === 'img') {
          const el = it.cand.el as HTMLImageElement;
          const now = imgSrc(el);
          // A lazy picture still showing its placeholder is the same picture.
          if (it.src && now && now !== it.src && !lazySrc(el)) {
            it.overlay.destroy();
            items.delete(id);
          }
        }
      }
      if (!autoTranslate && !pageMode) return;
      if (!enabled) return;
      for (const c of scanPage(minSize)) {
        if (pageMode) {
          const known = byElement.get(c.el);
          if (!known || !items.has(known)) void translate(c);
          continue;
        }
        if (!observed.has(c.el)) {
          observed.add(c.el);
          io.observe(c.el);
        }
        const id = byElement.get(c.el);
        if (!id || !items.has(id)) {
          const r = c.el.getBoundingClientRect();
          if (r.bottom > -innerHeight && r.top < innerHeight * 2.5) void translate(c);
        }
      }
    }, 250);
  }

  const mo = new MutationObserver((muts) => {
    if (muts.some((m) => !(m.target instanceof Element) || !m.target.closest('[data-ait-ui]'))) rescan();
  });
  mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'srcset', 'style', 'data-src'] });
  document.addEventListener('load', (e) => e.target instanceof HTMLImageElement && rescan(), true);

  function setAuto(on: boolean) {
    autoTranslate = on && enabled;
    if (autoTranslate) rescan();
  }

  // ---- keep overlays aligned ----------------------------------------------------------------
  let raf = 0;
  const reposition = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      for (const it of items.values()) it.overlay.position();
    });
  };
  addEventListener('scroll', reposition, { capture: true, passive: true });
  addEventListener('resize', reposition, { passive: true });
  setInterval(reposition, 500);

  // ---- hover button -------------------------------------------------------------------------
  const hoverHost = document.createElement('div');
  markUi(hoverHost);
  const hroot = hoverHost.attachShadow({ mode: 'closed' });
  hroot.innerHTML = `<style>
    button { all: initial; position: fixed; z-index: 2147483601; display: none; font: 600 14px/1 system-ui, sans-serif; background: #c8205f; color: #fff;
      border: 2px solid #1c2230; border-radius: 999px; padding: 7px 14px; cursor: pointer; box-shadow: 2px 2px 0 #1c2230; }
    button:hover { transform: translate(-1px,-1px); box-shadow: 3px 3px 0 #1c2230; }
  </style><button type="button" aria-label="Перевести изображение">Перевести</button>`;
  const hoverBtn = hroot.querySelector('button')!;
  document.documentElement.appendChild(hoverHost);
  let hoverCand: Candidate | null = null;
  let lastMove = 0;
  let hideTimer: ReturnType<typeof setTimeout> | null = null;
  addEventListener(
    'mousemove',
    (e) => {
      const now = performance.now();
      if (now - lastMove < 120) return;
      lastMove = now;
      if (!enabled || e.composedPath().includes(hoverHost)) return;
      const c = candidateAt(e.clientX, e.clientY, minSize);
      const id = c ? byElement.get(c.el) : undefined;
      if (!c || (id && items.has(id))) {
        if (hoverCand && !hideTimer) hideTimer = setTimeout(() => ((hoverBtn.style.display = 'none'), (hoverCand = null), (hideTimer = null)), 600);
        return;
      }
      if (hideTimer) {
        clearTimeout(hideTimer);
        hideTimer = null;
      }
      hoverCand = c;
      const r = c.el.getBoundingClientRect();
      hoverBtn.style.display = 'block';
      hoverBtn.style.top = `${Math.max(8, r.top + 10)}px`;
      hoverBtn.style.left = `${Math.min(innerWidth - 120, r.right - 120)}px`;
    },
    { passive: true },
  );
  hoverBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (hoverCand) void translate(hoverCand, { priority: 30, force: true });
    hoverBtn.style.display = 'none';
  });

  // ---- screen area --------------------------------------------------------------------------
  function selectArea() {
    const host = document.createElement('div');
    markUi(host);
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>
      .veil { position: fixed; inset: 0; z-index: 2147483602; cursor: crosshair; background: rgba(28,34,48,.18); }
      .sel { position: fixed; border: 2px solid #c8205f; background: rgba(200,32,95,.08); box-shadow: 0 0 0 9999px rgba(28,34,48,.35); }
      .tip { position: fixed; top: 12px; left: 50%; transform: translateX(-50%); background: #1c2230; color: #fff; font: 14px system-ui, sans-serif; padding: 8px 12px; border-radius: 8px; }
    </style><div class="veil"><div class="tip">Выделите область для перевода. Esc — отмена</div></div>`;
    document.documentElement.appendChild(host);
    const veil = root.querySelector('.veil') as HTMLDivElement;
    let start: [number, number] | null = null;
    let sel: HTMLDivElement | null = null;
    const done = () => {
      host.remove();
      removeEventListener('keydown', onKey, true);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') done();
    };
    addEventListener('keydown', onKey, true);
    veil.addEventListener('pointerdown', (e) => {
      start = [e.clientX, e.clientY];
      sel = document.createElement('div');
      sel.className = 'sel';
      veil.append(sel);
      veil.setPointerCapture(e.pointerId);
    });
    veil.addEventListener('pointermove', (e) => {
      if (!start || !sel) return;
      const x = Math.min(start[0], e.clientX);
      const y = Math.min(start[1], e.clientY);
      Object.assign(sel.style, { left: `${x}px`, top: `${y}px`, width: `${Math.abs(e.clientX - start[0])}px`, height: `${Math.abs(e.clientY - start[1])}px` });
    });
    veil.addEventListener('pointerup', (e) => {
      if (!start) return done();
      const rect = { x: Math.min(start[0], e.clientX), y: Math.min(start[1], e.clientY), width: Math.abs(e.clientX - start[0]), height: Math.abs(e.clientY - start[1]) };
      done();
      if (rect.width < 12 || rect.height < 12) return;
      // Wait two frames so our veil is not in the screenshot.
      requestAnimationFrame(() => requestAnimationFrame(() => void translateArea(rect)));
    });
  }

  async function translateArea(rect: { x: number; y: number; width: number; height: number }) {
    const id = `a${Date.now().toString(36)}`;
    const doc = { x: rect.x + scrollX, y: rect.y + scrollY, width: rect.width, height: rect.height };
    const pseudo = document.createElement('span');
    const overlay = new Overlay(() => new DOMRect(doc.x - scrollX, doc.y - scrollY, doc.width, doc.height), {
      onToggle: () => overlay.setOriginal(!overlay.showingOriginal),
      onEdit: () => {
        const it = items.get(id);
        if (it?.result) void send({ type: 'open-editor', key: it.result.key });
      },
      onRetry: () => {
        overlay.destroy();
        items.delete(id);
        void translateArea({ x: doc.x - scrollX, y: doc.y - scrollY, width: doc.width, height: doc.height });
      },
      onClose: () => {
        overlay.destroy();
        items.delete(id);
      },
      onCancel: () => {
        void send({ type: 'cancel', id });
        overlay.destroy();
        items.delete(id);
      },
    });
    items.set(id, { id, cand: { el: pseudo, kind: 'canvas' }, status: 'queued', overlay, docRect: doc });
    overlay.stage({ stage: 'queued' });
    await send({ type: 'capture-area', image: { id, kind: 'area', rect, dpr: devicePixelRatio }, pageUrl: location.href, title: document.title });
  }

  function toastOnce(text: string) {
    const host = document.createElement('div');
    markUi(host);
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `<div style="position:fixed;z-index:2147483603;bottom:20px;left:50%;transform:translateX(-50%);background:#1c2230;color:#fff;font:14px system-ui,sans-serif;padding:10px 14px;border-radius:8px">${text.replace(/[<>&]/g, '')}</div>`;
    document.documentElement.appendChild(host);
    setTimeout(() => host.remove(), 3000);
  }

  void send<{ autoTranslate: boolean; minImageSize: number; enabled: boolean; targetLang: string }>({ type: 'get-page-state', host: location.hostname }).then((s) => {
    if (!s) return;
    minSize = s.minImageSize;
    enabled = s.enabled;
    targetLang = s.targetLang;
    setAuto(s.autoTranslate);
  });
}
