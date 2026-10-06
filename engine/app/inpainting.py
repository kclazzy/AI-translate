"""Removing original text: bubble fill, OpenCV inpainting and LaMa (ONNX)."""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Protocol

import cv2
import numpy as np

from .detection import RawBlock

log = logging.getLogger("ait.inpaint")


def block_mask(b: RawBlock, dilate_px: int = 2) -> np.ndarray:
    """Text mask in region coordinates, dilated and kept inside the bubble interior."""
    mask = b.text_mask.astype(np.uint8)
    if dilate_px > 0:
        mask = cv2.dilate(mask, np.ones((2 * dilate_px + 1, 2 * dilate_px + 1), np.uint8))
    if b.interior is not None:
        mask = (mask.astype(bool) & b.interior.astype(bool)).astype(np.uint8)
    return mask


class Inpainter(Protocol):
    name: str

    def inpaint(self, rgb: np.ndarray, mask: np.ndarray) -> np.ndarray: ...


class FillInpainter:
    """Fill text pixels with the bubble colour. Exact for flat speech bubbles."""

    name = "fill"

    def clean_block(self, page: np.ndarray, b: RawBlock) -> None:
        x, y, w, h = b.region
        mask = block_mask(b, 2).astype(bool)
        page[y : y + h, x : x + w][mask] = np.array(b.fill, dtype=np.uint8)


class TeleaInpainter:
    """OpenCV Telea inpainting: works on any background without model weights."""

    name = "telea"

    def inpaint(self, rgb: np.ndarray, mask: np.ndarray) -> np.ndarray:
        bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
        out = cv2.inpaint(bgr, (mask > 0).astype(np.uint8) * 255, 5, cv2.INPAINT_TELEA)
        return cv2.cvtColor(out, cv2.COLOR_BGR2RGB)


class LamaInpainter:
    """LaMa via ONNX Runtime (e.g. Carve/LaMa-ONNX lama_fp32.onnx: image [1,3,512,512] 0..1, mask [1,1,512,512] → [1,3,512,512])."""

    name = "lama"
    SIZE = 512

    def __init__(self, model_path: str, providers: list[str]):
        import onnxruntime as ort  # type: ignore

        if not Path(model_path).exists():
            raise FileNotFoundError(model_path)
        available = set(ort.get_available_providers())
        chosen = [p for p in providers if p in available] or ["CPUExecutionProvider"]
        self.session = ort.InferenceSession(model_path, providers=chosen)
        inputs = self.session.get_inputs()
        self.image_input = next((i.name for i in inputs if "image" in i.name.lower()), inputs[0].name)
        self.mask_input = next((i.name for i in inputs if "mask" in i.name.lower()), inputs[-1].name)
        self.device = chosen[0]
        log.info("LaMa loaded on %s", self.device)

    def inpaint(self, rgb: np.ndarray, mask: np.ndarray) -> np.ndarray:
        h, w = rgb.shape[:2]
        s = self.SIZE
        img = cv2.resize(rgb, (s, s), interpolation=cv2.INTER_AREA).astype(np.float32) / 255.0
        m = cv2.resize((mask > 0).astype(np.uint8), (s, s), interpolation=cv2.INTER_NEAREST).astype(np.float32)
        out = self.session.run(None, {self.image_input: img.transpose(2, 0, 1)[None], self.mask_input: m[None, None]})[0][0]
        out = out.transpose(1, 2, 0)
        if out.max() <= 1.5:
            out = out * 255.0
        out = cv2.resize(np.clip(out, 0, 255).astype(np.uint8), (w, h), interpolation=cv2.INTER_CUBIC)
        # Keep unmasked pixels exactly as they were.
        result = rgb.copy()
        sel = mask > 0
        result[sel] = out[sel]
        return result


def clean_region(page: np.ndarray, b: RawBlock, inpainter: Inpainter, context_pad: int = 24) -> None:
    """Inpaint one block in place using a crop with some surrounding context."""
    H, W = page.shape[:2]
    rx, ry, rw, rh = b.region
    mask_full = block_mask(b, 3)
    x0, y0 = max(0, rx - context_pad), max(0, ry - context_pad)
    x1, y1 = min(W, rx + rw + context_pad), min(H, ry + rh + context_pad)
    crop = page[y0:y1, x0:x1]
    mask = np.zeros(crop.shape[:2], np.uint8)
    mask[ry - y0 : ry - y0 + rh, rx - x0 : rx - x0 + rw] = mask_full
    if not mask.any():
        return
    page[y0:y1, x0:x1] = inpainter.inpaint(crop, mask)
