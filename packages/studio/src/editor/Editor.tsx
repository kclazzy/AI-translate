import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import {
  cleanBlock,
  clampBox,
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
} from '@ait/core';
import { registerUserFont } from '../fonts';
import { usePlatform } from '../platform';
import { ErrorBox, Field, Switch, toast, useAction } from '../ui';

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
}

const BASE_FONTS = ['"AIT Comic"', '"AIT Narration"', '"AIT SFX"', 'Arial', '"Comic Sans MS"', '"Times New Roman"', 'Georgia', 'Impact'];
const MAX_HISTORY = 60;

function clonePixels(p: PixelData): PixelData {
  return { width: p.width, height: p.height, data: new Uint8ClampedArray(p.data) };
}

export function Editor({ page, original, cleaned, settings, onSave, onClose, title }: EditorProps) {
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
  const undoStack = useRef<HistoryItem[]>([]);
  const redoStack = useRef<HistoryItem[]>([]);
  const [, forceHistory] = useState(0);
  const tileCanvases = useRef<(HTMLCanvasElement | null)[]>([]);
  const origCanvases = useRef<(HTMLCanvasElement | null)[]>([]);
  const innerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
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
  const updateBlock = (id: string, patch: Partial<TextBlock>) => commitBlocks(blocks.map((b) => (b.id === id ? { ...b, ...patch, edited: true } : b)));
  const updateStyle = (id: string, patch: Partial<TextStyle>) => {
    const b = blocks.find((x) => x.id === id);
    if (b) updateBlock(id, { style: { ...(b.style ?? {}), ...patch } });
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
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selected) {
        e.preventDefault();
        commitBlocks(blocks.filter((b) => b.id !== selected));
        setSelected(null);
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
    if (tool !== 'select') return;
    e.stopPropagation();
    e.preventDefault();
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
      toast('В выделенной области текст не найден');
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
    toast(`Добавлено блоков: ${added.length}`);
  });

  const onStagePointerDown = (e: RPointerEvent) => {
    if (tool === 'select') {
      setSelected(null);
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
        const [x0, y0] = pts[0];
        const [x1, y1] = pts[pts.length - 1];
        octx.strokeStyle = '#1c6ed8';
        octx.lineWidth = 3 / zoom;
        octx.setLineDash([8 / zoom, 6 / zoom]);
        octx.strokeRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
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
    toast('Сохранено');
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
    await registerUserFont(name, await file.arrayBuffer());
    setFonts((f) => [...f, `"${name}"`]);
    if (sel) updateStyle(sel.id, { fontFamily: `"${name}", sans-serif` });
    toast(`Шрифт «${name}» добавлен`);
  };

  const usage = page.usage.reduce((a, u) => ({ input: a.input + u.inputTokens, output: a.output + u.outputTokens, cost: a.cost + u.costUsd }), { input: 0, output: 0, cost: 0 });
  const st = sel ? resolveStyle(sel, defaults) : null;
  const toolBtn = (t: Tool, label: string, key?: string) => (
    <button className={`ait-btn small ${tool === t ? 'active' : ''}`} onClick={() => setTool(t)} title={key ? `${label} (${key})` : label} aria-pressed={tool === t}>
      {label}
    </button>
  );

  return (
    <div>
      <div className="ait-toolbar">
        {onClose ? <button className="ait-btn small ghost" onClick={onClose}>← Назад</button> : null}
        {title ? <strong style={{ marginRight: 8 }}>{title}</strong> : null}
        {toolBtn('select', 'Выбор', 'V')}
        {toolBtn('brush', 'Кисть', 'B')}
        {toolBtn('eraser', 'Ластик', 'E')}
        {toolBtn('inpaint', 'Заливка фона')}
        {toolBtn('ocr', 'Ручной OCR')}
        {tool !== 'select' && tool !== 'ocr' ? (
          <>
            <label className="ait-muted" style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
              {brush}px
              <input type="range" min={1} max={100} value={brush} onChange={(e) => setBrush(Number(e.target.value))} aria-label="Размер кисти" />
            </label>
            {tool === 'brush' ? <input type="color" value={brushColor} onChange={(e) => setBrushColor(e.target.value)} aria-label="Цвет кисти" /> : null}
          </>
        ) : null}
        <span className="sep" />
        <button className="ait-btn small" onClick={undo} disabled={!undoStack.current.length} title="Ctrl+Z">Отменить</button>
        <button className="ait-btn small" onClick={redo} disabled={!redoStack.current.length} title="Ctrl+Shift+Z">Повторить</button>
        <span className="sep" />
        <button className="ait-btn small" onClick={() => setZoom((z) => Math.max(0.1, +(z / 1.25).toFixed(3)))} aria-label="Уменьшить">−</button>
        <span className="ait-muted" style={{ fontSize: 13, minWidth: 44, textAlign: 'center' }}>{Math.round(zoom * 100)}%</span>
        <button className="ait-btn small" onClick={() => setZoom((z) => Math.min(6, +(z * 1.25).toFixed(3)))} aria-label="Увеличить">+</button>
        <button className="ait-btn small" onClick={() => setZoom(fitZoom())}>По ширине</button>
        <button className={`ait-btn small ${compare ? 'active' : ''}`} onClick={() => setCompare((c) => !c)} aria-pressed={compare}>Сравнить</button>
        <span style={{ flex: 1 }} />
        <button className="ait-bubble-btn" style={{ fontSize: 16, minHeight: 36, padding: '4px 18px' }} onClick={() => void save.run()} disabled={save.busy || !dirty}>
          {save.busy ? 'Сохраняю…' : dirty ? 'Сохранить' : 'Сохранено'}
        </button>
      </div>
      <ErrorBox error={save.error || ocr.error} />
      <div className="ait-editor">
        <div ref={stageRef} className="ait-stage" onPointerDown={onStagePointerDown} style={{ cursor: tool === 'select' ? 'default' : 'crosshair' }}>
          <div ref={innerRef} className="ait-stage-inner" style={{ width: page.width * zoom, height: page.height * zoom }}>
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
                    const box = targetBox(b, defaults);
                    const rot = resolveStyle(b, defaults).rotation;
                    return (
                      <div
                        key={b.id}
                        className={`ait-box ${b.id === selected ? 'selected' : ''} ${overflow.has(b.id) ? 'overflow' : ''}`}
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
                    aria-label="Оригинал / перевод"
                    aria-valuenow={Math.round(split * 100)}
                  />
                </div>
              ) : null}
            </div>
          </div>
        </div>

        <div className="ait-props">
          {sel && st ? (
            <div className="ait-panel">
              <Field label="Перевод">
                <textarea className="ait-textarea" value={sel.translatedText} onFocus={() => (editStart.current = blocks)} onChange={(e) => setBlocks(blocks.map((b) => (b.id === sel.id ? { ...b, translatedText: e.target.value, edited: true } : b)))} onBlur={endTextEdit} />
              </Field>
              <div style={{ marginTop: 8 }}>
                <Field label="Оригинал">
                  <input className="ait-input" value={sel.originalText} onFocus={() => (editStart.current = blocks)} onChange={(e) => setBlocks(blocks.map((b) => (b.id === sel.id ? { ...b, originalText: e.target.value } : b)))} onBlur={endTextEdit} />
                </Field>
              </div>
              <div className="ait-row" style={{ marginTop: 8 }}>
                <button className="ait-btn small" onClick={() => void retr.run()} disabled={retr.busy}>{retr.busy ? 'Перевожу…' : 'Перевести заново'}</button>
                <button className="ait-btn small" onClick={() => fitText(sel)} title="Подобрать размер текста под бабл">Вписать текст</button>
              </div>
              <ErrorBox error={retr.error} />
              {overflow.has(sel.id) ? <p className="ait-notice" style={{ marginTop: 8 }}>Текст не помещается: уменьшите кегль, сократите перевод или растяните рамку.</p> : null}
              <div className="ait-grid2" style={{ marginTop: 10, gridTemplateColumns: '1fr 1fr' }}>
                <Field label="Тип">
                  <select className="ait-select" value={sel.textType} onChange={(e) => updateBlock(sel.id, { textType: e.target.value as TextBlock['textType'] })}>
                    {TEXT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </Field>
                <Field label="Кегль">
                  <input className="ait-input" type="number" min={6} max={200} placeholder="авто" value={sel.style?.fontSize ?? ''} onChange={(e) => updateStyle(sel.id, { fontSize: e.target.value ? Number(e.target.value) : null })} />
                </Field>
                <div style={{ gridColumn: '1 / -1' }}>
                  <Field label="Шрифт">
                    <select className="ait-select" value={sel.style?.fontFamily ?? ''} onChange={(e) => updateStyle(sel.id, { fontFamily: e.target.value || undefined })}>
                      <option value="">По типу текста</option>
                      {fonts.map((f) => <option key={f} value={`${f}, sans-serif`}>{f.replace(/"/g, '')}</option>)}
                    </select>
                  </Field>
                  <label className="ait-hint" style={{ display: 'block' }}>
                    Свой шрифт (TTF/OTF/WOFF2): <input type="file" accept=".ttf,.otf,.woff,.woff2" onChange={(e) => e.target.files?.[0] && void addFont(e.target.files[0])} />
                  </label>
                </div>
                <Field label="Цвет">
                  <input type="color" value={st.color} onChange={(e) => updateStyle(sel.id, { color: e.target.value })} />
                </Field>
                <Field label="Обводка">
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <input type="color" value={st.strokeColor ?? '#ffffff'} onChange={(e) => updateStyle(sel.id, { strokeColor: e.target.value, strokeWidth: st.strokeWidth || 3 })} />
                    <input className="ait-input" type="number" min={0} max={20} value={st.strokeWidth} onChange={(e) => updateStyle(sel.id, { strokeWidth: Number(e.target.value), strokeColor: st.strokeColor ?? '#ffffff' })} />
                  </div>
                </Field>
                <Field label="Выравнивание">
                  <select className="ait-select" value={st.alignment} onChange={(e) => updateStyle(sel.id, { alignment: e.target.value as TextStyle['alignment'] })}>
                    <option value="center">По центру</option>
                    <option value="left">Влево</option>
                    <option value="right">Вправо</option>
                  </select>
                </Field>
                <Field label="Поворот, °">
                  <input className="ait-input" type="number" min={-180} max={180} value={st.rotation} onChange={(e) => updateStyle(sel.id, { rotation: Number(e.target.value) })} />
                </Field>
                <div style={{ gridColumn: '1 / -1' }}>
                  <Field label={`Прозрачность: ${Math.round(st.opacity * 100)}%`}>
                    <input type="range" min={0.1} max={1} step={0.05} value={st.opacity} onChange={(e) => updateStyle(sel.id, { opacity: Number(e.target.value) })} />
                  </Field>
                </div>
              </div>
              <div style={{ display: 'grid', gap: 8, marginTop: 10 }}>
                <Switch checked={st.vertical} onChange={(v) => updateStyle(sel.id, { vertical: v })} label="Вертикальный текст" />
                <Switch checked={st.bold} onChange={(v) => updateStyle(sel.id, { bold: v })} label="Жирный" />
                <Switch checked={st.shadow} onChange={(v) => updateStyle(sel.id, { shadow: v })} label="Тень" />
                <Switch checked={sel.translate} onChange={(v) => updateBlock(sel.id, { translate: v })} label="Показывать перевод" />
              </div>
              <button className="ait-btn small danger" style={{ marginTop: 12 }} onClick={() => { commitBlocks(blocks.filter((b) => b.id !== sel.id)); setSelected(null); }}>
                Удалить блок
              </button>
            </div>
          ) : (
            <div className="ait-panel ait-muted">Выберите блок текста на странице или в списке ниже. Инструмент «Ручной OCR» добавляет пропущенный текст: обведите его рамкой.</div>
          )}

          <div className="ait-panel">
            <h2 style={{ fontSize: 14 }}>Блоки ({blocks.length})</h2>
            <div className="ait-blocklist">
              {blocks.map((b, i) => (
                <button key={b.id} aria-pressed={b.id === selected} onClick={() => { setSelected(b.id); setTool('select'); }}>
                  {i + 1}. {b.translatedText.slice(0, 40) || <em className="ait-muted">пусто</em>} {overflow.has(b.id) ? '⚠' : ''}
                </button>
              ))}
            </div>
          </div>

          {settings.debug ? (
            <div className="ait-panel">
              <h2 style={{ fontSize: 14 }}>Отладка</h2>
              <div className="ait-debug">
                <span>Размер</span><span>{page.width}×{page.height}</span>
                <span>Блоков</span><span>{page.blocks.length}</span>
                <span>Детекция</span><span>{page.timings.detectMs ?? 0} мс</span>
                <span>OCR</span><span>{page.timings.ocrMs ?? 0} мс</span>
                <span>Перевод</span><span>{page.timings.translateMs ?? 0} мс</span>
                <span>Очистка</span><span>{page.timings.cleanMs ?? 0} мс</span>
                <span>Рендер</span><span>{page.timings.renderMs ?? 0} мс</span>
                <span>Всего</span><span>{page.timings.totalMs ?? 0} мс</span>
                <span>Модель</span><span>{[...new Set(page.usage.map((u) => u.model))].join(', ') || page.source.detectedBy}</span>
                <span>Токены</span><span>{usage.input} / {usage.output}</span>
                <span>Стоимость</span><span>${usage.cost.toFixed(4)}</span>
                <span>Режим</span><span>{page.pipeline.mode}</span>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
