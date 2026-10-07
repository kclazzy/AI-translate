import type { StageEvent } from '@ait/core';
import { markUi } from './scanner';
import { lazyStrings, tr } from '@ait/core/i18n';

const STAGE: Partial<Record<StageEvent['stage'], string>> = lazyStrings({
  queued: 'В очереди',
  fetching: 'Загрузка',
  decoding: 'Открываю',
  detecting: 'Ищу текст',
  ocr: 'Распознаю',
  translating: 'Перевожу',
  checking: 'Проверяю перевод',
  cleaning: 'Очищаю',
  rendering: 'Вписываю',
});

const CSS = `
:host { all: initial; }
.wrap { position: fixed; z-index: 2147483600; pointer-events: none; overflow: hidden; }
.tiles { position: absolute; inset: 0; }
/* Pieces of a long page overlap by a pixel: no hairline gap where the original could show through. */
.tiles img { position: absolute; left: 0; width: 100%; display: block; user-select: none; -webkit-user-drag: none; }
.tiles.hidden { visibility: hidden; }
.cmp { position: absolute; inset: 0; pointer-events: none; }
.bar { position: absolute; top: 8px; right: 8px; display: flex; align-items: flex-start; gap: 4px; pointer-events: auto; opacity: .35; transition: opacity .12s; font: 13px/1.2 system-ui, sans-serif; }
.wrap:hover .bar, .bar:hover, .bar.busy, .bar.err { opacity: 1; }
.bar button, .pill { border: 1.5px solid #1c2230; background: #fff; color: #1c2230; border-radius: 999px; padding: 4px 9px; cursor: pointer; font: inherit; box-shadow: 2px 2px 0 #1c2230; }
.bar button:hover { background: #fbe6ee; }
.pill { cursor: default; background: #c8205f; color: #fff; }
.pill.err { background: #fff; color: #c0392b; border-radius: 12px; padding: 8px 12px; max-width: 320px; white-space: normal; line-height: 1.35; }
.pill.err small { display: block; color: #1c2230; margin-top: 4px; font-size: 12px; }
.split { position: absolute; top: 0; bottom: 0; width: 3px; background: #c8205f; pointer-events: auto; cursor: ew-resize; }
`;

/** Translated image drawn over the original element, plus a small toolbar. */
export class Overlay {
  readonly host: HTMLDivElement;
  private wrap: HTMLDivElement;
  private tiles: HTMLDivElement;
  private bar: HTMLDivElement;
  private pill: HTMLSpanElement | null = null;
  private urls: string[] = [];
  private compareAt: number | null = null;
  showingOriginal = false;
  /** Languages for the ⇄ button: it shows the name of the language a click switches to. */
  private langs: { source: string; target: string } | null = null;
  private toggleBtn: HTMLButtonElement | null = null;
  hasResult = false;

  constructor(
    /** Where to draw; `inner` = the drawn picture inside that box (object-fit), relative to it. */
    private anchor: () => (DOMRect & { inner?: { x: number; y: number; w: number; h: number } }) | null,
    private actions: { onToggle: () => void; onEdit: () => void; onRetry: () => void; onClose?: () => void; onCancel: () => void },
  ) {
    this.host = document.createElement('div');
    markUi(this.host);
    const root = this.host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = CSS;
    this.wrap = document.createElement('div');
    this.wrap.className = 'wrap';
    this.tiles = document.createElement('div');
    this.tiles.className = 'tiles';
    this.bar = document.createElement('div');
    this.bar.className = 'bar';
    this.wrap.append(this.tiles, this.bar);
    root.append(style, this.wrap);
    document.documentElement.appendChild(this.host);
    this.position();
  }

  position(): void {
    const r = this.anchor();
    if (!r || r.width < 2 || r.bottom < -2000 || r.top > innerHeight + 2000) {
      if (this.placed !== 'none') this.wrap.style.display = 'none';
      this.placed = 'none';
      return;
    }
    // Write only when something moved: style writes on hundreds of pictures make scrolling stutter.
    const key = `${r.left}|${r.top}|${r.width}|${r.height}|${r.inner ? `${r.inner.x},${r.inner.y},${r.inner.w},${r.inner.h}` : ''}`;
    if (key === this.placed) return;
    this.placed = key;
    this.wrap.style.display = 'block';
    this.wrap.style.left = `${r.left}px`;
    this.wrap.style.top = `${r.top}px`;
    this.wrap.style.width = `${r.width}px`;
    this.wrap.style.height = `${r.height}px`;
    // The wrap clips to the element; the tiles cover the drawn picture (bigger when cropped by cover).
    const i = r.inner;
    this.tiles.style.inset = i ? 'auto' : '0';
    this.tiles.style.left = i ? `${i.x}px` : '';
    this.tiles.style.top = i ? `${i.y}px` : '';
    this.tiles.style.width = i ? `${i.w}px` : '';
    this.tiles.style.height = i ? `${i.h}px` : '';
  }

  private placed = '';

