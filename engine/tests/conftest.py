from __future__ import annotations

import io
import json
import re
import sys
from pathlib import Path

import httpx
import numpy as np
import pytest
from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

FONT_CANDIDATES = [
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "C:/Windows/Fonts/msgothic.ttc",
    "C:/Windows/Fonts/YuGothB.ttc",
]


def cjk_font(size: int = 30) -> ImageFont.FreeTypeFont:
    for p in FONT_CANDIDATES:
        if Path(p).exists():
            return ImageFont.truetype(p, size)
    pytest.skip("No CJK font available to draw synthetic manga pages")


DEFAULT_BUBBLES = [
    {"cx": 220, "cy": 260, "rx": 120, "ry": 170, "text": "たなかさん待って"},
    {"cx": 580, "cy": 700, "rx": 110, "ry": 160, "text": "どこへ行くの"},
]


def make_page(width: int = 800, height: int = 1100, bubbles: list[dict] | None = None, art: bool = True) -> tuple[bytes, list[dict]]:
    """Grey screentone page with white elliptical bubbles holding vertical Japanese text."""
    img = Image.new("RGB", (width, height), (200, 200, 200))
    d = ImageDraw.Draw(img)
    for y in range(0, height, 6):
        for x in range(3 if (y // 6) % 2 else 0, width, 6):
            d.rectangle([x, y, x + 1, y + 1], fill=(154, 154, 154))
    if art:
        # Some dark "art" that must not be detected as text.
        d.rectangle([40, 900, 300, 1060], fill=(255, 255, 255), outline=(0, 0, 0), width=4)
        d.ellipse([90, 930, 250, 1040], fill=(20, 20, 20))
    font = cjk_font(30)
    out = []
    for b in bubbles if bubbles is not None else DEFAULT_BUBBLES:
        cx, cy, rx, ry = b["cx"], b["cy"], b["rx"], b["ry"]
        d.ellipse([cx - rx, cy - ry, cx + rx, cy + ry], fill=(255, 255, 255), outline=(0, 0, 0), width=4)
        chars = list(b["text"])
        per_col = (len(chars) + 1) // 2
        size = 30
        top = cy - per_col * size * 1.05 / 2
        cols = [cx + 22, cx - 22]
        for i, ch in enumerate(chars):
            col, row = divmod(i, per_col)
            d.text((cols[col], top + row * size * 1.05), ch, font=font, fill=(0, 0, 0), anchor="mt")
        tb = [int(cx - 22 - size / 2), int(top), int(44 + size), int(per_col * size * 1.05)]
        out.append({**b, "textBox": tb})
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue(), out


def dark_inside(png: bytes | np.ndarray, b: dict, margin: int = 10) -> int:
    arr = png if isinstance(png, np.ndarray) else np.asarray(Image.open(io.BytesIO(png)).convert("RGB"))
    h, w = arr.shape[:2]
    yy, xx = np.mgrid[0:h, 0:w]
    inside = ((xx - b["cx"]) / (b["rx"] - margin)) ** 2 + ((yy - b["cy"]) / (b["ry"] - margin)) ** 2 <= 1
    dark = (arr[..., 0] < 90) & (arr[..., 1] < 90) & (arr[..., 2] < 90)
    return int((inside & dark).sum())


class FakeLLM:
    """Mock OpenAI-compatible server. OCR requests (crops) return the expected text for each id;
    translation requests return Russian placeholders; vision page requests return boxes."""

    def __init__(self, ocr_texts: list[str] | None = None, translations: dict[str, str] | None = None, page_blocks: list[dict] | None = None):
        self.ocr_texts = ocr_texts or []
        self.translations = translations or {}
        self.page_blocks = page_blocks or []
        self.calls: list[dict] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        self.calls.append({"url": str(request.url), "body": body, "headers": dict(request.headers)})
        user = body["messages"][-1]["content"]
        if isinstance(user, list):
            text = " ".join(p.get("text", "") for p in user if p.get("type") == "text")
            if "cropped text region" in text:
                ids = re.findall(r"Crop (b\d+):", text)
                answer = {"texts": [{"id": i, "text": self.ocr_texts[int(i[1:]) - 1] if int(i[1:]) - 1 < len(self.ocr_texts) else "", "type": "DIALOGUE"} for i in ids]}
            else:
                answer = {"blocks": self.page_blocks, "entities": [], "summary": "Сводка"}
        else:
            blocks = json.loads(re.search(r"<blocks>\n(.*)\n</blocks>", user, re.S).group(1))
            answer = {
                "translations": [{"id": b["id"], "text": self.translations.get(b["text"], f"RU:{b['id']}")} for b in blocks],
                "entities": [{"source": "田中", "target": "Танака", "kind": "character", "gender": "male"}],
                "summary": "Кто-то зовёт Танаку.",
            }
        return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps(answer, ensure_ascii=False)}}], "usage": {"prompt_tokens": 100, "completion_tokens": 20}, "model": body["model"]})

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handler)


LOCAL_VISION = {"id": "ollama", "label": "Ollama", "kind": "openai-compatible", "preset": "ollama", "baseUrl": "http://localhost:11434/v1", "model": "qwen2.5vl:7b", "vision": True, "jsonMode": "json_object"}
LOCAL_TEXT = {"id": "lm", "label": "LM Studio", "kind": "openai-compatible", "preset": "lmstudio", "baseUrl": "http://localhost:1234/v1", "model": "qwen3-14b", "vision": False, "jsonMode": "none"}
