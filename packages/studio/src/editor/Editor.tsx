import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import {
  cleanBlock,
  clampBox,
  ctxMeasurer,
  layoutBlock,
  paintRegion,
  parseHex,
  recognizeRegion,
  renderTiles,
  resolveStyle,
  retranslate,
  styleDefaultsFor,
  targetBox,
  TEXT_TYPES,
  type AppSettings,
  type Box,
  type PageResult,
  type PixelData,
  type TextBlock,
  type TextStyle,
  type TiledImage,
  QA_LABELS,
  qaNote,
} from '@ait/core';
import { loadUserFonts, registerUserFont, saveUserFont } from '../fonts';
import { exportChapterTexts, exportTexts, importTexts } from './texts';
import { exportPsd } from '../psd';
import { usePlatform } from '../platform';
import { ErrorBox, Field, Switch, toast, useAction } from '../ui';
import { tr } from '@ait/core/i18n';

type Tool = 'select' | 'brush' | 'eraser' | 'inpaint' | 'ocr';

type HistoryItem =
  | { kind: 'blocks'; before: TextBlock[]; after: TextBlock[] }
  | { kind: 'pixels'; box: Box; before: PixelData; after: PixelData; blocksBefore?: TextBlock[]; blocksAfter?: TextBlock[] };

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
}

const BASE_FONTS = ['"AIT Lettering"', '"AIT Comic"', '"AIT Narration"', '"AIT SFX"', 'Arial', '"Comic Sans MS"', '"Times New Roman"', 'Georgia', 'Impact'];
const MAX_HISTORY = 60;

function clonePixels(p: PixelData): PixelData {
  return { width: p.width, height: p.height, data: new Uint8ClampedArray(p.data) };
}