  private buttons(defs: [string, string, () => void][]) {
    this.bar.replaceChildren();
    if (this.pill) this.bar.append(this.pill);
    for (const [label, title, fn] of defs) {
      const b = document.createElement('button');
      b.textContent = label;
      b.title = title;
      b.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        fn();
      });
      this.bar.append(b);
    }
  }

  private stageLabel = '';

  stage(ev: StageEvent): void {
    this.bar.className = 'bar busy';
    this.pill = document.createElement('span');
    this.pill.className = 'pill';
    this.stageLabel = STAGE[ev.stage] ?? tr('Работаю');
    this.pill.textContent = `${this.stageLabel}…`;
    this.buttons([['✕', tr('Отменить'), this.actions.onCancel]]);
  }

  /** Extra live info next to the stage: queue position, elapsed time, a hint for slow models. */
  note(text: string, hint?: string): void {
    if (!this.pill || !this.bar.classList.contains('busy')) return;
    this.pill.textContent = `${this.stageLabel}… ${text}`;
    if (hint) {
      const d = document.createElement('small');
      d.textContent = hint;
      this.pill.append(d);
    }
  }

  error(message: string, detail?: string, action?: [string, () => void]): void {
    this.bar.className = 'bar err';
    this.pill = document.createElement('span');
    this.pill.className = 'pill err';
    this.pill.textContent = message;
    if (detail) {
      const d = document.createElement('small');
      d.textContent = detail;
      this.pill.append(d);
    }
    const defs: [string, string, () => void][] = action ? [[action[0], action[0], action[1]]] : [[tr('Повторить'), tr('Попробовать ещё раз'), this.actions.onRetry]];
    if (this.actions.onClose) defs.push(['✕', tr('Закрыть'), this.actions.onClose]);
    else if (!this.hasResult) defs.push(['✕', tr('Скрыть'), () => this.destroy()]);
    this.buttons(defs);
  }

  setTiles(tiles: { y: number; h: number; dataUrl: string }[], langs?: { source: string; target: string }): void {
    if (langs) this.langs = langs;
    this.revoke();
    const total = tiles.length ? tiles[tiles.length - 1].y + tiles[tiles.length - 1].h : 1;
    const imgs = tiles.map((t, i) => {
      const img = document.createElement('img');
      img.style.top = `${(t.y / total) * 100}%`;
      img.style.height = i < tiles.length - 1 ? `calc(${(t.h / total) * 100}% + 1px)` : `${(t.h / total) * 100}%`;
      // data: → blob: keeps memory lower for very long strips.
      const url = URL.createObjectURL(dataUrlToBlob(t.dataUrl));
      this.urls.push(url);
      img.src = url;
      img.decoding = 'async';
      img.alt = '';
      return img;
    });
    this.tiles.replaceChildren(...imgs);
    this.hasResult = true;
    this.pill = null;
    this.bar.className = 'bar';
    const defs: [string, string, () => void][] = [
      ['⇄', tr('Оригинал / перевод'), this.actions.onToggle],
      ['◫', tr('Сравнить со слайдером'), () => this.toggleCompare()],
      ['✎', tr('Править в редакторе'), this.actions.onEdit],
      ['⟳', tr('Перевести заново'), this.actions.onRetry],
    ];
    if (this.actions.onClose) defs.push(['✕', tr('Закрыть'), this.actions.onClose]);
    this.buttons(defs);
    this.toggleBtn = this.bar.querySelector('button');
    this.setOriginal(false);
  }

  /** Translation check result: a small button that opens the editor with the report. */
  setQa(count: number, details: string): void {
    if (!count) return;
    const b = document.createElement('button');
    b.textContent = `🔍 ${count}`;
    b.title = tr('Проверка перевода — замечаний: {0}\n{1}\nНажмите, чтобы открыть в редакторе.', count, details);
    b.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.actions.onEdit();
    });
    this.bar.append(b);
  }

  setOriginal(show: boolean): void {
    this.showingOriginal = show;
    this.tiles.classList.toggle('hidden', show);
    const b = this.toggleBtn;
    if (b && this.langs) {
      const next = show ? this.langs.target : this.langs.source;
      b.textContent = `⇄ ${next}`;
      b.title = show ? tr('Показать перевод ({0})', this.langs.target) : tr('Показать оригинал ({0})', this.langs.source);
    }
  }

  private toggleCompare(): void {
    const existing = this.wrap.querySelector('.split');
    if (existing) {
      existing.remove();
      this.tiles.style.clipPath = '';
      this.compareAt = null;
      return;
    }
    this.compareAt = 0.5;
    const split = document.createElement('div');
    split.className = 'split';
    const apply = () => {
      split.style.left = `${(this.compareAt ?? 0.5) * 100}%`;
      this.tiles.style.clipPath = `inset(0 0 0 ${(this.compareAt ?? 0.5) * 100}%)`;
    };
    split.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      split.setPointerCapture(e.pointerId);
      const move = (ev: PointerEvent) => {
        const r = this.wrap.getBoundingClientRect();
        this.compareAt = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
        apply();
      };
      split.addEventListener('pointermove', move);
      split.addEventListener('pointerup', () => split.removeEventListener('pointermove', move), { once: true });
    });
    this.wrap.append(split);
    apply();
  }

  private revoke() {
    for (const u of this.urls) URL.revokeObjectURL(u);
    this.urls = [];
  }

  destroy(): void {
    this.revoke();
    this.host.remove();
  }
}

function dataUrlToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(',');
  const mime = /data:([^;]+)/.exec(dataUrl)?.[1] ?? 'image/png';
  const bin = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}
