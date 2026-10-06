"""Safe decoding, tiling and encoding of page images."""
from __future__ import annotations

import io
from dataclasses import dataclass

import cv2
import numpy as np
from PIL import Image

from .errors import AppError

TILE = 4096
TILE_OVERLAP = 512

MAGIC = {
    b"\x89PNG": "image/png",
    b"\xff\xd8\xff": "image/jpeg",
    b"GIF8": "image/gif",
    b"BM": "image/bmp",
}


def sniff_mime(data: bytes) -> str | None:
    for magic, mime in MAGIC.items():
        if data.startswith(magic):
            return mime
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    if data[4:8] == b"ftyp" and data[8:11] == b"avi":
        return "image/avif"
    return None


def decode_image(data: bytes, max_pixels: int) -> np.ndarray:
    """Decode to an RGB uint8 array, refusing decompression bombs before decoding pixels."""
    mime = sniff_mime(data)
    if not mime:
        raise AppError("UNSUPPORTED_FORMAT", "Unsupported image format", retryable=False)
    try:
        with Image.open(io.BytesIO(data)) as im:
            w, h = im.size
            if w <= 0 or h <= 0:
                raise AppError("UNSUPPORTED_FORMAT", "Empty image", retryable=False)
            if w * h > max_pixels:
                raise AppError("IMAGE_TOO_LARGE", f"{w}x{h} exceeds the pixel limit", retryable=False)
            im.draft("RGB", (w, h))
            frame = im.convert("RGB")
            return np.asarray(frame, dtype=np.uint8).copy()
    except AppError:
        raise
    except Exception as exc:  # PIL raises many types
        raise AppError("UNSUPPORTED_FORMAT", "Could not decode image", retryable=False, detail=str(exc)) from exc


def encode_png(rgb: np.ndarray) -> bytes:
    ok, buf = cv2.imencode(".png", cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_PNG_COMPRESSION, 3])
    if not ok:
        raise AppError("UNKNOWN", "PNG encoding failed", retryable=False)
    return buf.tobytes()


def encode_jpeg(rgb: np.ndarray, quality: int = 92) -> bytes:
    ok, buf = cv2.imencode(".jpg", cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, quality])
    if not ok:
        raise AppError("UNKNOWN", "JPEG encoding failed", retryable=False)
    return buf.tobytes()


@dataclass
class Window:
    y: int
    h: int


def processing_windows(height: int, tile: int = TILE, overlap: int = TILE_OVERLAP) -> list[Window]:
    """Overlapping horizontal windows for detection on tall strips."""
    if height <= tile:
        return [Window(0, height)]
    out: list[Window] = []
    y = 0
    while True:
        h = min(tile, height - y)
        out.append(Window(y, h))
        if y + h >= height:
            break
        y += tile - overlap
    return out


def output_tiles(height: int, tile: int = TILE) -> list[Window]:
    """Non-overlapping output tiles; matches TILE_HEIGHT in the TypeScript renderer."""
    return [Window(y, min(tile, height - y)) for y in range(0, height, tile)]


def resize_long_side(rgb: np.ndarray, max_side: int) -> tuple[np.ndarray, float]:
    h, w = rgb.shape[:2]
    scale = min(1.0, max_side / max(h, w))
    if scale >= 1.0:
        return rgb, 1.0
    return cv2.resize(rgb, (max(1, int(w * scale)), max(1, int(h * scale))), interpolation=cv2.INTER_AREA), scale


def to_hex(color: np.ndarray | tuple[int, int, int]) -> str:
    r, g, b = (int(round(float(c))) for c in color[:3])
    return f"#{r:02x}{g:02x}{b:02x}"


def iou(a: list[int] | tuple, b: list[int] | tuple) -> float:
    x1, y1 = max(a[0], b[0]), max(a[1], b[1])
    x2, y2 = min(a[0] + a[2], b[0] + b[2]), min(a[1] + a[3], b[1] + b[3])
    inter = max(0, x2 - x1) * max(0, y2 - y1)
    union = a[2] * a[3] + b[2] * b[3] - inter
    return inter / union if union > 0 else 0.0


def overlap_small(a: list[int] | tuple, b: list[int] | tuple) -> float:
    x1, y1 = max(a[0], b[0]), max(a[1], b[1])
    x2, y2 = min(a[0] + a[2], b[0] + b[2]), min(a[1] + a[3], b[1] + b[3])
    inter = max(0, x2 - x1) * max(0, y2 - y1)
    small = min(a[2] * a[3], b[2] * b[3])
    return inter / small if small > 0 else 0.0
