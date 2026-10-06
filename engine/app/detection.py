"""Text and speech-bubble detection.

ClassicDetector is a classical computer-vision detector (no weights needed):
closed light regions with dark glyph-like holes are speech bubbles; the holes are the text.
Vision detection (an LLM with image input) is used when the classic detector finds nothing
or when the user selects it. Other detectors (e.g. an ONNX text detector) plug in through
the same Detector protocol.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol

import cv2
import numpy as np

from .imaging import overlap_small, processing_windows


@dataclass
class RawBlock:
    bbox: tuple[int, int, int, int]
    """Tight text box in page pixels."""
    region: tuple[int, int, int, int]
    """Box the masks below are relative to."""
    text_mask: np.ndarray
    """uint8 mask of text pixels inside `region`."""
    interior: np.ndarray | None = None
    """uint8 mask of the bubble interior inside `region` (None = no closed bubble)."""
    bubble_box: tuple[int, int, int, int] | None = None
    fill: tuple[int, int, int] = (255, 255, 255)
    shape: str = "rect"
    text: str = ""
    translation: str | None = None
    text_type: str = "DIALOGUE"
    vertical: bool = False
    confidence: float = 0.8
    source: str = "classic"
    extra: dict = field(default_factory=dict)


class Detector(Protocol):
    name: str

    def detect(self, rgb: np.ndarray) -> list[RawBlock]: ...


def _fill_holes(comp: np.ndarray) -> np.ndarray:
    """Fill enclosed background areas of a binary mask."""
    h, w = comp.shape
    padded = np.zeros((h + 2, w + 2), np.uint8)
    padded[1:-1, 1:-1] = comp
    inv = (1 - padded).astype(np.uint8)
    ff_mask = np.zeros((h + 4, w + 4), np.uint8)
    cv2.floodFill(inv, ff_mask, (0, 0), 2)
    holes = (inv == 1)[1:-1, 1:-1]
    return (comp.astype(bool) | holes).astype(np.uint8)


def _median_color(rgb: np.ndarray, mask: np.ndarray) -> tuple[int, int, int]:
    px = rgb[mask.astype(bool)]
    if len(px) == 0:
        return (255, 255, 255)
    if len(px) > 20000:
        px = px[:: len(px) // 20000 + 1]
    med = np.median(px, axis=0)
    return int(med[0]), int(med[1]), int(med[2])


class ClassicDetector:
    name = "classic"

    def __init__(self, white_threshold: int = 215, min_area_ratio: float = 0.0012, max_area_ratio: float = 0.4):
        self.white_threshold = white_threshold
        self.min_area_ratio = min_area_ratio
        self.max_area_ratio = max_area_ratio

    def detect_window(self, rgb: np.ndarray, y_offset: int = 0) -> list[RawBlock]:
        gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
        H, W = gray.shape
        white = (gray >= self.white_threshold).astype(np.uint8)
        n, labels, stats, _ = cv2.connectedComponentsWithStats(white, connectivity=4)
        page_area = H * W
        out: list[RawBlock] = []
        for i in range(1, n):
            x, y, w, h, area = (int(v) for v in stats[i])
            if area < max(500, page_area * self.min_area_ratio) or area > page_area * self.max_area_ratio:
                continue
            if w < 24 or h < 24:
                continue
            comp = (labels[y : y + h, x : x + w] == i).astype(np.uint8)
            filled = _fill_holes(comp)
            filled_area = int(filled.sum())
            holes = (filled.astype(bool) & ~comp.astype(bool)).astype(np.uint8)
            hole_area = int(holes.sum())
            ratio = hole_area / max(1, filled_area)
            if ratio < 0.006 or ratio > 0.45:
                continue
            contours, _ = cv2.findContours(filled, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            if not contours:
                continue
            hull_area = cv2.contourArea(cv2.convexHull(max(contours, key=cv2.contourArea)))
            if hull_area <= 0 or filled_area / hull_area < 0.82:
                continue
            interior = cv2.erode(filled, np.ones((5, 5), np.uint8), iterations=1)
            text = (holes.astype(bool) & interior.astype(bool)).astype(np.uint8)
            if int(text.sum()) < 25:
                continue
            ncc, cc_labels, cc_stats, _ = cv2.connectedComponentsWithStats(text, connectivity=8)
            glyphs = [s for s in cc_stats[1:] if s[4] >= 3]
            if len(glyphs) < 2:
                continue
            largest = max(int(s[4]) for s in glyphs)
            if largest > filled_area * 0.2:
                continue  # one big dark shape: art, not lettering
            # Text must be darker than the bubble.
            text_gray = gray[y : y + h, x : x + w][text.astype(bool)]
            if float(np.mean(text_gray)) > 150:
                continue
            tx, ty, tw, th = cv2.boundingRect(text)
            if tw * th > filled_area * 0.9:
                continue
            fill = _median_color(rgb[y : y + h, x : x + w], comp)
            fill_ratio = filled_area / max(1, w * h)
            vertical = is_vertical_layout(text, glyphs)
            out.append(
                RawBlock(
                    bbox=(x + tx, y + ty + y_offset, tw, th),
                    region=(x, y + y_offset, w, h),
                    text_mask=text,
                    interior=filled,
                    bubble_box=(x, y + y_offset, w, h),
                    fill=fill,
                    shape="ellipse" if fill_ratio < 0.86 else "rect",
                    text_type="DIALOGUE" if fill_ratio < 0.86 else "NARRATION",
                    vertical=bool(vertical),
                    confidence=0.85,
                    source="classic",
                    extra={"glyphs": len(glyphs)},
                )
            )
        return out

    def detect(self, rgb: np.ndarray) -> list[RawBlock]:
        blocks: list[RawBlock] = []
        for win in processing_windows(rgb.shape[0]):
            for b in self.detect_window(rgb[win.y : win.y + win.h], win.y):
                # A bubble cut by the window edge is found complete in the neighbouring window.
                if win.y > 0 and b.region[1] <= win.y:
                    continue
                if win.y + win.h < rgb.shape[0] and b.region[1] + b.region[3] >= win.y + win.h:
                    continue
                if any(overlap_small(b.bbox, o.bbox) > 0.6 for o in blocks):
                    continue
                blocks.append(b)
        return sort_reading_order(blocks, rtl=True)


def analyze_box(rgb: np.ndarray, box: tuple[int, int, int, int], white_threshold: int = 215) -> RawBlock:
    """Describe a text box supplied by a vision model or the user: find its bubble and text pixels."""
    H, W = rgb.shape[:2]
    x, y, w, h = box
    md = max(w, h)
    for pad in (int(max(24, 0.9 * md)), int(max(48, 1.8 * md)), int(max(80, 3 * md))):
        rx, ry = max(0, x - pad), max(0, y - pad)
        rx2, ry2 = min(W, x + w + pad), min(H, y + h + pad)
        crop = rgb[ry:ry2, rx:rx2]
        gray = cv2.cvtColor(crop, cv2.COLOR_RGB2GRAY)
        white = (gray >= white_threshold).astype(np.uint8)
        n, labels, stats, _ = cv2.connectedComponentsWithStats(white, connectivity=4)
        lx, ly = x - rx, y - ry
        # Component that surrounds the text box: most pixels in a ring around it.
        ring = np.zeros_like(white)
        cv2.rectangle(ring, (max(0, lx - 4), max(0, ly - 4)), (min(crop.shape[1] - 1, lx + w + 4), min(crop.shape[0] - 1, ly + h + 4)), 1, 3)
        counts = np.bincount(labels[ring.astype(bool)].ravel(), minlength=n)
        counts[0] = 0
        best = int(np.argmax(counts)) if counts.max() > 0 else 0
        if best:
            bx, by, bw, bh, _ = (int(v) for v in stats[best])
            touches = bx == 0 or by == 0 or bx + bw >= crop.shape[1] or by + bh >= crop.shape[0]
            if touches and pad < int(max(80, 3 * md)):
                continue
            if not touches:
                comp = (labels == best).astype(np.uint8)
                filled = _fill_holes(comp)
                interior = cv2.erode(filled, np.ones((5, 5), np.uint8), iterations=1)
                text = (filled.astype(bool) & ~comp.astype(bool) & interior.astype(bool)).astype(np.uint8)
                fill = _median_color(crop, comp)
                fill_ratio = int(filled.sum()) / max(1, bw * bh)
                tb = cv2.boundingRect(text) if text.any() else (lx, ly, w, h)
                return RawBlock(
                    bbox=(rx + tb[0], ry + tb[1], tb[2], tb[3]),
                    region=(rx, ry, crop.shape[1], crop.shape[0]),
                    text_mask=text,
                    interior=filled,
                    bubble_box=(rx + bx, ry + by, bw, bh),
                    fill=fill,
                    shape="ellipse" if fill_ratio < 0.86 else "rect",
                    source="analyzed",
                )
        break
    # No closed bubble: text pixels are those that differ strongly from the local background.
    rx, ry = max(0, x - 6), max(0, y - 6)
    rx2, ry2 = min(W, x + w + 6), min(H, y + h + 6)
    crop = rgb[ry:ry2, rx:rx2]
    border = np.concatenate([crop[0], crop[-1], crop[:, 0], crop[:, -1]])
    bg = np.median(border, axis=0)
    dist = np.linalg.norm(crop.astype(np.float32) - bg.astype(np.float32), axis=2)
    text = (dist > 60).astype(np.uint8)
    if text.sum() < crop.shape[0] * crop.shape[1] * 0.02:
        text = np.ones(crop.shape[:2], np.uint8)
    return RawBlock(bbox=box, region=(rx, ry, crop.shape[1], crop.shape[0]), text_mask=text, interior=None, bubble_box=None, fill=(int(bg[0]), int(bg[1]), int(bg[2])), shape="rect", source="analyzed")


def is_vertical_layout(text_mask: np.ndarray, glyphs) -> bool:
    """Vertical CJK text: smearing the glyphs along columns gives fewer pieces than smearing
    them along rows (each column merges into one piece; rows stay separate)."""
    if len(glyphs) < 2:
        h, w = text_mask.shape
        return h > w * 1.5
    size = float(np.percentile([max(int(g[2]), int(g[3])) for g in glyphs], 75))
    k = max(3, int(size * 0.8))
    tall = cv2.dilate(text_mask, np.ones((k, 1), np.uint8))
    wide = cv2.dilate(text_mask, np.ones((1, k), np.uint8))
    n_cols = cv2.connectedComponents(tall, connectivity=8)[0] - 1
    n_rows = cv2.connectedComponents(wide, connectivity=8)[0] - 1
    if n_cols == n_rows:
        ys, xs = np.nonzero(text_mask)
        return (ys.max() - ys.min()) > (xs.max() - xs.min()) * 1.2 if len(xs) else False
    return n_cols < n_rows


def sort_reading_order(blocks: list[RawBlock], rtl: bool) -> list[RawBlock]:
    """Top-to-bottom rows; within a row right-to-left for manga, left-to-right otherwise."""
    if not blocks:
        return blocks
    blocks = sorted(blocks, key=lambda b: b.bbox[1])
    rows: list[list[RawBlock]] = []
    for b in blocks:
        cy = b.bbox[1] + b.bbox[3] / 2
        for row in rows:
            r0 = row[0]
            if abs((r0.bbox[1] + r0.bbox[3] / 2) - cy) < max(r0.bbox[3], b.bbox[3]) * 0.5:
                row.append(b)
                break
        else:
            rows.append([b])
    out: list[RawBlock] = []
    for row in rows:
        out.extend(sorted(row, key=lambda b: -b.bbox[0] if rtl else b.bbox[0]))
    return out
