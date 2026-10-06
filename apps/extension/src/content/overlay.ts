import type { StageEvent } from '@ait/core';
import { markUi } from './scanner';

const STAGE: Partial<Record<StageEvent['stage'], string>> = {
  queued: 'В очереди',
  fetching: 'Загрузка',
  decoding: 'Открываю',
  detecting: 'Ищу текст',
  ocr: 'Распознаю',
  translating: 'Перевожу',
  cleaning: 'Очищаю',
  rendering: 'Вписываю',
};

const CSS = `
:host { all: initial; }
.wrap { position: fixed; z-index: 2147483600; pointer-events: none; overflow: hidden; }
.tiles img { display: block; width: 100%; height: auto; user-select: none; -webkit-user-drag: none; }
.tiles.hidden { visibility: hidden; }
.cmp { position: absolute; inset: 0; pointer-events: none; }
.bar { position: absolute; top: 8px; right: 8px; display: flex; gap: 4px; pointer-events: auto; opacity: .35; transition: opacity .12s; font: 13px/1.2 system-ui, sans-serif; }
.wrap:hover .bar, .bar:hover, .bar.busy, .bar.err { opacity: 1; }
.bar button, .pill { border: 1.5px solid #1c2230; background: #fff; color: #1c2230; border-radius: 999px; padding: 4px 9px; cursor: pointer; font: inherit; box-shadow: 2px 2px 0 #1c2230; }
.bar button:hover { background: #fbe6ee; }
.pill { cursor: default; background: #c8205f; color: #fff; }
.pill.err { background: #fff; color: #c0392b; max-width: 260px; white-space: normal; }
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
  hasResult = false;

  constructor(
    private anchor: () => DOMRect | null,
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
      this.wrap.style.display = 'none';
      return;
    }
    this.wrap.style.display = 'block';
    this.wrap.style.left = `${r.left}px`;
    this.wrap.style.top = `${r.top}px`;
    this.wrap.style.width = `${r.width}px`;
    this.wrap.style.height = `${r.height}px`;
  }

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

  stage(ev: StageEvent): void {
    this.bar.className = 'bar busy';
    this.pill = document.createElement('span');
    this.pill.className = 'pill';
    this.pill.textContent = `${STAGE[ev.stage] ?? 'Работаю'}…`;
    this.buttons([['✕', 'Отменить', this.actions.onCancel]]);
  }

  error(message: string): void {
    this.bar.className = 'bar err';
    this.pill = document.createElement('span');
    this.pill.className = 'pill err';
    this.pill.textContent = message;
    const defs: [string, string, () => void][] = [['Повторить', 'Попробовать ещё раз', this.actions.onRetry]];
    if (this.actions.onClose) defs.push(['✕', 'Закрыть', this.actions.onClose]);
    else if (!this.hasResult) defs.push(['✕', 'Скрыть', () => this.destroy()]);
    this.buttons(defs);
  }

  setTiles(tiles: { y: number; h: number; dataUrl: string }[]): void {
    this.revoke();
    const imgs = tiles.map((t) => {
      const img = document.createElement('img');
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
      ['⇄', 'Оригинал / перевод', this.actions.onToggle],
      ['◫', 'Сравнить со слайдером', () => this.toggleCompare()],
      ['✎', 'Править в редакторе', this.actions.onEdit],
      ['⟳', 'Перевести заново', this.actions.onRetry],
    ];
    if (this.actions.onClose) defs.push(['✕', 'Закрыть', this.actions.onClose]);
    this.buttons(defs);
    this.setOriginal(false);
  }

  setOriginal(show: boolean): void {
    this.showingOriginal = show;
    this.tiles.classList.toggle('hidden', show);
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