export function Editor({ page, original, cleaned, settings, onSave, onClose, title, marks, toolbarExtra, chapterTexts }: EditorProps) {
  const platform = usePlatform();
  const [blocks, setBlocks] = useState<TextBlock[]>(page.blocks);
  const [selected, setSelected] = useState<string | null>(page.blocks[0]?.id ?? null);
  const [tool, setTool] = useState<Tool>('select');
  const [brush, setBrush] = useState(20);
  const [brushColor, setBrushColor] = useState('#ffffff');
  const [zoom, setZoom] = useState(() => Math.min(1, 900 / page.width));
  const [compare, setCompare] = useState(false);
  const [split, setSplit] = useState(0.5);
  const [version, setVersion] = useState(0); // bumps when cleaned pixels change
  const [pixelsChanged, setPixelsChanged] = useState(false);
  const [overflow, setOverflow] = useState<Set<string>>(new Set());
  const [fonts, setFonts] = useState<string[]>(BASE_FONTS);
  const [dirty, setDirty] = useState(false);
  /** Blocks selected together with `selected` (Ctrl/Shift+click): style changes apply to all of them. */
  const [multi, setMulti] = useState<Set<string>>(new Set());
  const [styleClip, setStyleClip] = useState<Partial<TextStyle> | null>(null);
  const [fontQuery, setFontQuery] = useState('');
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const toolRef = useRef(tool);
  toolRef.current = tool;
  const undoStack = useRef<HistoryItem[]>([]);
  const redoStack = useRef<HistoryItem[]>([]);
  const [, forceHistory] = useState(0);
  const tileCanvases = useRef<(HTMLCanvasElement | null)[]>([]);
  const origCanvases = useRef<(HTMLCanvasElement | null)[]>([]);
  const innerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  /** Where the brush outline is drawn (inside the editor frame), or nowhere. */
  const [cursorAt, setCursorAt] = useState<[number, number] | null>(null);
  /** Manual OCR: the frame being stretched, in page pixels. */
  const [ocrFrame, setOcrFrame] = useState<Box | null>(null);
  const fitZoom = useCallback(() => {
    const w = stageRef.current?.clientWidth ?? 900;
    return Math.max(0.1, Math.min(1, (w - 56) / page.width));
  }, [page.width]);
  useEffect(() => {
    setZoom(fitZoom());
  }, [fitZoom]);
  const strokeCanvas = useRef<HTMLCanvasElement>(null);
  const editStart = useRef<TextBlock[] | null>(null);
  const defaults = useMemo(() => styleDefaultsFor({ targetLang: page.targetLang, sfxStyle: settings.sfxStyle }, settings.fonts), [page.targetLang, settings.sfxStyle, settings.fonts]);

  const push = (item: HistoryItem) => {
    undoStack.current.push(item);
    if (undoStack.current.length > MAX_HISTORY) undoStack.current.shift();
    redoStack.current = [];
    setDirty(true);
    forceHistory((n) => n + 1);
  };

  const commitBlocks = useCallback(
    (next: TextBlock[], before = blocks) => {
      push({ kind: 'blocks', before, after: next });
      setBlocks(next);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [blocks],
  );

  // ---- rendering --------------------------------------------------------------------
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      const { tiles, overflow: of } = renderTiles(platform.backend, cleaned, blocks, defaults);
      tiles.forEach((t, i) => {
        const c = tileCanvases.current[i];
        if (!c) return;
        c.getContext('2d')!.clearRect(0, 0, c.width, c.height);
        c.getContext('2d')!.drawImage(t.canvas as unknown as CanvasImageSource, 0, 0);
      });
      setOverflow(of);
    });
    return () => cancelAnimationFrame(id);
  }, [blocks, cleaned, defaults, platform.backend, version]);

  useEffect(() => {
    original.tiles.forEach((t, i) => {
      const c = origCanvases.current[i];
      if (c) c.getContext('2d')!.drawImage(t.canvas as unknown as CanvasImageSource, 0, 0);
    });
  }, [original, compare]);

  // ---- undo / redo --------------------------------------------------------------------
  const applyHistory = (item: HistoryItem, dir: 'undo' | 'redo') => {
    if (item.kind === 'blocks') setBlocks(dir === 'undo' ? item.before : item.after);
    else {
      cleaned.putRegion(dir === 'undo' ? item.before : item.after, item.box[0], item.box[1]);
      if (item.blocksBefore && item.blocksAfter) setBlocks(dir === 'undo' ? item.blocksBefore : item.blocksAfter);
      setVersion((v) => v + 1);
      setPixelsChanged(true);
    }
    setDirty(true);
  };
  const undo = () => {
    const it = undoStack.current.pop();
    if (!it) return;
    applyHistory(it, 'undo');
    redoStack.current.push(it);
    forceHistory((n) => n + 1);
  };
  const redo = () => {
    const it = redoStack.current.pop();
    if (!it) return;
    applyHistory(it, 'redo');
    undoStack.current.push(it);
    forceHistory((n) => n + 1);
  };

  const sel = blocks.find((b) => b.id === selected) ?? null;
  /** The size the selected text gets automatically (shown as the hint, the start for A−/A+). */
  const autoSize = useMemo(() => {
    if (!sel) return 0;
    const m = ctxMeasurer(platform.backend.createCanvas(8, 8).getContext('2d'));
    const b = { ...sel, style: { ...(sel.style ?? {}), fontSize: null } };
    return Math.round(layoutBlock(m, b, defaults, { width: page.width, height: page.height }).fontSize);
  }, [sel, defaults, platform.backend, page.width, page.height]);
  const updateBlock = (id: string, patch: Partial<TextBlock>) => commitBlocks(blocks.map((b) => (b.id === id ? { ...b, ...patch, edited: true } : b)));
  /** The selected block and the others picked with Ctrl/Shift+click. */
  const targets = selected ? new Set([selected, ...multi]) : new Set(multi);
  const updateStyle = (id: string, patch: Partial<TextStyle>) => {
    const ids = id === selected ? targets : new Set([id]);
    commitBlocks(blocks.map((b) => (ids.has(b.id) ? { ...b, style: { ...(b.style ?? {}), ...patch }, edited: true } : b)));
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
        setBrush((b) => Math.max(1, Math.min(100, b + (e.deltaY < 0 ? 2 : -2))));
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

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
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('input, textarea, select')) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) {
        e.preventDefault();
        redo();
      } else if (mod && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        setSelected(blocks[0]?.id ?? null);
        setMulti(new Set(blocks.slice(1).map((b) => b.id)));
      } else if (e.key === 'Escape') {
        setMulti(new Set());
      } else if (e.key === '[' || e.key === ']') {
        setBrush((b) => Math.max(1, Math.min(100, b + (e.key === ']' ? 4 : -4))));
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selected) {
        e.preventDefault();
        commitBlocks(blocks.filter((b) => !targets.has(b.id)));
        setSelected(null);
        setMulti(new Set());
      } else if (selected && e.key.startsWith('Arrow')) {
        e.preventDefault();
        const b = blocks.find((x) => x.id === selected);
        if (!b) return;
        const step = e.shiftKey ? 10 : 1;
        const box = targetBox(b, defaults);
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
        updateBlock(b.id, { textBox: [box[0] + dx, box[1] + dy, box[2], box[3]] });
      } else if (e.key === 'v') setTool('select');
      else if (e.key === 'b') setTool('brush');
      else if (e.key === 'e') setTool('eraser');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // ---- pointer helpers ------------------------------------------------------------------
  const toPage = (clientX: number, clientY: number): [number, number] => {
    const r = innerRef.current!.getBoundingClientRect();
    return [(clientX - r.left) / zoom, (clientY - r.top) / zoom];
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
    const before = blocks;
    const box = targetBox(b, defaults);
    const [sx, sy] = toPage(e.clientX, e.clientY);
    let latest = blocks;
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
      setBlocks(latest);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (latest !== before) push({ kind: 'blocks', before, after: latest });
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
    const next = [...blocks, ...added];
    push({ kind: 'pixels', box: region, before, after, blocksBefore: blocks, blocksAfter: next });
    setBlocks(next);
    setSelected(added[0].id);
    setVersion((v) => v + 1);
    setPixelsChanged(true);
    toast(tr('Добавлено блоков: {0}', added.length));
  });

  const onStagePointerDown = (e: RPointerEvent) => {
    if (e.button === 1) return pan(e);
    if (tool === 'select') {
      setSelected(null);
      setMulti(new Set());
      return;
    }
    e.preventDefault();
    const pts: [number, number][] = [toPage(e.clientX, e.clientY)];
    const overlay = strokeCanvas.current!;
    const octx = overlay.getContext('2d')!;
    octx.clearRect(0, 0, overlay.width, overlay.height);
    const drawPreview = () => {
      octx.clearRect(0, 0, overlay.width, overlay.height);
      if (tool === 'ocr') {
        // The frame being stretched is drawn on top of the page (see .ait-ocr-frame).
        const [x0, y0] = pts[0];
        const [x1, y1] = pts[pts.length - 1];
        setOcrFrame([Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0)]);
        return;
      }
      octx.strokeStyle = tool === 'brush' ? brushColor : tool === 'eraser' ? 'rgba(28,110,216,0.5)' : 'rgba(200,32,95,0.5)';
      octx.lineWidth = brush;
      octx.lineCap = 'round';
      octx.lineJoin = 'round';
      octx.beginPath();
      pts.forEach(([x, y], i) => (i ? octx.lineTo(x, y) : octx.moveTo(x, y)));
      if (pts.length === 1) octx.lineTo(pts[0][0] + 0.1, pts[0][1]);
      octx.stroke();
    };
    drawPreview();
    const move = (ev: PointerEvent) => {
      pts.push(toPage(ev.clientX, ev.clientY));
      drawPreview();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      octx.clearRect(0, 0, overlay.width, overlay.height);
      if (tool === 'ocr') {
        setOcrFrame(null);
        const [x0, y0] = pts[0];
        const [x1, y1] = pts[pts.length - 1];
        const rect: Box = [Math.round(Math.min(x0, x1)), Math.round(Math.min(y0, y1)), Math.round(Math.abs(x1 - x0)), Math.round(Math.abs(y1 - y0))];
        if (rect[2] > 8 && rect[3] > 8) void ocr.run(rect);
        return;
      }
      applyStroke(pts);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const applyStroke = (pts: [number, number][]) => {
    const r = brush / 2;
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const box = clampBox([Math.min(...xs) - r - 2, Math.min(...ys) - r - 2, Math.max(...xs) - Math.min(...xs) + brush + 4, Math.max(...ys) - Math.min(...ys) + brush + 4], cleaned.width, cleaned.height);
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
    const before = clonePixels(cleaned.getRegion(...box));
    if (tool === 'brush') paintRegion(cleaned, box, mask, { kind: 'color', color: parseHex(brushColor) });
    else if (tool === 'inpaint') paintRegion(cleaned, box, mask, { kind: 'inpaint' });
    else if (tool === 'eraser') {
      const orig = original.getRegion(...box);
      const cur = cleaned.getRegion(...box);
      for (let i = 0; i < mask.length; i++) if (mask[i]) for (let c = 0; c < 4; c++) cur.data[i * 4 + c] = orig.data[i * 4 + c];
      cleaned.putRegion(cur, box[0], box[1]);
    }
    const after = clonePixels(cleaned.getRegion(...box));
    push({ kind: 'pixels', box, before, after });
    setPixelsChanged(true);
    setVersion((v) => v + 1);
  };

  // ---- actions -----------------------------------------------------------------------------
  const retr = useAction(async () => {
    if (!sel) return;
    const { config } = await platform.service.config();
    const res = await retranslate([sel], { ...config, targetLang: page.targetLang }, { backend: platform.backend });
    updateBlock(sel.id, { translatedText: res.blocks[0].translatedText });
  });

  const save = useAction(async () => {
    await onSave({ ...page, blocks }, cleaned, pixelsChanged);
    setDirty(false);
    toast(tr('Сохранено'));
  });

  const endTextEdit = () => {
    const start = editStart.current;
    editStart.current = null;
    if (start && start !== blocks) push({ kind: 'blocks', before: start, after: blocks });
  };

  const fitText = (b: TextBlock) => {
    const style = { ...(b.style ?? {}) };
    delete style.fontSize;
    updateBlock(b.id, { textBox: undefined, style });
  };

  const addFont = async (file: File) => {
    const name = file.name.replace(/\.[^.]+$/, '').replace(/[^\w\- ]/g, '').slice(0, 40) || 'Custom';
    const bytes = await file.arrayBuffer();
    await registerUserFont(name, bytes);
    await saveUserFont(platform.db, name, bytes).catch(() => undefined);
    setFonts((f) => [...f, `"${name}"`]);
    if (sel) updateStyle(sel.id, { fontFamily: `"${name}", sans-serif` });
    toast(tr('Шрифт «{0}» добавлен', name));
  };

  const usage = page.usage.reduce((a, u) => ({ input: a.input + u.inputTokens, output: a.output + u.outputTokens, cost: a.cost + u.costUsd }), { input: 0, output: 0, cost: 0 });
  const st = sel ? resolveStyle(sel, defaults) : null;
  const toolBtn = (t: Tool, icon: string, label: string, key?: string) => (
    <button className={`ait-pal-btn ${tool === t ? 'active' : ''}`} onClick={() => setTool(t)} title={key ? `${label} (${key})` : label} aria-label={label} aria-pressed={tool === t}>
      {icon}
    </button>
  );
  const painting = tool === 'brush' || tool === 'eraser' || tool === 'inpaint';

  return (
    <div>
      <div className="ait-toolbar ait-toolbar-sticky">
        {onClose ? <button className="ait-btn small ghost" onClick={() => (!dirty || confirm(tr('Есть несохранённые правки. Закрыть без сохранения?'))) && onClose()}>{tr('← Назад')}</button> : null}
        {title ? <strong style={{ marginRight: 8 }}>{title}</strong> : null}
        {toolbarExtra}
        <button
          className="ait-btn small"
          title={tr('Сохранить страницу для Photoshop: оригинал, очищенная картинка и каждый текст отдельным слоем')}
          onClick={() => {
            if (page.height > 30000 || page.width > 30000) return toast(tr('Страница длиннее 30 000 px — Photoshop такую не откроет'));
            void platform.saveFile(`${(title || 'page').slice(0, 60)}.psd`, exportPsd(platform.backend, { ...page, blocks }, original, cleaned, defaults), 'image/vnd.adobe.photoshop');
          }}
        >
          PSD
        </button>
        <span style={{ flex: 1 }} />
        <button className="ait-bubble-btn" style={{ fontSize: 16, minHeight: 36, padding: '4px 18px' }} onClick={() => void save.run()} disabled={save.busy || !dirty}>
          {save.busy ? tr('Сохраняю…') : dirty ? tr('Сохранить') : tr('Сохранено')}
        </button>
      </div>
      <ErrorBox error={save.error || ocr.error} />
      <div className="ait-editor">
        <div className="ait-stage-wrap" ref={wrapRef}>
        {/* The tools live on the page itself, always in reach while scrolling. */}
        <div className="ait-palette" role="toolbar" aria-label={tr('Инструменты')} data-testid="palette">
          {toolBtn('select', '↖', tr('Выбор'), 'V')}
          {toolBtn('brush', '🖌', tr('Кисть'), 'B')}
          {toolBtn('eraser', '⌫', tr('Ластик'), 'E')}
          {toolBtn('inpaint', '◍', tr('Заливка фона'))}
          {toolBtn('ocr', 'OCR', tr('Ручной OCR'))}
          {painting ? (
            <div className="ait-pal-group" aria-label={tr('Размер кисти')}>
              <button className="ait-pal-btn" onClick={() => setBrush((b) => Math.min(100, b + 4))} title={tr('Больше ( ] )')} aria-label={tr('Кисть больше')}>+</button>
              <input className="ait-pal-range" type="range" min={1} max={100} value={brush} onChange={(e) => setBrush(Number(e.target.value))} aria-label={tr('Размер кисти')} />
              <span className="ait-pal-val">{brush}</span>
              <button className="ait-pal-btn" onClick={() => setBrush((b) => Math.max(1, b - 4))} title={tr('Меньше ( [ )')} aria-label={tr('Кисть меньше')}>−</button>
              {tool === 'brush' ? <input className="ait-pal-color" type="color" value={brushColor} onChange={(e) => setBrushColor(e.target.value)} aria-label={tr('Цвет кисти')} title={tr('Цвет кисти')} /> : null}
            </div>
          ) : null}
          <span className="ait-pal-sep" />
          <button className="ait-pal-btn" onClick={undo} disabled={!undoStack.current.length} title={`${tr('Отменить')} (Ctrl+Z)`} aria-label={tr('Отменить')}>↶</button>
          <button className="ait-pal-btn" onClick={redo} disabled={!redoStack.current.length} title={`${tr('Повторить')} (Ctrl+Shift+Z)`} aria-label={tr('Повторить')}>↷</button>
          <span className="ait-pal-sep" />
          <button className="ait-pal-btn" onClick={() => setZoom((z) => Math.min(6, +(z * 1.25).toFixed(3)))} title={tr('Увеличить (Ctrl+колесо)')} aria-label={tr('Увеличить')}>+</button>
          <span className="ait-pal-val">{Math.round(zoom * 100)}%</span>
          <button className="ait-pal-btn" onClick={() => setZoom((z) => Math.max(0.1, +(z / 1.25).toFixed(3)))} title={tr('Уменьшить')} aria-label={tr('Уменьшить')}>−</button>
          <button className="ait-pal-btn" onClick={() => setZoom(fitZoom())} title={tr('По ширине')} aria-label={tr('По ширине')}>↔</button>
          <button className={`ait-pal-btn ${compare ? 'active' : ''}`} onClick={() => setCompare((c) => !c)} aria-pressed={compare} title={tr('Сравнить с оригиналом')} aria-label={tr('Сравнить')}>◐</button>
        </div>
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
          onPointerMove={(e) => {
            const r = wrapRef.current?.getBoundingClientRect();
            if (r && painting) setCursorAt([e.clientX - r.left, e.clientY - r.top]);
          }}
          onPointerLeave={() => setCursorAt(null)}
          style={{ cursor: tool === 'select' ? 'default' : painting ? 'none' : 'crosshair' }}
        >
          <div ref={innerRef} className="ait-stage-inner" style={{ width: page.width * zoom, height: page.height * zoom }}>
            {marks?.map((y) => <div key={`m${y}`} className="ait-page-mark" style={{ top: y * zoom }} aria-hidden />)}
            {ocrFrame ? (
              <div className="ait-ocr-frame" data-testid="ocr-frame" style={{ left: ocrFrame[0] * zoom, top: ocrFrame[1] * zoom, width: ocrFrame[2] * zoom, height: ocrFrame[3] * zoom }}>
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
              <canvas ref={strokeCanvas} width={page.width} height={Math.min(page.height, 32000)} style={{ position: 'absolute', left: 0, top: 0, pointerEvents: 'none' }} />
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
          {sel && st ? (
            <div className="ait-panel">
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
                      <button className="pp-link" onClick={() => commitBlocks(blocks.map((b) => (b.id === sel.id ? { ...b, translatedText: sel.qa!.before!, qa: { ...sel.qa!, before: undefined }, edited: true } : b)))}>
                        {tr('Вернуть')}
                      </button>
                    </small>
                  ) : null}
                </div>
              ) : null}
              {multi.size ? <p className="ait-notice" data-testid="multi-note">{tr('Выбрано блоков: {0}. Стиль меняется у всех выбранных (Esc — снять выбор).', multi.size + 1)}</p> : null}
              <Field label={tr('Перевод')}>
                <button className="ait-copy" onClick={() => copyText(sel.translatedText)} title={tr('Копировать перевод')} aria-label={tr('Копировать перевод')}>⧉</button>
                <textarea className="ait-textarea" value={sel.translatedText} onFocus={() => (editStart.current = blocks)} onChange={(e) => setBlocks(blocks.map((b) => (b.id === sel.id ? { ...b, translatedText: e.target.value, edited: true } : b)))} onBlur={endTextEdit} />
              </Field>
              <div style={{ marginTop: 8 }}>
                <Field label={tr('Оригинал')}>
                  <button className="ait-copy" onClick={() => copyText(sel.originalText)} title={tr('Копировать оригинал')} aria-label={tr('Копировать оригинал')}>⧉</button>
                  <input className="ait-input" value={sel.originalText} onFocus={() => (editStart.current = blocks)} onChange={(e) => setBlocks(blocks.map((b) => (b.id === sel.id ? { ...b, originalText: e.target.value } : b)))} onBlur={endTextEdit} />
                </Field>
              </div>
              <div className="ait-row" style={{ marginTop: 8 }}>
                <button className="ait-btn small" onClick={() => void retr.run()} disabled={retr.busy}>{retr.busy ? tr('Перевожу…') : tr('Перевести заново')}</button>
                <button className="ait-btn small" onClick={() => fitText(sel)} title={tr('Подобрать размер текста под бабл')}>{tr('Вписать текст')}</button>
              </div>
              <div className="ait-row" style={{ marginTop: 6, flexWrap: 'wrap' }}>
                <button className="ait-btn small" onClick={() => { setStyleClip({ ...(sel.style ?? {}) }); toast(tr('Стиль скопирован')); }}>{tr('Копировать стиль')}</button>
                <button className="ait-btn small" disabled={!styleClip} onClick={() => styleClip && commitBlocks(blocks.map((b) => (targets.has(b.id) ? { ...b, style: { ...(b.style ?? {}), ...styleClip }, edited: true } : b)))}>{tr('Вставить стиль')}</button>
                <button className="ait-btn small" title={tr('Применить стиль этого блока ко всем блокам того же типа')} onClick={() => commitBlocks(blocks.map((b) => (b.textType === sel.textType && b.id !== sel.id ? { ...b, style: { ...(b.style ?? {}), ...(sel.style ?? {}), fontSize: b.style?.fontSize ?? null }, edited: true } : b)))}>
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
              <button className="ait-btn small danger" style={{ marginTop: 12 }} onClick={() => { commitBlocks(blocks.filter((b) => b.id !== sel.id)); setSelected(null); }}>
                {tr('Удалить блок')}
              </button>
            </div>
          ) : (
            <div className="ait-panel ait-muted">{tr('Выберите блок текста на странице или в списке ниже. Инструмент «Ручной OCR» добавляет пропущенный текст: обведите его рамкой.')}</div>
          )}

          <div className="ait-panel">
            <h2 style={{ fontSize: 14 }}>{tr('Блоки (')}{blocks.length})</h2>
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
                    const { blocks: next, changed } = importTexts(blocks, await f.text());
                    if (changed) commitBlocks(next);
                    toast(tr('Обновлено переводов: {0}', changed));
                  }}
                />
              </label>
            </div>
            <div className="ait-blocklist">
              {blocks.map((b, i) => (
                <button key={b.id} aria-pressed={b.id === selected || multi.has(b.id)} onClick={(e) => { pick(b.id, e.ctrlKey || e.shiftKey || e.metaKey); setTool('select'); }}>
                  {i + 1}. {b.translatedText.slice(0, 40) || <em className="ait-muted">{tr('пусто')}</em>} {overflow.has(b.id) ? '⚠' : ''}
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
