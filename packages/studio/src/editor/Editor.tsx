import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import {
  cleanBlock,
  clampBox,
  ctxMeasurer,
  drawBlock,
  layoutBlock,
  paintRegion,
  parseHex,
  recognizeRegion,
  resolveStyle,
  retranslate,
  shouldDraw,
  styleDefaultsFor,
  targetBox,
  TEXT_TYPES,
  type AppSettings,
  type Box,
  type LayoutResult,
  type PageResult,
  type PixelData,
  type StyleDefaults,
  type TextBlock,
  type TextStyle,
  type TiledImage,
  QA_LABELS,
  qaNote,
} from '@ait/core';
import { loadUserFonts, registerUserFont, saveUserFont } from '../fonts';
import { exportChapterTexts, exportTexts, importTexts } from './texts';
import { EditHistory, type HistoryItem } from './history';
import { confirmLeave, setActiveEditor, type EditorGuard } from './guard';
import { exportPsd, psdTooBig } from '../psd';
import { usePlatform, useUpdateSettings } from '../platform';
import { LamaGetButton, lamaModeOf, useLamaDownloaded } from '../lama';
import { ErrorBox, Field, Switch, toast, useAction } from '../ui';
import { tr } from '@ait/core/i18n';

type Tool = 'select' | 'brush' | 'eraser' | 'inpaint' | 'ocr' | 'picker' | 'crop';

export interface EditorProps {
  page: PageResult;
  original: TiledImage;
  cleaned: TiledImage;
  settings: AppSettings;
  onSave: (page: PageResult, cleaned: TiledImage, pixelsChanged: boolean) => Promise<void>;
  onClose?: () => void;
  title?: string;
  /** Rows where one picture of the chapter ends and the next begins (whole-chapter mode). */
  marks?: number[];
  /** Extra buttons for the toolbar. */
  toolbarExtra?: React.ReactNode;
  /** Texts of every translated page of the chapter, in reading order (for «Скачать весь текст с главы»). */
  chapterTexts?: (current: TextBlock[]) => Promise<TextBlock[][]>;
  /** Pages of a project can be cut to a frame (pictures on a site cannot: they must keep their size). */
  onCrop?: (rect: Box, blocks: TextBlock[]) => Promise<void>;
  /** Told whenever the page gets or loses unsaved edits (the page list marks it). */
  onDirtyChange?: (dirty: boolean) => void;
}

const BASE_FONTS = ['"AIT Lettering"', '"AIT Comic"', '"AIT Narration"', '"AIT SFX"', 'Arial', '"Comic Sans MS"', '"Times New Roman"', 'Georgia', 'Impact'];

function clonePixels(p: PixelData): PixelData {
  return { width: p.width, height: p.height, data: new Uint8ClampedArray(p.data) };
}

/** A block the proof-reader should look at: the translators disagree, the check found problems, or the text does not fit. */
function hasRemark(b: TextBlock, overflow: Set<string>): boolean {
  return b.check?.verdict === 'differs' || !!b.qa?.issues.length || overflow.has(b.id);
}

/** Rows a block's letters can reach (overflowing or rotated text runs past its box). */
function blockRows(b: TextBlock, l: LayoutResult, d: StyleDefaults): [number, number] {
  const box = l.box ?? targetBox(b, d);
  const ys = l.vertical ? l.glyphs.map((g) => g.y) : l.lines.map((x) => x.y);
  const pad = l.fontSize * 1.5;
  let top = box[1] + Math.min(0, ...ys) - pad;
  let bottom = box[1] + Math.max(box[3], ...ys) + pad;
  if (resolveStyle(b, d).rotation) {
    const cy = box[1] + box[3] / 2;
    const r = Math.hypot(box[2], Math.max(box[3], bottom - top)) / 2 + pad;
    top = Math.min(top, cy - r);
    bottom = Math.max(bottom, cy + r);
  }
  return [top, bottom];
}

const sameSet = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((x) => b.has(x));
const OVERLAY_COLORS = { brush: '', eraser: '#1c6ed8', inpaint: '#c8205f' } as const;

