import { errorMessage } from '@ait/core/errors';
import type { BackgroundToContent, ContentToBackground, ImageRef, RenderedTiles } from '../shared/messages';
import { Overlay } from './overlay';
import { asCandidate, candidateAt, imgSrc, inlineData, markUi, scanPage, viewportRect, type Candidate } from './scanner';

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
    const image: ImageRef = { id, kind: c.kind, src: c.src, dataUrl: await inlineData(c), rect: viewportRect(c.el), dpr: devicePixelRatio };
    if (image.dataUrl) image.src = undefined;
    await send({ type: 'translate', image, pageUrl: location.href, title: document.title, priority: opts.priority ?? priorityOf(c.el), force: opts.force });
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
  chrome.runtime.onMessage.addListener((msg: BackgroundToContent) => {
    switch (msg.type) {
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
        it.overlay.setTiles(msg.result.tiles);
        it.overlay.setOriginal(originalsShown);
        it.overlay.position();
        break;
      }
      case 'job-error': {
        const it = items.get(msg.id);
        if (!it) break;
        it.status = 'error';
        it.overlay.error(errorMessage(msg.error));
        break;
      }
      case 'command':
        if (msg.command === 'translate-page') translatePage();
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
              it.overlay.setTiles(r.tiles);
            }
          });
        }
        break;
      case 'state':
        minSize = msg.minImageSize;
        setAuto(msg.autoTranslate);
        break;
    }
    return false;
  });

  function translatePage() {
    const cands = scanPage(minSize);
    if (!cands.length) toastOnce('На странице не найдено подходящих изображений');
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
          const now = imgSrc(it.cand.el as HTMLImageElement);
          if (it.src && now && now !== it.src) {
            it.overlay.destroy();
            items.delete(id);
          }
        }
      }
      if (!autoTranslate) return;
      for (const c of scanPage(minSize)) {
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
    autoTranslate = on;
    if (on) rescan();
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
      if (e.composedPath().includes(hoverHost)) return;
      const c = candidateAt(e.clientX, e.clientY, minSize);
      const id = c ? byElement.get(c.el) : undefined;
      if (!c || (id && items.get(id)?.status === 'done')) {
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

  void send<{ autoTranslate: boolean; minImageSize: number }>({ type: 'get-page-state', host: location.hostname }).then((s) => {
    if (!s) return;
    minSize = s.minImageSize;
    setAuto(s.autoTranslate);
  });
}
