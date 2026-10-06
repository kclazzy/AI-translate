"""Page pipeline: detect → OCR → translate → clean, with an AI router that picks providers per stage."""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import math
import threading
import time
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable

import httpx
import numpy as np

from . import __version__
from .config import Settings
from .detection import ClassicDetector, RawBlock, analyze_box, sort_reading_order
from .errors import AppError
from .imaging import decode_image, encode_jpeg, encode_png, output_tiles, overlap_small, resize_long_side
from .inpainting import FillInpainter, LamaInpainter, TeleaInpainter, clean_region
from .llm import LlmClient, assert_privacy, image_part, with_retry
from .ocr import MangaOcrProvider, PaddleOcrProvider, VisionLlmOcr, detect_lang
from .schemas import ProviderConfig, TextBlock, TranslateOptions, Usage
from .storage import AssetStore, ResultCache
from .translation import extract_json, merge_context_update, normalize_type, sanitize, system_prompt, translate_blocks, vision_full_instruction

log = logging.getLogger("ait.pipeline")

Emit = Callable[[str, dict[str, Any]], Awaitable[None]]
CJK = {"ja", "zh", "zh-TW", "ko"}
MAX_SIDE = {"fast": 1280, "balanced": 1568, "best": 2048}


def options_hash(opts: TranslateOptions) -> str:
    d = opts.model_dump(by_alias=True, exclude={"context"})
    for k in ("translator", "vision"):
        if d.get(k):
            d[k] = {x: d[k].get(x) for x in ("kind", "baseUrl", "model")}
    return hashlib.sha256(json.dumps(d, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:24]


def font_size_estimate(box: tuple[int, int, int, int] | list[int], text: str) -> int:
    n = max(1, len("".join(text.split())))
    return max(8, round(math.sqrt(box[2] * box[3] / n) * 0.85))


class Engine:
    def __init__(self, settings: Settings, transport: httpx.AsyncBaseTransport | None = None):
        self.settings = settings
        self.transport = transport
        self.assets = AssetStore(settings.data_dir / "assets")
        self.cache = ResultCache(settings.data_dir / "engine.db")
        self.cache.prune(settings.cache_days)
        self.classic = ClassicDetector()
        self.fill = FillInpainter()
        self.telea = TeleaInpainter()
        self._lama: LamaInpainter | None = None
        self._lama_error: str | None = None
        self.cv_lock = threading.Lock()  # one heavy CV/GPU job at a time
        self.page_slots = asyncio.Semaphore(2)

    # ---- capabilities ---------------------------------------------------------------
    def lama(self) -> LamaInpainter | None:
        if self._lama is None and self.settings.lama_onnx and not self._lama_error:
            try:
                self._lama = LamaInpainter(self.settings.lama_onnx, self.settings.onnx_providers)
            except Exception as exc:  # missing file / runtime
                self._lama_error = str(exc)
                log.warning("LaMa unavailable: %s", exc)
        return self._lama

    def capabilities(self) -> dict[str, Any]:
        gpu = None
        device = "cpu"
        try:
            import onnxruntime as ort  # type: ignore

            if "CUDAExecutionProvider" in ort.get_available_providers():
                device, gpu = "cuda", "CUDA (onnxruntime)"
        except ImportError:
            pass
        ocr = ["vision"]
        if MangaOcrProvider.available():
            ocr.append("manga-ocr")
        if PaddleOcrProvider.available():
            ocr.append("paddle")
        inpainters = ["fill", "telea"] + (["lama"] if self.settings.lama_onnx else [])
        return {"status": "ok", "version": __version__, "device": device, "gpu": gpu, "detectors": ["classic", "vision"], "ocr": ocr, "inpainters": inpainters}

    # ---- router ---------------------------------------------------------------------
    def client(self, cfg: ProviderConfig) -> LlmClient:
        return LlmClient(cfg, self.transport)

    def pick_ocr(self, opts: TranslateOptions, lang: str):
        choice = opts.ocr
        vision_ok = bool(opts.vision and opts.vision.vision)
        if choice == "manga-ocr":
            if not MangaOcrProvider.available():
                raise AppError("NOT_CONFIGURED", "manga-ocr is not installed (pip install manga-ocr)", retryable=False)
            return MangaOcrProvider()
        if choice == "paddle":
            if not PaddleOcrProvider.available():
                raise AppError("NOT_CONFIGURED", "PaddleOCR is not installed", retryable=False)
            return PaddleOcrProvider()
        if choice == "vision":
            if not vision_ok:
                raise AppError("NOT_CONFIGURED", "No vision model configured for OCR", retryable=False)
            assert_privacy(opts.privacy, opts.vision, "image")  # type: ignore[arg-type]
            return VisionLlmOcr(self.client(opts.vision))  # type: ignore[arg-type]
        # auto
        if lang in ("ja", "auto") and MangaOcrProvider.available():
            return MangaOcrProvider()
        if lang in ("ko", "zh", "zh-TW") and PaddleOcrProvider.available():
            return PaddleOcrProvider()
        if vision_ok:
            assert_privacy(opts.privacy, opts.vision, "image")  # type: ignore[arg-type]
            return VisionLlmOcr(self.client(opts.vision))  # type: ignore[arg-type]
        if MangaOcrProvider.available():
            return MangaOcrProvider()
        raise AppError("NOT_CONFIGURED", "No OCR available: install manga-ocr/PaddleOCR or pick a vision model", retryable=False)

    # ---- vision detection -----------------------------------------------------------
    async def vision_detect(self, rgb: np.ndarray, opts: TranslateOptions, with_translation: bool, usages: list[Usage]) -> tuple[list[RawBlock], list[Any], str]:
        if not (opts.vision and opts.vision.vision):
            raise AppError("NOT_CONFIGURED", "Vision detection needs a vision model", retryable=False)
        assert_privacy(opts.privacy, opts.vision, "image")
        client = self.client(opts.vision)
        H, W = rgb.shape[:2]
        views = [(0, H)] if H <= W * 2.6 else []
        if not views:
            vh, ov = int(W * 2), int(W * 0.35)
            y = 0
            while True:
                h = min(vh, H - y)
                views.append((y, h))
                if y + h >= H:
                    break
                y += vh - ov
        system = system_prompt(opts)
        blocks: list[RawBlock] = []
        entities: list[Any] = []
        summaries: list[str] = []
        for vy, vh in views:
            view, _ = resize_long_side(rgb[vy : vy + vh], MAX_SIDE[opts.quality])
            jpeg = encode_jpeg(view)

            async def run(_a: int, jpeg=jpeg, view=view) -> dict:
                c = await client.complete(system, [{"role": "user", "content": [image_part(jpeg, "image/jpeg"), {"type": "text", "text": vision_full_instruction(view.shape[1], view.shape[0], with_translation)}]}], max_tokens=6000)
                usages.append(client.usage(c))
                data = extract_json(c.text)
                if not isinstance(data, dict) or not isinstance(data.get("blocks"), list):
                    raise AppError("TRANSLATION_INVALID_OUTPUT", detail='Missing "blocks"')
                return data

            data = await with_retry(run, retries=2)
            entities += data.get("entities") or []
            if data.get("summary"):
                summaries.append(sanitize(data["summary"], 400))
            for item in data["blocks"][:200]:
                if not isinstance(item, dict) or not isinstance(item.get("box"), list) or len(item["box"]) != 4:
                    continue
                try:
                    x0, y0, x1, y1 = (max(0.0, min(1000.0, float(v))) for v in item["box"])
                except (TypeError, ValueError):
                    continue
                if x1 - x0 < 2 or y1 - y0 < 2:
                    continue
                text = sanitize(item.get("text"), 1000)
                if not text:
                    continue
                box = (int(x0 / 1000 * W), int(vy + y0 / 1000 * vh), max(1, int((x1 - x0) / 1000 * W)), max(1, int((y1 - y0) / 1000 * vh)))
                if any(overlap_small(box, b.bbox) > 0.55 for b in blocks):
                    continue
                rb = await asyncio.to_thread(analyze_box, rgb, box)
                rb.bbox = box
                rb.text = text
                rb.translation = sanitize(item.get("translation"), 1500) if with_translation else None
                rb.text_type = normalize_type(item.get("type"))
                rb.vertical = item.get("vertical") is True
                rb.source = "vision"
                blocks.append(rb)
        return blocks, entities, " ".join(summaries)[:400]

    # ---- main entry -----------------------------------------------------------------
    async def process(self, data: bytes, opts: TranslateOptions, emit: Emit) -> dict[str, Any]:
        t0 = time.perf_counter()
        key = hashlib.sha256(data).hexdigest()[:40] + ":" + options_hash(opts)
        cached = self.cache.get(key)
        if cached and all(self.assets.exists(t["assetId"]) for t in cached.get("cleanedTiles", [])):
            await emit("stage", {"stage": "done", "progress": 1, "message": "cache"})
            return cached

        async with self.page_slots:
            await emit("stage", {"stage": "decoding"})
            rgb = await asyncio.to_thread(decode_image, data, self.settings.max_pixels)
            t_decode = time.perf_counter()
            usages: list[Usage] = []
            entities: list[Any] = []
            summary = ""

            await emit("stage", {"stage": "detecting"})
            translator_cfg = opts.translator or opts.vision
            single_call = opts.detector == "vision" and opts.vision is not None and (translator_cfg is None or translator_cfg.id == opts.vision.id)
            if opts.detector == "ctd":
                raise AppError("NOT_CONFIGURED", "The ONNX text detector is not bundled in this version; use classic or vision", retryable=False)
            blocks: list[RawBlock] = []
            if opts.detector in ("auto", "classic"):
                blocks = await asyncio.to_thread(self._locked, self.classic.detect, rgb)
            if opts.detector == "vision" or (opts.detector == "auto" and not blocks and opts.vision and opts.vision.vision):
                single_call = translator_cfg is None or (opts.vision is not None and translator_cfg.id == opts.vision.id)
                blocks, entities, summary = await self.vision_detect(rgb, opts, single_call, usages)
            t_detect = time.perf_counter()

            if blocks and any(not b.text for b in blocks):
                await emit("stage", {"stage": "ocr"})
                need = [b for b in blocks if not b.text]
                ocr = self.pick_ocr(opts, opts.source_lang)
                usages += await ocr.recognize(rgb, need, opts.source_lang)
            blocks = [b for b in blocks if b.text.strip()]
            t_ocr = time.perf_counter()

            for b in blocks:
                lang = opts.source_lang if opts.source_lang != "auto" else detect_lang(b.text)
                b.extra["lang"] = lang
                if lang not in CJK:
                    b.vertical = False
            erase = {id(b): not (b.text_type == "SFX" and (not opts.translate_sfx or opts.sfx_style == "original")) for b in blocks}

            await emit("stage", {"stage": "translating"})
            ids = {id(b): f"b{i + 1}" for i, b in enumerate(blocks)}
            todo = [b for b in blocks if b.translation is None and not (b.text_type == "SFX" and not opts.translate_sfx)]
            if todo:
                if translator_cfg is None:
                    raise AppError("NOT_CONFIGURED", "No translation model configured", retryable=False)
                assert_privacy(opts.privacy, translator_cfg, "text")
                res = await translate_blocks(self.client(translator_cfg), opts, [{"id": ids[id(b)], "type": b.text_type, "text": b.text} for b in todo])
                usages += res.usage
                entities += res.entities
                summary = summary or res.summary
                for b in todo:
                    t = res.translations.get(ids[id(b)])
                    if t:
                        b.translation = t["text"]
                        if t.get("type"):
                            b.text_type = t["type"]
                    else:
                        b.translation = b.text
                        b.extra["low"] = True
            t_translate = time.perf_counter()

            await emit("stage", {"stage": "cleaning"})
            cleaned = rgb.copy()
            await asyncio.to_thread(self._locked, self._clean_all, cleaned, [b for b in blocks if erase[id(b)]], opts.inpainter)
            t_clean = time.perf_counter()

            tiles = []
            for t in output_tiles(cleaned.shape[0]):
                png = await asyncio.to_thread(encode_png, cleaned[t.y : t.y + t.h])
                tiles.append({"y": t.y, "h": t.h, "assetId": self.assets.put(png)})

            text_blocks = [self._to_text_block(ids[id(b)], b, opts) for b in blocks]
            for tb, b in zip(text_blocks, blocks):
                if not erase[id(b)] or (b.text_type == "SFX" and not opts.translate_sfx):
                    tb.translate = False
            page = {
                "pageId": hashlib.sha256(data).hexdigest(),
                "width": int(rgb.shape[1]),
                "height": int(rgb.shape[0]),
                "source": {"lang": blocks[0].extra.get("lang", opts.source_lang) if blocks else opts.source_lang, "detectedBy": "+".join(sorted({b.source for b in blocks})) or "none"},
                "targetLang": opts.target_lang,
                "blocks": [tb.dump() for tb in text_blocks],
                "timings": {
                    "decodeMs": round((t_decode - t0) * 1000),
                    "detectMs": round((t_detect - t_decode) * 1000),
                    "ocrMs": round((t_ocr - t_detect) * 1000),
                    "translateMs": round((t_translate - t_ocr) * 1000),
                    "cleanMs": round((t_clean - t_translate) * 1000),
                    "totalMs": round((time.perf_counter() - t0) * 1000),
                },
                "usage": [u.dump() for u in usages],
                "pipeline": {"version": 1, "hash": options_hash(opts), "mode": "engine"},
                "summary": summary,
                "createdAt": datetime.now(timezone.utc).isoformat(),
            }
            lines = [{"src": b.text, "dst": b.translation or ""} for b in blocks if b.text_type == "DIALOGUE"][-8:]
            payload = {"page": page, "cleanedTiles": tiles, "contextUpdate": merge_context_update(entities, summary, lines)}
            self.cache.put(key, payload)
            self.cache.record_usage(page["usage"])
            await emit("stage", {"stage": "done", "progress": 1})
            return payload

    def _locked(self, fn, *args):
        with self.cv_lock:
            return fn(*args)

    def _clean_all(self, page: np.ndarray, blocks: list[RawBlock], choice: str) -> None:
        lama = self.lama() if choice in ("auto", "lama") else None
        if choice == "lama" and lama is None:
            raise AppError("NOT_CONFIGURED", f"LaMa model not available: {self._lama_error or 'AIT_LAMA_ONNX is empty'}", retryable=False)
        for b in blocks:
            if b.interior is not None and choice in ("auto", "fill"):
                self.fill.clean_block(page, b)
            else:
                clean_region(page, b, lama or self.telea)

    def _to_text_block(self, bid: str, b: RawBlock, opts: TranslateOptions) -> TextBlock:
        x, y, w, h = (int(v) for v in b.bbox)
        bubble = None
        if b.bubble_box is not None:
            bx, by, bw, bh = b.bubble_box
            inset = 0.1 if b.shape == "ellipse" else 0.06
            bubble = {"box": [bx, by, bw, bh], "fill": "#%02x%02x%02x" % b.fill, "safeArea": [round(bx + bw * inset), round(by + bh * inset), round(bw * (1 - 2 * inset)), round(bh * (1 - 2 * inset))], "shape": b.shape}
        else:
            pad_x, pad_y = round(w * 0.08), round(h * 0.08)
            bubble = {"box": [x, y, w, h], "fill": "#%02x%02x%02x" % b.fill, "safeArea": [x - pad_x, y - pad_y, w + 2 * pad_x, h + 2 * pad_y], "shape": "rect"}
        return TextBlock(
            id=bid,
            text_type=b.text_type,  # type: ignore[arg-type]
            original_text=b.text,
            translated_text=b.translation or "",
            confidence=b.confidence,
            language=b.extra.get("lang", "und"),
            bbox=[x, y, w, h],
            polygon=[[x, y], [x + w, y], [x + w, y + h], [x, y + h]],
            orientation=0,
            writing_direction="ttb-rl" if b.vertical else "ltr",
            font_size_estimate=font_size_estimate((x, y, w, h), b.text),
            bubble=bubble,  # type: ignore[arg-type]
            translate=True,
            low_confidence=True if b.extra.get("low") else None,
        )

    async def ocr_region(self, data: bytes, box: tuple[int, int, int, int], opts: TranslateOptions) -> list[dict[str, Any]]:
        rgb = await asyncio.to_thread(decode_image, data, self.settings.max_pixels)
        H, W = rgb.shape[:2]
        x, y, w, h = box
        x, y = max(0, x), max(0, y)
        w, h = min(w, W - x), min(h, H - y)
        if w <= 2 or h <= 2:
            raise AppError("NO_TEXT_FOUND", retryable=False)
        b = await asyncio.to_thread(analyze_box, rgb, (x, y, w, h))
        b.bbox = (x, y, w, h)
        usages = await self.pick_ocr(opts, opts.source_lang).recognize(rgb, [b], opts.source_lang)
        if not b.text:
            raise AppError("NO_TEXT_FOUND", retryable=False)
        translator = opts.translator or opts.vision
        if translator:
            assert_privacy(opts.privacy, translator, "text")
            res = await translate_blocks(self.client(translator), opts, [{"id": "b1", "type": b.text_type, "text": b.text}])
            b.translation = (res.translations.get("b1") or {}).get("text", b.text)
        b.extra["lang"] = detect_lang(b.text) if opts.source_lang == "auto" else opts.source_lang
        b.vertical = b.vertical or (h > w * 1.25 and b.extra["lang"] in CJK)
        _ = usages
        return [self._to_text_block("m1", b, opts).dump()]

    async def inpaint(self, data: bytes, mask_png: bytes) -> bytes:
        rgb = await asyncio.to_thread(decode_image, data, self.settings.max_pixels)
        mask_rgb = await asyncio.to_thread(decode_image, mask_png, self.settings.max_pixels)
        if mask_rgb.shape[:2] != rgb.shape[:2]:
            raise AppError("UNSUPPORTED_FORMAT", "Mask size differs from image size", retryable=False)
        mask = (mask_rgb.max(axis=2) > 127).astype(np.uint8)
        inp = self.lama() or self.telea
        out = await asyncio.to_thread(self._locked, inp.inpaint, rgb, mask)
        return await asyncio.to_thread(encode_png, out)


def sort_blocks(blocks: list[RawBlock], lang: str) -> list[RawBlock]:
    return sort_reading_order(blocks, rtl=lang in ("ja", "auto"))