export function Editor({ page, original, cleaned, settings, onSave, onClose, title, marks, toolbarExtra, chapterTexts, onCrop, onDirtyChange }: EditorProps) {
  const platform = usePlatform();
  const [blocks, setBlocks] = useState<TextBlock[]>(page.blocks);
  const [selected, setSelected] = useState<string | null>(page.blocks[0]?.id ?? null);
  const [tool, setTool] = useState<Tool>('select');
  const [brush, setBrush] = useState(20);
  const [brushColor, setBrushColor] = useState('#ffffff');
  const [zoom, setZoom] = useState(() => Math.min(1, 900 / page.width));
  const [compare, setCompare] = useState(false);
  const [split, setSplit] = useState(0.5);
  const [overflow, setOverflow] = useState<Set<string>>(new Set());
  const [fonts, setFonts] = useState<string[]>(BASE_FONTS);
  const [dirty, setDirty] = useState(false);
  /** Blocks selected together with `selected` (Ctrl/Shift+click): style changes apply to all of them. */
  const [multi, setMulti] = useState<Set<string>>(new Set());
  const [styleClip, setStyleClip] = useState<Partial<TextStyle> | null>(null);
  const [fontQuery, setFontQuery] = useState('');
  const updateSettings = useUpdateSettings();
  /** ◍ redraws with LaMa when it runs here and the model is downloaded; otherwise a simple fill. */
  const [lamaHave, setLamaHave] = useLamaDownloaded();
  const lamaReady = !!platform.inpaint && lamaHave === true;
  /** LaMa strokes being redrawn right now. */
  const [lamaBusy, setLamaBusy] = useState(0);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const toolRef = useRef(tool);
  toolRef.current = tool;
  /** The blocks as they are right now: async actions build on these, not on the render they started in. */
  const blocksRef = useRef(blocks);
  blocksRef.current = blocks;
  const historyRef = useRef<EditHistory | null>(null);
  const history = (historyRef.current ??= new EditHistory());
  const [, forceHistory] = useState(0);
  /** Bumps with every edit: a save only clears «unsaved» when nothing changed while it ran. */
  const editSeq = useRef(0);
  /** Pixels of the cleaned picture changed since the last save. */
  const pixelsChanged = useRef(false);
  const tileCanvases = useRef<(HTMLCanvasElement | null)[]>([]);
  const origCanvases = useRef<(HTMLCanvasElement | null)[]>([]);
  const innerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  /** Brush preview: a canvas the size of the visible stage, not of the (possibly 30 000 px) page. */
  const overlayRef = useRef<HTMLCanvasElement>(null);
  /** Where the brush outline is drawn (inside the editor frame), or nowhere. */
  const [cursorAt, setCursorAt] = useState<[number, number] | null>(null);
  const resizing = useRef(false);
  /** Manual OCR: the frame being stretched, in page pixels. */
  const [ocrFrame, setOcrFrame] = useState<Box | null>(null);
  /** Esc stops the drag / stroke / frame in progress. */
  const cancelGesture = useRef<(() => void) | null>(null);
  /** Typing in one field is one undo step: the step stays open while the field keeps the focus. */
  const typing = useRef<{ id: string; field: 'translatedText' | 'originalText'; item: HistoryItem } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  /** The part of the page in view (page rows), for the minimap. */
  const [view, setView] = useState<[number, number]>([0, 0]);
  const fitZoom = useCallback(() => {
    const w = stageRef.current?.clientWidth ?? 900;
    return Math.max(0.1, Math.min(1, (w - 56) / page.width));
  }, [page.width]);
  useEffect(() => {
    setZoom(fitZoom());
  }, [fitZoom]);
  const defaults = useMemo(() => styleDefaultsFor({ targetLang: page.targetLang, sfxStyle: settings.sfxStyle }, settings.fonts), [page.targetLang, settings.sfxStyle, settings.fonts]);

  const setBlocksNow = (next: TextBlock[]) => {
    blocksRef.current = next;
    setBlocks(next);
  };
  const touched = () => {
    editSeq.current++;
    setDirty(true);
  };
  const push = (item: HistoryItem) => {
    history.push(item);
    touched();
    forceHistory((n) => n + 1);
  };

  /** Replace the blocks as one undo step. `before` defaults to the blocks as they are now. */
  const commitBlocks = (next: TextBlock[], before = blocksRef.current) => {
    push({ kind: 'blocks', before, after: next });
    setBlocksNow(next);
  };
  /** Change the current blocks (for async actions: whatever the user did meanwhile is kept). */
  const commitWith = (fn: (prev: TextBlock[]) => TextBlock[]) => {
    const prev = blocksRef.current;
    const next = fn(prev);
    if (next !== prev) commitBlocks(next, prev);
  };

  // ---- rendering: only the tiles whose texts or pixels changed, at most once per frame ----------------------
  const measurer = useMemo(() => ctxMeasurer(platform.backend.createCanvas(8, 8).getContext('2d')), [platform.backend]);
  const layoutCache = useMemo(() => new WeakMap<TextBlock, LayoutResult | null>(), [defaults, measurer, cleaned]); // eslint-disable-line react-hooks/exhaustive-deps
  const renderState = useRef({ all: true, rows: [] as [number, number][], drawn: new Map<string, { block: TextBlock; rows: [number, number] | null }>(), frame: 0 });
  const live = useRef({ defaults, cleaned, layoutCache });
  live.current = { defaults, cleaned, layoutCache };
  const layoutOf = (b: TextBlock): LayoutResult | null => {
    const { defaults: d, cleaned: img, layoutCache: cache } = live.current;
    let l = cache.get(b);
    if (l === undefined) {
      l = shouldDraw(b, d) ? layoutBlock(measurer, b, d, { width: img.width, height: img.height }) : null;
      cache.set(b, l);
    }
    return l;
  };
  const renderNow = () => {
    const rs = renderState.current;
    rs.frame = 0;
    const { defaults: d, cleaned: img } = live.current;
    const bl = blocksRef.current;
    const layouts = new Map<string, LayoutResult>();
    const rows = new Map<string, [number, number]>();
    const of = new Set<string>();
    for (const b of bl) {
      const l = layoutOf(b);
      if (!l) continue;
      layouts.set(b.id, l);
      rows.set(b.id, blockRows(b, l, d));
      if (l.overflow) of.add(b.id);
    }
    const spans = rs.rows;
    rs.rows = [];
    const next = new Map<string, { block: TextBlock; rows: [number, number] | null }>();
    for (const b of bl) {
      const prev = rs.drawn.get(b.id);
      const r = rows.get(b.id) ?? null;
      next.set(b.id, { block: b, rows: r });
      if (!prev || prev.block !== b) {
        if (prev?.rows) spans.push(prev.rows);
        if (r) spans.push(r);
      }
    }
    for (const [id, prev] of rs.drawn) if (!next.has(id) && prev.rows) spans.push(prev.rows);
    rs.drawn = next;
    const all = rs.all;
    rs.all = false;
    img.tiles.forEach((t, i) => {
      if (!all && !spans.some(([a, b]) => b >= t.y && a <= t.y + t.h)) return;
      const c = tileCanvases.current[i];
      if (!c) return;
      const ctx = c.getContext('2d')!;
      ctx.clearRect(0, 0, c.width, c.height);
      ctx.drawImage(t.canvas as unknown as CanvasImageSource, 0, 0);
      for (const b of bl) {
        const l = layouts.get(b.id);
        const r = rows.get(b.id);
        if (!l || !r || r[1] < t.y || r[0] > t.y + t.h) continue;
        drawBlock(ctx, b, l, d, t.y);
      }
    });
    setOverflow((prev) => (sameSet(prev, of) ? prev : of));
  };
  const scheduleRender = () => {
    const rs = renderState.current;
    if (!rs.frame) rs.frame = requestAnimationFrame(renderNow);
  };
  /** Pixels of the cleaned picture changed in these rows. */
  const markPixels = (box: Box) => {
    renderState.current.rows.push([box[1], box[1] + box[3]]);
    pixelsChanged.current = true;
    scheduleRender();
  };
  useEffect(() => {
    renderState.current.all = true;
    renderState.current.drawn = new Map();
    scheduleRender();
  }, [cleaned, defaults]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    scheduleRender();
  }, [blocks]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => cancelAnimationFrame(renderState.current.frame), []);

  useEffect(() => {
    original.tiles.forEach((t, i) => {
      const c = origCanvases.current[i];
      if (c) c.getContext('2d')!.drawImage(t.canvas as unknown as CanvasImageSource, 0, 0);
    });
  }, [original, compare]);

  // ---- undo / redo --------------------------------------------------------------------
  const applyHistory = (item: HistoryItem, dir: 'undo' | 'redo') => {
    typing.current = null;
    if (item.kind === 'blocks') setBlocksNow(dir === 'undo' ? item.before : item.after);
    else {
      cleaned.putRegion(dir === 'undo' ? item.before : item.after, item.box[0], item.box[1]);
      if (item.blocksBefore && item.blocksAfter) setBlocksNow(dir === 'undo' ? item.blocksBefore : item.blocksAfter);
      markPixels(item.box);
    }
    touched();
  };
  const undo = () => {
    const it = history.undo();
    if (!it) return;
    applyHistory(it, 'undo');
    forceHistory((n) => n + 1);
  };
  const redo = () => {
    const it = history.redo();
    if (!it) return;
    applyHistory(it, 'redo');
    forceHistory((n) => n + 1);
  };

  /** Typing into a text field of a block: one undo step per field while it keeps the focus. */
  const typeText = (id: string, field: 'translatedText' | 'originalText', value: string) => {
    const prev = blocksRef.current;
    const next = prev.map((b) => (b.id === id ? { ...b, [field]: value, ...(field === 'translatedText' ? { edited: true } : {}) } : b));
    const t = typing.current;
    if (t && t.id === id && t.field === field && history.top() === t.item && t.item.kind === 'blocks') {
      t.item.after = next;
      touched();
    } else {
      const item: HistoryItem = { kind: 'blocks', before: prev, after: next };
      push(item);
      typing.current = { id, field, item };
    }
    setBlocksNow(next);
  };
  const endTyping = () => {
    typing.current = null;
  };

  const sel = blocks.find((b) => b.id === selected) ?? null;
  /** The size the selected text gets automatically (shown as the hint, the start for A−/A+). */
  const autoSize = useMemo(() => {
    if (!sel) return 0;
    const b = { ...sel, style: { ...(sel.style ?? {}), fontSize: null } };
    return Math.round(layoutBlock(measurer, b, defaults, { width: page.width, height: page.height }).fontSize);
  }, [sel, defaults, measurer, page.width, page.height]);
  const updateBlock = (id: string, patch: Partial<TextBlock>) => commitWith((prev) => prev.map((b) => (b.id === id ? { ...b, ...patch, edited: true } : b)));
  /** The selected block and the others picked with Ctrl/Shift+click. */
  const targets = selected ? new Set([selected, ...multi]) : new Set(multi);
  const updateStyle = (id: string, patch: Partial<TextStyle>) => {
    const ids = id === selected ? targets : new Set([id]);
    commitWith((prev) => prev.map((b) => (ids.has(b.id) ? { ...b, style: { ...(b.style ?? {}), ...patch }, edited: true } : b)));
  };
  const pick = (id: string, add: boolean) => {
    if (add && selected && selected !== id) {
      const next = new Set(multi);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      setMulti(next);
      return;
    }
    setMulti(new Set());
    setSelected(id);
  };
  const copyText = (text: string) => {
    void navigator.clipboard?.writeText(text).then(() => toast(tr('Скопировано')), () => toast(tr('Не удалось скопировать')));
  };

  /** Bring a block into the middle of the visible part of the stage. */
  const scrollToBlock = (b: TextBlock) => {
    const el = stageRef.current;
    const inner = innerRef.current;
    if (!el || !inner) return;
    const box = targetBox(b, defaults);
    el.scrollTo?.({ top: inner.offsetTop + (box[1] + box[3] / 2) * zoom - el.clientHeight / 2, left: inner.offsetLeft + (box[0] + box[2] / 2) * zoom - el.clientWidth / 2, behavior: 'smooth' });
  };
  const select = (b: TextBlock) => {
    setMulti(new Set());
    setSelected(b.id);
    scrollToBlock(b);
  };
  /** Blocks with a remark, top to bottom. */
  const remarks = useMemo(() => {
    const list = blocks.filter((b) => hasRemark(b, overflow));
    return list.sort((a, b) => targetBox(a, defaults)[1] - targetBox(b, defaults)[1] || targetBox(a, defaults)[0] - targetBox(b, defaults)[0]);
  }, [blocks, overflow, defaults]);
  /** Jump to the next (or previous) block with a remark, below (above) the selected one. */
  const jumpRemark = (dir: 1 | -1) => {
    if (!remarks.length) return toast(tr('Замечаний нет'));
    const cur = blocks.find((b) => b.id === selected);
    const y = cur ? targetBox(cur, defaults)[1] : dir === 1 ? -Infinity : Infinity;
    const i = remarks.findIndex((b) => b.id === selected);
    let target: TextBlock | undefined;
    if (i >= 0) target = remarks[(i + dir + remarks.length) % remarks.length];
    else target = dir === 1 ? remarks.find((b) => targetBox(b, defaults)[1] > y) ?? remarks[0] : [...remarks].reverse().find((b) => targetBox(b, defaults)[1] < y) ?? remarks[remarks.length - 1];
    setTool('select');
    select(target);
  };

  // User fonts saved earlier.
  useEffect(() => {
    void loadUserFonts(platform.db).then((names) => names.length && setFonts((f) => [...new Set([...f, ...names.map((n) => `"${n}"`)])]));
  }, [platform.db]);

  // Ctrl+wheel: zoom to the point under the cursor. Shift+wheel with a brush: brush size.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const inner = innerRef.current;
        if (!inner) return;
        const r = inner.getBoundingClientRect();
        const z = zoomRef.current;
        const px = (e.clientX - r.left) / z;
        const py = (e.clientY - r.top) / z;
        const nz = Math.max(0.1, Math.min(6, +(z * (e.deltaY < 0 ? 1.15 : 1 / 1.15)).toFixed(3)));
        setZoom(nz);
        requestAnimationFrame(() => {
          const r2 = inner.getBoundingClientRect();
          el.scrollLeft += r2.left + px * nz - e.clientX;
          el.scrollTop += r2.top + py * nz - e.clientY;
        });
      } else if (e.shiftKey && toolRef.current !== 'select' && toolRef.current !== 'ocr') {
        e.preventDefault();
        setBrush((b) => Math.max(1, Math.min(200, b + (e.deltaY < 0 ? 2 : -2))));
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // The visible rows, for the minimap (once per frame while scrolling).
  const viewFrame = useRef(0);
  const measureView = () => {
    viewFrame.current = 0;
    const el = stageRef.current;
    const inner = innerRef.current;
    if (!el || !inner) return;
    const z = zoomRef.current;
    const top = (el.scrollTop - inner.offsetTop) / z;
    setView([Math.max(0, top), Math.min(page.height, top + el.clientHeight / z)]);
  };
  const onStageScroll = () => {
    if (!viewFrame.current) viewFrame.current = requestAnimationFrame(measureView);
  };
  useEffect(() => {
    measureView();
    return () => cancelAnimationFrame(viewFrame.current);
  }, [zoom]); // eslint-disable-line react-hooks/exhaustive-deps

  // Every window listener of a gesture is removed when the editor goes away mid-gesture.
  useEffect(() => () => cancelGesture.current?.(), []);

  /** Hold the right button and move: the brush outline stays at the press point, its edge follows the pointer. */
  const resizeBrush = (e: RPointerEvent) => {
    e.preventDefault();
    const r = wrapRef.current?.getBoundingClientRect();
    if (!r) return;
    const cx = e.clientX;
    const cy = e.clientY;
    const startSize = brush;
    setCursorAt([cx - r.left, cy - r.top]);
    const move = (ev: PointerEvent) => {
      const d = Math.hypot(ev.clientX - cx, ev.clientY - cy);
      setBrush(Math.max(1, Math.min(200, Math.round((d * 2) / zoomRef.current))));
    };
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      resizing.current = false;
      cancelGesture.current = null;
    };
    resizing.current = true;
    cancelGesture.current = () => {
      stop();
      setBrush(startSize);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
  };

  /** Middle mouse button: drag the page around. */
  const pan = (e: RPointerEvent) => {
    const el = stageRef.current;
    if (!el) return;
    e.preventDefault();
    const sx = e.clientX;
    const sy = e.clientY;
    const sl = el.scrollLeft;
    const st0 = el.scrollTop;
    el.style.cursor = 'grabbing';
    const move = (ev: PointerEvent) => {
      el.scrollLeft = sl - (ev.clientX - sx);
      el.scrollTop = st0 - (ev.clientY - sy);
    };
    const up = () => {
      el.style.cursor = '';
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      cancelGesture.current = null;
    };
    cancelGesture.current = up;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  /** Move every selected block by (dx, dy) as one step. */
  const nudge = (dx: number, dy: number) => {
    const ids = targets;
    commitWith((prev) =>
      prev.map((b) => {
        if (!ids.has(b.id)) return b;
        const box = targetBox(b, defaults);
        return { ...b, textBox: [box[0] + dx, box[1] + dy, box[2], box[3]] as Box, edited: true };
      }),
    );
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      // Save works everywhere, also while typing a translation.
      if (mod && key === 's' && !e.altKey) {
        e.preventDefault();
        endTyping();
        if (dirtyRef.current) void saveNow();
        return;
      }
      if (e.key === 'Escape' && cancelGesture.current) {
        e.preventDefault();
        cancelGesture.current();
        return;
      }
      const target = e.target as HTMLElement | null;
      if (target?.closest?.('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) return;
      if (mod && key === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if (mod && (key === 'y' || (key === 'z' && e.shiftKey))) {
        e.preventDefault();
        redo();
      } else if (mod && key === 'a') {
        e.preventDefault();
        setSelected(blocks[0]?.id ?? null);
        setMulti(new Set(blocks.slice(1).map((b) => b.id)));
      } else if (mod || e.altKey) {
        // Browser and system shortcuts (Ctrl+C, Ctrl+E…) are not tool keys.
      } else if (e.key === 'Escape') {
        setMulti(new Set());
      } else if (e.key === '[' || e.key === ']') {
        setBrush((b) => Math.max(1, Math.min(200, b + (e.key === ']' ? 4 : -4))));
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && targets.size) {
        e.preventDefault();
        const ids = targets;
        commitWith((prev) => prev.filter((b) => !ids.has(b.id)));
        setSelected(null);
        setMulti(new Set());
      } else if (targets.size && e.key.startsWith('Arrow')) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
        nudge(dx, dy);
      } else if (key === 'n') jumpRemark(e.shiftKey ? -1 : 1);
      else if (key === 'v') setTool('select');
      else if (key === 'b') setTool('brush');
      else if (key === 'e') setTool('eraser');
      else if (key === 'i') setTool('picker');
      else if (key === 'c' && onCrop) setTool('crop');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // ---- pointer helpers ------------------------------------------------------------------
  const toPage = (clientX: number, clientY: number): [number, number] => {
    const r = innerRef.current!.getBoundingClientRect();
    return [(clientX - r.left) / zoomRef.current, (clientY - r.top) / zoomRef.current];
  };

  const startDrag = (e: RPointerEvent, b: TextBlock, mode: 'move' | 'resize' | 'rotate') => {
    if (tool !== 'select' || e.button === 1) return;
    e.stopPropagation();
    e.preventDefault();
    if (mode === 'move' && (e.ctrlKey || e.shiftKey || e.metaKey)) {
      pick(b.id, true);
      return;
    }
    if (b.id !== selected) setMulti(new Set());
    setSelected(b.id);
    endTyping();
    const before = blocksRef.current;
    const box = targetBox(b, defaults);
    const [sx, sy] = toPage(e.clientX, e.clientY);
    let latest = before;
    const move = (ev: PointerEvent) => {
      const [px, py] = toPage(ev.clientX, ev.clientY);
      let patch: Partial<TextBlock>;
      if (mode === 'move') patch = { textBox: [Math.round(box[0] + px - sx), Math.round(box[1] + py - sy), box[2], box[3]] };
      else if (mode === 'resize') patch = { textBox: [box[0], box[1], Math.max(12, Math.round(box[2] + px - sx)), Math.max(12, Math.round(box[3] + py - sy))] };
      else {
        const cx = box[0] + box[2] / 2;
        const cy = box[1] + box[3] / 2;
        const angle = Math.round((Math.atan2(py - cy, px - cx) * 180) / Math.PI + 90);
        patch = { style: { ...(b.style ?? {}), rotation: ((angle + 540) % 360) - 180 } };
      }
      latest = before.map((x) => (x.id === b.id ? { ...x, ...patch, edited: true } : x));
      setBlocksNow(latest);
    };
    const detach = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      cancelGesture.current = null;
    };
    const up = () => {
      detach();
      if (latest !== before) push({ kind: 'blocks', before, after: latest });
    };
    // Esc: the block goes back where it was.
    cancelGesture.current = () => {
      detach();
      setBlocksNow(before);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // ---- painting tools ----------------------------------------------------------------------
  const ocr = useAction(async (rect: Box) => {
    const { config } = await platform.service.config();
    const res = await recognizeRegion(original, rect, { ...config, sourceLang: settings.sourceLang, targetLang: page.targetLang }, { backend: platform.backend });
    if (!res.blocks.length) {
      toast(tr('В выделенной области текст не найден'));
      return;
    }
    const region = clampBox([rect[0] - 40, rect[1] - 40, rect[2] + 80, rect[3] + 80], cleaned.width, cleaned.height);
    const before = clonePixels(cleaned.getRegion(...region));
    const added = res.blocks.map((b) => {
      const r = cleanBlock(cleaned, b.bbox);
      return { ...b, bubble: r.bubble };
    });
    const after = clonePixels(cleaned.getRegion(...region));
    // The blocks as they are now: edits made while OCR was running stay.
    const prev = blocksRef.current;
    const next = [...prev, ...added];
    push({ kind: 'pixels', box: region, before, after, blocksBefore: prev, blocksAfter: next });
    setBlocksNow(next);
    setSelected(added[0].id);
    markPixels(region);
    toast(tr('Добавлено блоков: {0}', added.length));
  });

  /** Colour of the page under the pointer: what the reader sees (cleaned picture), 3×3 average. */
  const pickColor = (clientX: number, clientY: number) => {
    const [px, py] = toPage(clientX, clientY);
    const x = Math.max(0, Math.min(cleaned.width - 3, Math.round(px) - 1));
    const y = Math.max(0, Math.min(cleaned.height - 3, Math.round(py) - 1));
    const d = cleaned.getRegion(x, y, 3, 3).data;
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < d.length; i += 4) {
      r += d[i];
      g += d[i + 1];
      b += d[i + 2];
    }
    const hex = '#' + [r, g, b].map((v) => Math.round(v / 9).toString(16).padStart(2, '0')).join('');
    setBrushColor(hex);
    toast(tr('Цвет кисти: {0}', hex));
  };

  const onStagePointerDown = (e: RPointerEvent) => {
    if (e.button === 1) return pan(e);
    // Right button held with a brush / eraser: the circle grows to where the pointer is.
    if (e.button === 2 && (tool === 'brush' || tool === 'eraser' || tool === 'inpaint')) return resizeBrush(e);
    // Pipette (or Alt+click with the brush): take the brush colour from the picture.
    if (tool === 'picker' || (tool === 'brush' && e.altKey)) {
      e.preventDefault();
      pickColor(e.clientX, e.clientY);
      if (tool === 'picker') setTool('brush');
      return;
    }
    if (tool === 'select') {
      setSelected(null);
      setMulti(new Set());
      return;
    }
    e.preventDefault();
    const gestureTool = tool;
    const frameTool = gestureTool === 'ocr' || gestureTool === 'crop';
    const pts: [number, number][] = [toPage(e.clientX, e.clientY)];
    // The preview of a stroke is drawn in screen pixels over the visible part of the stage, one new
    // segment per move: no page-sized canvas, no redrawing the whole path.
    const overlay = overlayRef.current;
    const stage = stageRef.current;
    const wrap = wrapRef.current;
    let octx: CanvasRenderingContext2D | null = null;
    let origin: [number, number] = [0, 0];
    let last: [number, number] = [0, 0];
    if (!frameTool && overlay && stage && wrap) {
      const sr = stage.getBoundingClientRect();
      const wr = wrap.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      origin = [sr.left, sr.top];
      overlay.style.left = `${sr.left - wr.left}px`;
      overlay.style.top = `${sr.top - wr.top}px`;
      overlay.style.width = `${stage.clientWidth}px`;
      overlay.style.height = `${stage.clientHeight}px`;
      overlay.width = Math.max(1, Math.round(stage.clientWidth * dpr));
      overlay.height = Math.max(1, Math.round(stage.clientHeight * dpr));
      // Strokes are drawn opaque and the whole canvas is made see-through: overlapping segments stay even.
      overlay.style.opacity = gestureTool === 'brush' ? '1' : '0.5';
      overlay.style.display = 'block';
      octx = overlay.getContext('2d');
      if (octx) {
        octx.setTransform(dpr, 0, 0, dpr, 0, 0);
        octx.strokeStyle = gestureTool === 'brush' ? brushColor : OVERLAY_COLORS[gestureTool as 'eraser' | 'inpaint'];
        octx.lineWidth = Math.max(1, brush * zoomRef.current);
        octx.lineCap = 'round';
        octx.lineJoin = 'round';
        last = [e.clientX - origin[0], e.clientY - origin[1]];
        octx.beginPath();
        octx.moveTo(last[0], last[1]);
        octx.lineTo(last[0] + 0.1, last[1]);
        octx.stroke();
      }
    }
    const frame = (): Box => {
      const [x0, y0] = pts[0];
      const [x1, y1] = pts[pts.length - 1];
      return [Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0)];
    };
    const move = (ev: PointerEvent) => {
      pts.push(toPage(ev.clientX, ev.clientY));
      if (frameTool) {
        // The frame being stretched is drawn on top of the page (see .ait-ocr-frame).
        setOcrFrame(frame());
        return;
      }
      if (!octx) return;
      const cur: [number, number] = [ev.clientX - origin[0], ev.clientY - origin[1]];
      octx.beginPath();
      octx.moveTo(last[0], last[1]);
      octx.lineTo(cur[0], cur[1]);
      octx.stroke();
      last = cur;
    };
    const finish = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      cancelGesture.current = null;
      if (overlay) {
        overlay.style.display = 'none';
        octx?.clearRect(0, 0, overlay.width, overlay.height);
      }
      setOcrFrame(null);
    };
    const up = () => {
      finish();
      const f = frame();
      const rect: Box = [Math.round(f[0]), Math.round(f[1]), Math.round(f[2]), Math.round(f[3])];
      if (gestureTool === 'crop') {
        if (rect[2] > 16 && rect[3] > 16 && onCrop && (!dirty || confirm(tr('Несохранённые правки будут сохранены вместе с обрезкой. Продолжить?'))) && confirm(tr('Обрезать страницу по рамке {0}×{1}? Тексты за рамкой будут убраны.', rect[2], rect[3]))) {
          void onCrop(rect, blocksRef.current).then(() => setTool('select'));
        }
        return;
      }
      if (gestureTool === 'ocr') {
        if (rect[2] > 8 && rect[3] > 8) void ocr.run(rect);
        return;
      }
      applyStroke(pts, gestureTool);
    };
    // Esc: nothing is painted, no frame is taken.
    cancelGesture.current = finish;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const applyStroke = (pts: [number, number][], strokeTool: Tool) => {
    const r = brush / 2;
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const box = clampBox([Math.min(...xs) - r - 2, Math.min(...ys) - r - 2, Math.max(...xs) - Math.min(...xs) + brush + 4, Math.max(...ys) - Math.min(...ys) + brush + 4], cleaned.width, cleaned.height);
    if (box[2] <= 0 || box[3] <= 0) return;
    // Rasterise the stroke into a mask.
    const mc = platform.backend.createCanvas(box[2], box[3]);
    const mctx = mc.getContext('2d');
    mctx.strokeStyle = '#000';
    mctx.lineWidth = brush;
    mctx.lineCap = 'round';
    mctx.lineJoin = 'round';
    mctx.beginPath();
    pts.forEach(([x, y], i) => (i ? mctx.lineTo(x - box[0], y - box[1]) : mctx.moveTo(x - box[0], y - box[1])));
    if (pts.length === 1) mctx.lineTo(pts[0][0] - box[0] + 0.1, pts[0][1] - box[1]);
    mctx.stroke();
    const md = mctx.getImageData(0, 0, box[2], box[3]).data as Uint8ClampedArray;
    const mask = new Uint8Array(box[2] * box[3]);
    for (let i = 0; i < mask.length; i++) mask[i] = md[i * 4 + 3] > 40 ? 1 : 0;
    if (strokeTool === 'inpaint' && lamaReady) {
      void redrawWithLama(box, mask);
      return;
    }
    const before = clonePixels(cleaned.getRegion(...box));
    if (strokeTool === 'brush') paintRegion(cleaned, box, mask, { kind: 'color', color: parseHex(brushColor) });
    else if (strokeTool === 'inpaint') paintRegion(cleaned, box, mask, { kind: 'inpaint' });
    else if (strokeTool === 'eraser') {
      const orig = original.getRegion(...box);
      const cur = cleaned.getRegion(...box);
      for (let i = 0; i < mask.length; i++) if (mask[i]) for (let c = 0; c < 4; c++) cur.data[i * 4 + c] = orig.data[i * 4 + c];
      cleaned.putRegion(cur, box[0], box[1]);
    }
    const after = clonePixels(cleaned.getRegion(...box));
    push({ kind: 'pixels', box, before, after });
    markPixels(box);
  };

  /**
   * ◍ with LaMa: the stroke's box plus a wide margin of context goes to the model; only the pixels
   * under the stroke change. A failure falls back to the simple fill and says why.
   */
  const redrawWithLama = async (box: Box, mask: Uint8Array) => {
    const inpaint = platform.inpaint!;
    const pad = Math.round(Math.max(64, Math.max(box[2], box[3]) * 0.5));
    const area = clampBox([box[0] - pad, box[1] - pad, box[2] + pad * 2, box[3] + pad * 2], cleaned.width, cleaned.height);
    const [ax, ay, aw, ah] = area;
    const areaMask = new Uint8Array(aw * ah);
    for (let y = 0; y < box[3]; y++) {
      for (let x = 0; x < box[2]; x++) {
        if (!mask[y * box[2] + x]) continue;
        const px = box[0] - ax + x;
        const py = box[1] - ay + y;
        if (px >= 0 && py >= 0 && px < aw && py < ah) areaMask[py * aw + px] = 1;
      }
    }
    setLamaBusy((n) => n + 1);
    try {
      let res: PixelData | null = null;
      let failure: unknown = null;
      try {
        res = await inpaint(clonePixels(cleaned.getRegion(ax, ay, aw, ah)), areaMask);
        if (res.width !== aw || res.height !== ah) throw new Error(`${res.width}×${res.height} ≠ ${aw}×${ah}`);
      } catch (e) {
        failure = e;
      }
      // The pixels as they are now: strokes made while LaMa worked stay.
      const before = clonePixels(cleaned.getRegion(...area));
      if (res) {
        const cur = cleaned.getRegion(...area);
        for (let i = 0; i < areaMask.length; i++) if (areaMask[i]) for (let k = 0; k < 3; k++) cur.data[i * 4 + k] = res.data[i * 4 + k];
        cleaned.putRegion(cur, ax, ay);
      } else {
        paintRegion(cleaned, box, mask, { kind: 'inpaint' });
        toast(tr('LaMa не сработала, фон залит упрощённо: {0}', failure instanceof Error ? failure.message : String(failure)));
      }
      const after = clonePixels(cleaned.getRegion(...area));
      push({ kind: 'pixels', box: area, before, after });
      markPixels(area);
    } finally {
      setLamaBusy((n) => n - 1);
    }
  };

  // ---- actions -----------------------------------------------------------------------------
  /** «Сверить страницу»: compare every block with the translators chosen in the settings. */
  const check = useAction(async () => {
    const sent = new Map(blocksRef.current.map((b) => [b.id, b.translatedText]));
    const res = await platform.service.crossCheck(blocksRef.current, page.targetLang);
    const byId = new Map(res.blocks.map((b) => [b.id, b]));
    // Only the result of the check is taken; a text the user changed while it ran is kept.
    commitWith((prev) =>
      prev.map((b) => {
        const c = byId.get(b.id);
        if (!c) return b;
        return { ...b, check: c.check, translatedText: b.translatedText === sent.get(b.id) ? c.translatedText : b.translatedText };
      }),
    );
    const differs = res.blocks.filter((b) => b.check?.verdict === 'differs').length;
    toast(res.errors.length ? tr('Сверка: расхождений {0}. Не ответили: {1}', differs, res.errors.join('; ')) : tr('Сверка: расхождений {0}', differs));
  });
  const [back, setBack] = useState<{ id: string; text: string; by: string } | null>(null);
  const backTr = useAction(async () => {
    if (!sel) return;
    const r = await platform.service.backTranslate([sel.translatedText], page.targetLang, page.source.lang);
    setBack({ id: sel.id, text: r.texts[0] ?? '', by: r.by });
  });

  const retr = useAction(async () => {
    if (!sel) return;
    const { config } = await platform.service.config();
    const res = await retranslate([sel], { ...config, targetLang: page.targetLang }, { backend: platform.backend });
    updateBlock(sel.id, { translatedText: res.blocks[0].translatedText });
  });

  // ---- saving and leaving --------------------------------------------------------------------------
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<unknown>(null);
  const savePromise = useRef<Promise<boolean> | null>(null);
  const saveNow = (): Promise<boolean> => {
    if (savePromise.current) return savePromise.current;
    const seq = editSeq.current;
    const px = pixelsChanged.current;
    pixelsChanged.current = false;
    setSaving(true);
    setSaveError(null);
    const p = (async () => {
      try {
        await onSave({ ...page, blocks: blocksRef.current }, cleaned, px);
        // Edits made while saving stay «unsaved».
        if (editSeq.current === seq) setDirty(false);
        toast(tr('Сохранено'));
        return true;
      } catch (e) {
        if (px) pixelsChanged.current = true;
        setSaveError(e);
        return false;
      } finally {
        savePromise.current = null;
        setSaving(false);
      }
    })();
    savePromise.current = p;
    return p;
  };
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const saveRef = useRef(saveNow);
  saveRef.current = saveNow;
  const guard = useMemo<EditorGuard>(() => ({ dirty: () => dirtyRef.current, save: () => saveRef.current() }), []);
  useEffect(() => {
    setActiveEditor(guard);
    return () => setActiveEditor(null, guard);
  }, [guard]);
  useEffect(() => {
    onDirtyChange?.(dirty);
    if (!dirty) return;
    const onUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, [dirty]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => onDirtyChange?.(false), []); // eslint-disable-line react-hooks/exhaustive-deps

  const psd = useAction(async () => {
    const big = psdTooBig(page.width, page.height);
    if (big === 'side') return toast(tr('Страница длиннее 30 000 px — Photoshop такую не откроет'));
    if (big === 'pixels') return toast(tr('Страница слишком большая, чтобы собрать PSD на этом устройстве ({0}×{1}). Сохраните её на компьютере.', page.width, page.height));
    // Let the button show «PSD…» before the long synchronous work starts.
    await new Promise((r) => setTimeout(r, 30));
    const bytes = exportPsd(platform.backend, { ...page, blocks: blocksRef.current }, original, cleaned, defaults);
    await platform.saveFile(`${(title || 'page').slice(0, 60)}.psd`, bytes, 'image/vnd.adobe.photoshop');
  });

  const fitText = (b: TextBlock) => {
    const style = { ...(b.style ?? {}) };
    delete style.fontSize;
    updateBlock(b.id, { textBox: undefined, style });
  };

  const addFont = async (file: File) => {
    const id = sel?.id;
    const raw = file.name.replace(/\.[^.]+$/, '').replace(/[^\p{L}\p{N}\- ]/gu, '').trim().slice(0, 40);
    // Names must not collide: a second «Custom» would replace the first one in the database.
    let name = raw || 'Custom';
    for (let n = 2; fonts.includes(`"${name}"`); n++) name = `${raw || 'Custom'} ${n}`;
    const bytes = await file.arrayBuffer();
    await registerUserFont(name, bytes);
    await saveUserFont(platform.db, name, bytes).catch(() => undefined);
    setFonts((f) => [...f, `"${name}"`]);
    if (id) updateStyle(id, { fontFamily: `"${name}", sans-serif` });
    toast(tr('Шрифт «{0}» добавлен', name));
  };

  /** Tab / Shift+Tab in the translation: the next / previous block, the cursor stays in the field. */
  const onTextKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Tab' || e.ctrlKey || e.metaKey || e.altKey || !blocks.length) return;
    e.preventDefault();
    endTyping();
    const i = blocks.findIndex((b) => b.id === selected);
    const next = blocks[(i + (e.shiftKey ? -1 : 1) + blocks.length) % blocks.length];
    select(next);
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    });
  };

  const usage = page.usage.reduce((a, u) => ({ input: a.input + u.inputTokens, output: a.output + u.outputTokens, cost: a.cost + u.costUsd }), { input: 0, output: 0, cost: 0 });
  const st = sel ? resolveStyle(sel, defaults) : null;
  const toolBtn = (t: Tool, icon: string, label: string, key?: string) => (
    <button className={`ait-pal-btn ${tool === t ? 'active' : ''}`} onClick={() => setTool(t)} title={key ? `${label} (${key})` : label} aria-label={label} aria-pressed={tool === t}>
      {icon}
    </button>
  );
  const painting = tool === 'brush' || tool === 'eraser' || tool === 'inpaint';
  /** Text over artwork was painted over simply and LaMa is not set up here: offer it. */
  const artHint = (page.artText ?? 0) > 0 && !page.artRedrawn && !!platform.lama && !!platform.inpaint && !!updateSettings && lamaHave !== null && !(lamaHave && lamaModeOf(settings) === 'browser');
  /** Long strips get a minimap: where the pictures meet, where the blocks and the remarks are. */
  const showMinimap = page.height > page.width * 2.5 || (marks?.length ?? 0) > 0;
  const minimapJump = (clientY: number, el: HTMLElement) => {
    const stage = stageRef.current;
    const inner = innerRef.current;
    if (!stage || !inner) return;
    const r = el.getBoundingClientRect();
    const y = Math.max(0, Math.min(1, (clientY - r.top) / r.height)) * page.height;
    stage.scrollTop = inner.offsetTop + y * zoom - stage.clientHeight / 2;
  };

  return (
    <div>
      <div className="ait-toolbar ait-toolbar-sticky">
        {onClose ? <button className="ait-btn small ghost" onClick={() => void confirmLeave(guard).then((ok) => ok && onClose())}>{tr('← Назад')}</button> : null}
        {title ? <strong style={{ marginRight: 8 }}>{title}</strong> : null}
        {toolbarExtra}
        <button
          className="ait-btn small"
          title={tr('Сохранить страницу для Photoshop: оригинал, очищенная картинка и каждый текст отдельным слоем')}
          onClick={() => void psd.run()}
          disabled={psd.busy}
        >
          {psd.busy ? 'PSD…' : 'PSD'}
        </button>
        <span style={{ flex: 1 }} />
        <button className="ait-bubble-btn" style={{ fontSize: 16, minHeight: 36, padding: '4px 18px' }} onClick={() => void saveNow()} disabled={saving || !dirty} title={tr('Сохранить (Ctrl+S)')}>
          {saving ? tr('Сохраняю…') : dirty ? tr('Сохранить') : tr('Сохранено')}
        </button>
      </div>
      <ErrorBox error={saveError || ocr.error || psd.error} />
      <div className="ait-editor">
        <div className="ait-stage-wrap" ref={wrapRef}>
        {/* The tools live on the page itself, always in reach while scrolling. */}
        <div className="ait-palette" role="toolbar" aria-label={tr('Инструменты')} data-testid="palette">
          {toolBtn('select', '↖', tr('Выбор'), 'V')}
          {toolBtn('brush', '🖌', tr('Кисть'), 'B')}
          {toolBtn('eraser', '⌫', tr('Ластик'), 'E')}
          {toolBtn('inpaint', '◍', lamaReady ? tr('Дорисовать фон (LaMa)') : tr('Заливка фона'))}
          {lamaBusy ? <span className="ait-pal-val" role="status" aria-live="polite" data-testid="lama-busy" title={tr('LaMa дорисовывает фон…')}>…</span> : null}
          {toolBtn('ocr', 'OCR', tr('Ручной OCR'))}
          {onCrop ? toolBtn('crop', '⛶', tr('Обрезать страницу: обведите, что оставить'), 'C') : null}
          {toolBtn('picker', '⊙', tr('Пипетка: взять цвет для кисти с картинки (Alt+щелчок кистью)'), 'I')}
          <input className="ait-pal-color" type="color" value={brushColor} onChange={(e) => setBrushColor(e.target.value)} aria-label={tr('Цвет кисти')} title={tr('Цвет кисти')} data-testid="brush-color" />
          {painting ? (
            <div className="ait-pal-group" aria-label={tr('Размер кисти')}>
              <button className="ait-pal-btn" onClick={() => setBrush((b) => Math.min(200, b + 4))} title={tr('Больше ( ] ). Или зажмите правую кнопку мыши и тяните')} aria-label={tr('Кисть больше')}>+</button>
              <input className="ait-pal-range" type="range" min={1} max={200} value={brush} onChange={(e) => setBrush(Number(e.target.value))} aria-label={tr('Размер кисти')} />
              <span className="ait-pal-val">{brush}</span>
              <button className="ait-pal-btn" onClick={() => setBrush((b) => Math.max(1, b - 4))} title={tr('Меньше ( [ )')} aria-label={tr('Кисть меньше')}>−</button>
            </div>
          ) : null}
          <span className="ait-pal-sep" />
          <button className="ait-pal-btn" onClick={undo} disabled={!history.canUndo} title={`${tr('Отменить')} (Ctrl+Z)`} aria-label={tr('Отменить')}>↶</button>
          <button className="ait-pal-btn" onClick={redo} disabled={!history.canRedo} title={`${tr('Повторить')} (Ctrl+Shift+Z)`} aria-label={tr('Повторить')}>↷</button>
          <span className="ait-pal-sep" />
          <button className="ait-pal-btn" onClick={() => setZoom((z) => Math.min(6, +(z * 1.25).toFixed(3)))} title={tr('Увеличить (Ctrl+колесо)')} aria-label={tr('Увеличить')}>+</button>
          <span className="ait-pal-val">{Math.round(zoom * 100)}%</span>
          <button className="ait-pal-btn" onClick={() => setZoom((z) => Math.max(0.1, +(z / 1.25).toFixed(3)))} title={tr('Уменьшить')} aria-label={tr('Уменьшить')}>−</button>
          <button className="ait-pal-btn" onClick={() => setZoom(fitZoom())} title={tr('По ширине')} aria-label={tr('По ширине')}>↔</button>
          <button className={`ait-pal-btn ${compare ? 'active' : ''}`} onClick={() => setCompare((c) => !c)} aria-pressed={compare} title={tr('Сравнить с оригиналом')} aria-label={tr('Сравнить')}>◐</button>
        </div>
        <canvas ref={overlayRef} className="ait-stroke-overlay" aria-hidden style={{ display: 'none' }} />
        {showMinimap ? (
          <div
            className="ait-minimap"
            data-testid="minimap"
            aria-hidden
            title={tr('Карта ленты: щёлкните, чтобы перейти')}
            onPointerDown={(e) => {
              e.preventDefault();
              const el = e.currentTarget;
              minimapJump(e.clientY, el);
              const move = (ev: PointerEvent) => minimapJump(ev.clientY, el);
              const up = () => {
                window.removeEventListener('pointermove', move);
                window.removeEventListener('pointerup', up);
              };
              window.addEventListener('pointermove', move);
              window.addEventListener('pointerup', up);
            }}
          >
            <div className="ait-minimap-view" style={{ top: `${(view[0] / page.height) * 100}%`, height: `${Math.max(1, ((view[1] - view[0]) / page.height) * 100)}%` }} />
            {marks?.map((y) => <div key={`mm${y}`} className="ait-minimap-mark" style={{ top: `${(y / page.height) * 100}%` }} />)}
            {blocks.map((b) => {
              const box = targetBox(b, defaults);
              const remark = hasRemark(b, overflow);
              return (
                <div
                  key={b.id}
                  className={`ait-minimap-dot ${remark ? 'remark' : ''} ${b.id === selected || multi.has(b.id) ? 'selected' : ''}`}
                  style={{ top: `${((box[1] + box[3] / 2) / page.height) * 100}%` }}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    setTool('select');
                    select(b);
                  }}
                />
              );
            })}
          </div>
        ) : null}
        {painting && cursorAt ? (
          <div
            className={`ait-brush-cursor ${tool}`}
            aria-hidden
            style={{ left: cursorAt[0], top: cursorAt[1], width: Math.max(4, brush * zoom), height: Math.max(4, brush * zoom), borderColor: tool === 'brush' ? brushColor : undefined }}
          />
        ) : null}
        <div
          ref={stageRef}
          className={`ait-stage ${tool === 'select' ? '' : 'drawing'}`}
          onPointerDown={onStagePointerDown}
          onScroll={onStageScroll}
          onPointerMove={(e) => {
            const r = wrapRef.current?.getBoundingClientRect();
            if (r && painting && !resizing.current) setCursorAt([e.clientX - r.left, e.clientY - r.top]);
          }}
          onContextMenu={(e) => {
            if (painting) e.preventDefault();
          }}
          onPointerLeave={() => setCursorAt(null)}
          style={{ cursor: tool === 'select' ? 'default' : tool === 'picker' ? 'copy' : painting ? 'none' : 'crosshair' }}
        >
          <div ref={innerRef} className="ait-stage-inner" style={{ width: page.width * zoom, height: page.height * zoom }}>
            {marks?.map((y) => <div key={`m${y}`} className="ait-page-mark" style={{ top: y * zoom }} aria-hidden />)}
            {ocrFrame ? (
              <div className={`ait-ocr-frame ${tool === 'crop' ? 'crop' : ''}`} data-testid="ocr-frame" style={{ left: ocrFrame[0] * zoom, top: ocrFrame[1] * zoom, width: ocrFrame[2] * zoom, height: ocrFrame[3] * zoom }}>
                <span>{Math.round(ocrFrame[2])}×{Math.round(ocrFrame[3])}</span>
              </div>
            ) : null}
            <div style={{ position: 'absolute', left: 0, top: 0, width: page.width, height: page.height, transform: `scale(${zoom})`, transformOrigin: '0 0' }}>
              {cleaned.tiles.map((t, i) => (
                <canvas
                  key={`r${t.y}`}
                  ref={(el) => {
                    tileCanvases.current[i] = el;
                  }}
                  width={cleaned.width}
                  height={t.h}
                  style={{ position: 'absolute', left: 0, top: t.y, clipPath: compare ? `inset(0 0 0 ${split * 100}%)` : undefined }}
                />
              ))}
              {compare
                ? original.tiles.map((t, i) => (
                    <canvas
                      key={`o${t.y}`}
                      ref={(el) => {
                        origCanvases.current[i] = el;
                      }}
                      width={original.width}
                      height={t.h}
                      style={{ position: 'absolute', left: 0, top: t.y, clipPath: `inset(0 ${(1 - split) * 100}% 0 0)` }}
                    />
                  ))
                : null}
              {!compare && tool === 'select'
                ? blocks.map((b) => {
                    // Keep the frame on the picture: a box sticking out above the page cannot be grabbed.
                    const raw = targetBox(b, defaults);
                    const bx = Math.max(0, Math.min(raw[0], page.width - 8));
                    const by = Math.max(0, Math.min(raw[1], page.height - 8));
                    const box: [number, number, number, number] = [bx, by, Math.min(raw[0] + raw[2], page.width) - bx, Math.min(raw[1] + raw[3], page.height) - by];
                    const rot = resolveStyle(b, defaults).rotation;
                    return (
                      <div
                        key={b.id}
                        className={`ait-box ${b.id === selected ? 'selected' : multi.has(b.id) ? 'selected multi' : ''} ${overflow.has(b.id) ? 'overflow' : ''}`}
                        style={{ left: box[0], top: box[1], width: box[2], height: box[3], transform: rot ? `rotate(${rot}deg)` : undefined, borderWidth: 1.5 / zoom }}
                        onPointerDown={(e) => startDrag(e, b, 'move')}
                        title={b.translatedText}
                      >
                        {b.id === selected ? (
                          <>
                            <span className="handle" style={{ transform: `scale(${1 / zoom})` }} onPointerDown={(e) => startDrag(e, b, 'resize')} />
                            <span className="rot" style={{ transform: `scale(${1 / zoom})` }} onPointerDown={(e) => startDrag(e, b, 'rotate')} />
                          </>
                        ) : null}
                      </div>
                    );
                  })
                : null}
              {compare ? (
                <div className="ait-compare">
                  <div
                    className="ait-compare-handle"
                    style={{ left: `${split * 100}%`, transform: `scaleX(${1 / zoom})` }}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      const move = (ev: PointerEvent) => setSplit(Math.max(0, Math.min(1, toPage(ev.clientX, ev.clientY)[0] / page.width)));
                      const up = () => {
                        window.removeEventListener('pointermove', move);
                        window.removeEventListener('pointerup', up);
                      };
                      window.addEventListener('pointermove', move);
                      window.addEventListener('pointerup', up);
                    }}
                    role="slider"
                    tabIndex={0}
                    aria-label={tr('Оригинал / перевод')}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(split * 100)}
                    onKeyDown={(e) => {
                      const step = e.shiftKey ? 0.2 : 0.05;
                      if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') setSplit((v) => Math.max(0, v - step));
                      else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') setSplit((v) => Math.min(1, v + step));
                      else if (e.key === 'Home') setSplit(0);
                      else if (e.key === 'End') setSplit(1);
                      else return;
                      e.preventDefault();
                      e.stopPropagation();
                    }}
                  />
                </div>
              ) : null}
            </div>
          </div>
        </div>

        </div>
        <div className="ait-props">
          {artHint ? (
            <div className="ait-notice" data-testid="lama-hint" style={{ display: 'grid', gap: 6, marginBottom: 8 }}>
              <small>{tr('Текст поверх рисунка ({0}) стёрт простой заливкой. С нейросетью LaMa фон дорисуется аккуратнее: инструмент ◍ и новый перевод страницы (⟳).', page.artText)}</small>
              <LamaGetButton update={updateSettings!} small downloaded={lamaHave} label={lamaHave ? tr('Включить LaMa') : tr('Включить LaMa (~200 МБ)')} onDone={() => setLamaHave(true)} />
            </div>
          ) : null}
          {sel && st ? (
            <div className="ait-panel">
              {sel.check?.refs.length ? (
                <div className={sel.check.verdict === 'differs' ? 'ait-notice' : 'ait-panel-soft'} data-testid="check-report" style={{ display: 'grid', gap: 4, marginBottom: 8 }}>
                  <b>{sel.check.verdict === 'differs' ? tr('⚖ Сверка: есть расхождение') : tr('⚖ Сверка: совпадает по смыслу')}</b>
                  {sel.check.note ? <small>{sel.check.note}</small> : null}
                  {sel.check.better ? (
                    <small>
                      {tr('Вариант судьи: «{0}»', sel.check.better)}{' '}
                      {sel.check.better !== sel.translatedText ? <button className="pp-link" onClick={() => updateBlock(sel.id, { translatedText: sel.check!.better! })}>{tr('Взять')}</button> : null}
                    </small>
                  ) : null}
                  {sel.check.refs.map((r) => (
                    <small key={r.by}>
                      <b>{r.by}:</b> {r.text}{' '}
                      {r.text !== sel.translatedText ? <button className="pp-link" onClick={() => updateBlock(sel.id, { translatedText: r.text })}>{tr('Взять')}</button> : null}
                    </small>
                  ))}
                  {sel.check.before !== undefined && sel.check.before !== sel.translatedText ? (
                    <small>
                      {tr('Исправлено сверкой. Было: «{0}»', sel.check.before)}{' '}
                      <button className="pp-link" onClick={() => updateBlock(sel.id, { translatedText: sel.check!.before! })}>{tr('Вернуть')}</button>
                    </small>
                  ) : null}
                </div>
              ) : null}
              {sel.qa && (sel.qa.issues.length || sel.qa.before !== undefined) ? (
                <div className="ait-notice" data-testid="qa-report" style={{ display: 'grid', gap: 4, marginBottom: 8 }}>
                  <b>{tr('Проверка перевода')}</b>
                  {sel.qa.issues.map((q, i) => (
                    <small key={i}>
                      {q.severity === 'major' ? '⚠' : '•'} {QA_LABELS[q.kind]}: {qaNote(q)}
                    </small>
                  ))}
                  {sel.qa.before !== undefined ? (
                    <small>
                      {tr('Исправлено автоматически. Было: «{0}»', sel.qa.before)}{' '}
                      <button className="pp-link" onClick={() => commitWith((prev) => prev.map((b) => (b.id === sel.id ? { ...b, translatedText: sel.qa!.before!, qa: { ...sel.qa!, before: undefined }, edited: true } : b)))}>
                        {tr('Вернуть')}
                      </button>
                    </small>
                  ) : null}
                </div>
              ) : null}
              {multi.size ? <p className="ait-notice" data-testid="multi-note">{tr('Выбрано блоков: {0}. Стиль меняется у всех выбранных (Esc — снять выбор).', multi.size + 1)}</p> : null}
              <Field label={tr('Перевод')}>
                <button className="ait-copy" onClick={() => copyText(sel.translatedText)} title={tr('Копировать перевод')} aria-label={tr('Копировать перевод')}>⧉</button>
                <textarea ref={textareaRef} className="ait-textarea" value={sel.translatedText} onChange={(e) => typeText(sel.id, 'translatedText', e.target.value)} onBlur={endTyping} onKeyDown={onTextKey} title={tr('Tab / Shift+Tab — следующий / предыдущий блок')} />
              </Field>
              <div style={{ marginTop: 8 }}>
                <Field label={tr('Оригинал')}>
                  <button className="ait-copy" onClick={() => copyText(sel.originalText)} title={tr('Копировать оригинал')} aria-label={tr('Копировать оригинал')}>⧉</button>
                  <input className="ait-input" value={sel.originalText} onChange={(e) => typeText(sel.id, 'originalText', e.target.value)} onBlur={endTyping} />
                </Field>
              </div>
              <div className="ait-row" style={{ marginTop: 8 }}>
                <button className="ait-btn small" onClick={() => void retr.run()} disabled={retr.busy}>{retr.busy ? tr('Перевожу…') : tr('Перевести заново')}</button>
                <button className="ait-btn small" onClick={() => fitText(sel)} title={tr('Подобрать размер текста под бабл')}>{tr('Вписать текст')}</button>
                <button className="ait-btn small" onClick={() => void backTr.run()} disabled={backTr.busy} title={tr('Перевести наш перевод обратно, чтобы проверить смысл')}>{backTr.busy ? tr('Перевожу…') : tr('Обратный перевод')}</button>
              </div>
              {back && back.id === sel.id ? (
                <small className="ait-muted" data-testid="back-translation" style={{ display: 'block', marginTop: 4 }}>
                  ↩ {back.text} <i>({back.by})</i>
                </small>
              ) : null}
              <ErrorBox error={backTr.error} />
              <div className="ait-row" style={{ marginTop: 6, flexWrap: 'wrap' }}>
                <button className="ait-btn small" onClick={() => { setStyleClip({ ...(sel.style ?? {}) }); toast(tr('Стиль скопирован')); }}>{tr('Копировать стиль')}</button>
                <button className="ait-btn small" disabled={!styleClip} onClick={() => styleClip && commitWith((prev) => prev.map((b) => (targets.has(b.id) ? { ...b, style: { ...(b.style ?? {}), ...styleClip }, edited: true } : b)))}>{tr('Вставить стиль')}</button>
                <button className="ait-btn small" title={tr('Применить стиль этого блока ко всем блокам того же типа')} onClick={() => commitWith((prev) => prev.map((b) => (b.textType === sel.textType && b.id !== sel.id ? { ...b, style: { ...(b.style ?? {}), ...(sel.style ?? {}), fontSize: b.style?.fontSize ?? null }, edited: true } : b)))}>
                  {tr('Стиль ко всем {0}', sel.textType)}
                </button>
              </div>
              <ErrorBox error={retr.error} />
              {overflow.has(sel.id) ? <p className="ait-notice" style={{ marginTop: 8 }}>{tr('Текст не помещается: уменьшите кегль, сократите перевод или растяните рамку.')}</p> : null}
              <div className="ait-grid2" style={{ marginTop: 10, gridTemplateColumns: '1fr 1fr' }}>
                <Field label={tr('Тип')}>
                  <select className="ait-select" value={sel.textType} onChange={(e) => updateBlock(sel.id, { textType: e.target.value as TextBlock['textType'] })}>
                    {TEXT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </Field>
                <Field label={tr('Кегль')}>
                  <div style={{ display: 'flex', gap: 4, alignItems: 'center' }} data-testid="font-size">
                    <button className="ait-btn small" aria-label={tr('Шрифт меньше')} title={tr('Шрифт меньше')} onClick={() => updateStyle(sel.id, { fontSize: Math.max(6, (sel.style?.fontSize ?? autoSize) - 2) })}>A−</button>
                    <input className="ait-input" style={{ minWidth: 0 }} type="number" min={6} max={200} placeholder={String(autoSize)} value={sel.style?.fontSize ?? ''} onChange={(e) => updateStyle(sel.id, { fontSize: e.target.value ? Number(e.target.value) : null })} aria-label={tr('Кегль')} />
                    <button className="ait-btn small" aria-label={tr('Шрифт больше')} title={tr('Шрифт больше')} onClick={() => updateStyle(sel.id, { fontSize: Math.min(200, (sel.style?.fontSize ?? autoSize) + 2) })}>A+</button>
                  </div>
                  {sel.style?.fontSize != null ? (
                    <button className="pp-link" style={{ fontSize: 12 }} onClick={() => updateStyle(sel.id, { fontSize: null })}>{tr('авто ({0})', autoSize)}</button>
                  ) : null}
                </Field>
                <div style={{ gridColumn: '1 / -1' }}>
                  <Field label={tr('Шрифт')}>
                    <input className="ait-input" type="search" placeholder={tr('Поиск шрифта')} value={fontQuery} onChange={(e) => setFontQuery(e.target.value)} aria-label={tr('Поиск шрифта')} style={{ marginBottom: 4 }} />
                    <select className="ait-select" value={sel.style?.fontFamily ?? ''} onChange={(e) => updateStyle(sel.id, { fontFamily: e.target.value || undefined })}>
                      <option value="">{tr('По типу текста')}</option>
                      {fonts.filter((f) => !fontQuery || f.toLowerCase().includes(fontQuery.toLowerCase()) || `${f}, sans-serif` === sel.style?.fontFamily).map((f) => <option key={f} value={`${f}, sans-serif`} style={{ fontFamily: f }}>{f.replace(/"/g, '')}</option>)}
                    </select>
                  </Field>
                  <div className="ait-font-preview" style={{ fontFamily: st.fontFamily, fontWeight: st.bold ? 700 : 400, color: st.color, WebkitTextStroke: st.strokeColor && st.strokeWidth ? `${Math.min(2, st.strokeWidth / 3)}px ${st.strokeColor}` : undefined }}>
                    {(st.uppercase ? sel.translatedText.toUpperCase() : sel.translatedText).slice(0, 60) || tr('Пример текста')}
                  </div>
                  <label className="ait-hint" style={{ display: 'block' }}>
                    {tr('Свой шрифт (TTF/OTF/WOFF2):')}{' '}<input type="file" accept=".ttf,.otf,.woff,.woff2" onChange={(e) => e.target.files?.[0] && void addFont(e.target.files[0])} />
                  </label>
                </div>
                <Field label={tr('Цвет')}>
                  <input type="color" value={st.color} onChange={(e) => updateStyle(sel.id, { color: e.target.value })} />
                </Field>
                <Field label={tr('Обводка')}>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <input type="color" value={st.strokeColor ?? '#ffffff'} onChange={(e) => updateStyle(sel.id, { strokeColor: e.target.value, strokeWidth: st.strokeWidth || 3 })} />
                    <input className="ait-input" type="number" min={0} max={20} value={st.strokeWidth} onChange={(e) => updateStyle(sel.id, { strokeWidth: Number(e.target.value), strokeColor: st.strokeColor ?? '#ffffff' })} />
                  </div>
                </Field>
                <Field label={tr('Выравнивание')}>
                  <select className="ait-select" value={st.alignment} onChange={(e) => updateStyle(sel.id, { alignment: e.target.value as TextStyle['alignment'] })}>
                    <option value="center">{tr('По центру')}</option>
                    <option value="left">{tr('Влево')}</option>
                    <option value="right">{tr('Вправо')}</option>
                  </select>
                </Field>
                <Field label={tr('Поворот, °')}>
                  <input className="ait-input" type="number" min={-180} max={180} value={st.rotation} onChange={(e) => updateStyle(sel.id, { rotation: Number(e.target.value) })} />
                </Field>
                <div style={{ gridColumn: '1 / -1' }}>
                  <Field label={tr('Прозрачность: {0}%', Math.round(st.opacity * 100))}>
                    <input type="range" min={0.1} max={1} step={0.05} value={st.opacity} onChange={(e) => updateStyle(sel.id, { opacity: Number(e.target.value) })} />
                  </Field>
                </div>
              </div>
              <div style={{ display: 'grid', gap: 8, marginTop: 10 }}>
                <Switch checked={st.vertical} onChange={(v) => updateStyle(sel.id, { vertical: v })} label={tr('Вертикальный текст')} />
                <Switch checked={st.bold} onChange={(v) => updateStyle(sel.id, { bold: v })} label={tr('Жирный')} />
                <Switch checked={st.shadow} onChange={(v) => updateStyle(sel.id, { shadow: v })} label={tr('Тень')} />
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <Switch checked={!!st.glow} onChange={(v) => updateStyle(sel.id, { glow: v ? st.glow ?? '#ffffff' : null })} label={tr('Свечение')} />
                  {st.glow ? (
                    <>
                      <input type="color" value={st.glow} onChange={(e) => updateStyle(sel.id, { glow: e.target.value })} aria-label={tr('Цвет свечения')} />
                      <input type="range" min={1} max={20} value={st.glowSize ?? 6} onChange={(e) => updateStyle(sel.id, { glowSize: Number(e.target.value) })} aria-label={tr('Размер свечения')} />
                    </>
                  ) : null}
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <Switch checked={!!st.gradient} onChange={(v) => updateStyle(sel.id, { gradient: v ? st.gradient ?? '#c8205f' : null })} label={tr('Градиент')} />
                  {st.gradient ? <input type="color" value={st.gradient} onChange={(e) => updateStyle(sel.id, { gradient: e.target.value })} aria-label={tr('Второй цвет градиента')} /> : null}
                </div>
                <Field label={tr('Межбуквенный интервал: {0}%', Math.round((st.letterSpacing ?? 0) * 100))}>
                  <input type="range" min={-0.05} max={0.4} step={0.01} value={st.letterSpacing ?? 0} onChange={(e) => updateStyle(sel.id, { letterSpacing: Number(e.target.value) || undefined })} />
                </Field>
                <Switch checked={sel.translate} onChange={(v) => updateBlock(sel.id, { translate: v })} label={tr('Показывать перевод')} />
              </div>
              <button className="ait-btn small danger" style={{ marginTop: 12 }} onClick={() => { const id = sel.id; commitWith((prev) => prev.filter((b) => b.id !== id)); setSelected(null); setMulti(new Set()); }}>
                {tr('Удалить блок')}
              </button>
            </div>
          ) : (
            <div className="ait-panel ait-muted">{tr('Выберите блок текста на странице или в списке ниже. Инструмент «Ручной OCR» добавляет пропущенный текст: обведите его рамкой.')}</div>
          )}

          <div className="ait-panel">
            <h2 style={{ fontSize: 14 }}>{tr('Блоки (')}{blocks.length})</h2>
            <div className="ait-row" style={{ flexWrap: 'wrap', marginBottom: 6 }}>
              <button className="ait-btn small" data-testid="check-page" onClick={() => void check.run()} disabled={check.busy || !blocks.length} title={tr('Сравнить перевод страницы с другими переводчиками (Настройки → Сверка)')}>
                {check.busy ? tr('Сверяю…') : tr('⚖ Сверить страницу')}
              </button>
            </div>
            <div className="ait-row" style={{ flexWrap: 'wrap', marginBottom: 6, alignItems: 'center' }} data-testid="remark-nav">
              <button className="ait-btn small" onClick={() => jumpRemark(-1)} disabled={!remarks.length} title={tr('Предыдущее замечание (Shift+N)')}>↑</button>
              <button className="ait-btn small" onClick={() => jumpRemark(1)} disabled={!remarks.length} title={tr('Следующее замечание: ⚖ сверка, 🔍 проверка или текст не помещается (N)')}>
                {tr('Следующее замечание')}
              </button>
              <small className="ait-muted">{remarks.length ? tr('Замечаний: {0}', remarks.length) : tr('Замечаний нет')}</small>
            </div>
            <ErrorBox error={check.error} />
            <div className="ait-row" style={{ flexWrap: 'wrap', marginBottom: 6 }} data-testid="texts-io">
              <button
                className="ait-btn small"
                data-testid="chapter-text"
                title={tr('Оригинал и перевод всех реплик главы одним файлом .txt')}
                onClick={async () => {
                  // The other pages of the chapter as saved, this page as it is now in the editor.
                  const pages = chapterTexts ? await chapterTexts(blocks).catch(() => [blocks]) : [blocks];
                  const text = pages.length > 1 ? exportChapterTexts(pages, title) : exportTexts(blocks, title, 'txt');
                  await platform.saveFile(`${(title || tr('Глава')).slice(0, 60)}.txt`, new TextEncoder().encode(text), 'text/plain');
                }}
              >
                {tr('Скачать весь текст с главы')}
              </button>
              <button className="ait-btn small" onClick={() => void platform.saveFile(`${(title || 'page').slice(0, 60)}.json`, new TextEncoder().encode(exportTexts(blocks, title, 'json')), 'application/json')}>JSON</button>
              <label className="ait-btn small" style={{ cursor: 'pointer' }}>
                {tr('Загрузить тексты')}
                <input
                  type="file"
                  accept=".txt,.json"
                  hidden
                  onChange={async (e) => {
                    const f = e.target.files?.[0];
                    e.target.value = '';
                    if (!f) return;
                    const text = await f.text();
                    const { blocks: next, changed } = importTexts(blocksRef.current, text);
                    if (changed) commitBlocks(next);
                    toast(tr('Обновлено переводов: {0}', changed));
                  }}
                />
              </label>
            </div>
            <div className="ait-blocklist">
              {blocks.map((b, i) => (
                <button key={b.id} aria-pressed={b.id === selected || multi.has(b.id)} onClick={(e) => { const add = e.ctrlKey || e.shiftKey || e.metaKey; pick(b.id, add); if (!add) scrollToBlock(b); setTool('select'); }}>
                  {i + 1}. {b.translatedText.slice(0, 40) || <em className="ait-muted">{tr('пусто')}</em>} {overflow.has(b.id) ? '⚠' : ''}
                  {b.check?.verdict === 'differs' ? <span title={b.check.note ?? tr('Расходится с другими переводчиками')}> ⚖</span> : null}
                  {b.qa?.issues.length ? <span title={b.qa.issues.map((q) => `${QA_LABELS[q.kind]}: ${qaNote(q)}`).join('\n')}> 🔍{b.qa.issues.length}</span> : null}
                </button>
              ))}
            </div>
          </div>

          {settings.debug ? (
            <div className="ait-panel">
              <h2 style={{ fontSize: 14 }}>{tr('Отладка')}</h2>
              <div className="ait-debug">
                <span>{tr('Размер')}</span><span>{page.width}×{page.height}</span>
                <span>{tr('Блоков')}</span><span>{page.blocks.length}</span>
                <span>{tr('Детекция')}</span><span>{page.timings.detectMs ?? 0}{' '}{tr('мс')}</span>
                <span>OCR</span><span>{page.timings.ocrMs ?? 0}{' '}{tr('мс')}</span>
                <span>{tr('Перевод')}</span><span>{page.timings.translateMs ?? 0}{' '}{tr('мс')}</span>
                <span>{tr('Очистка')}</span><span>{page.timings.cleanMs ?? 0}{' '}{tr('мс')}</span>
                <span>{tr('Рендер')}</span><span>{page.timings.renderMs ?? 0}{' '}{tr('мс')}</span>
                <span>{tr('Всего')}</span><span>{page.timings.totalMs ?? 0}{' '}{tr('мс')}</span>
                <span>{tr('Модель')}</span><span>{[...new Set(page.usage.map((u) => u.model))].join(', ') || page.source.detectedBy}</span>
                <span>{tr('Токены')}</span><span>{usage.input} / {usage.output}</span>
                <span>{tr('Стоимость')}</span><span>${usage.cost.toFixed(4)}</span>
                <span>{tr('Режим')}</span><span>{page.pipeline.mode}</span>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
