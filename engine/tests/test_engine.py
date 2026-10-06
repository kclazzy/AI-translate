from __future__ import annotations

import asyncio
import io

import numpy as np
import pytest
from PIL import Image

from app.config import Settings
from app.detection import ClassicDetector, analyze_box, sort_reading_order
from app.errors import AppError
from app.imaging import decode_image, processing_windows
from app.inpainting import TeleaInpainter, clean_region
from app.llm import assert_privacy, is_local_url
from app.pipeline import Engine
from app.schemas import ProviderConfig, TranslateOptions
from app.translation import extract_json, glossary_hits, parse_translations, system_prompt, violations

from .conftest import LOCAL_TEXT, LOCAL_VISION, FakeLLM, dark_inside, make_page


def rgb_of(png: bytes) -> np.ndarray:
    return np.asarray(Image.open(io.BytesIO(png)).convert("RGB"))


def settings(tmp_path) -> Settings:
    s = Settings(data_dir=tmp_path)
    s.ensure_token()
    return s


# ---------------------------------------------------------------- detection

def test_classic_detector_finds_bubbles_and_ignores_art():
    png, bubbles = make_page()
    blocks = ClassicDetector().detect(rgb_of(png))
    assert len(blocks) == 2
    for b, exp in zip(sorted(blocks, key=lambda b: b.bbox[1]), bubbles):
        x, y, w, h = b.bbox
        tb = exp["textBox"]
        assert abs(x - tb[0]) < 12 and abs(y - tb[1]) < 12
        assert b.vertical is True
        assert b.shape == "ellipse"
        assert b.fill == (255, 255, 255)
        bx, by, bw, bh = b.bubble_box
        assert abs(bw - 2 * exp["rx"]) < 12 and abs(bh - 2 * exp["ry"]) < 12


def test_reading_order_is_right_to_left_for_manga():
    png, _ = make_page(bubbles=[{"cx": 200, "cy": 300, "rx": 100, "ry": 150, "text": "ひだりがわ"}, {"cx": 600, "cy": 300, "rx": 100, "ry": 150, "text": "みぎがわだよ"}], art=False)
    blocks = ClassicDetector().detect(rgb_of(png))
    assert len(blocks) == 2
    assert blocks[0].bbox[0] > blocks[1].bbox[0]


def test_tall_strip_uses_overlapping_windows():
    wins = processing_windows(30000)
    assert wins[0].y == 0 and wins[0].h == 4096
    assert wins[1].y == 4096 - 512
    assert wins[-1].y + wins[-1].h == 30000
    png, bubbles = make_page(800, 9000, [{"cx": 400, "cy": 600, "rx": 120, "ry": 150, "text": "はじめまして"}, {"cx": 400, "cy": 4096, "rx": 120, "ry": 150, "text": "よろしくね"}, {"cx": 400, "cy": 8200, "rx": 120, "ry": 150, "text": "またあした"}], art=False)
    blocks = ClassicDetector().detect(rgb_of(png))
    assert len(blocks) == 3
    assert any(abs(b.bubble_box[1] + b.bubble_box[3] / 2 - 4096) < 10 for b in blocks)


def test_analyze_box_finds_bubble_around_text():
    png, bubbles = make_page()
    b = analyze_box(rgb_of(png), tuple(bubbles[1]["textBox"]))
    assert b.interior is not None
    assert abs(b.bubble_box[2] - 2 * bubbles[1]["rx"]) < 12


def test_decode_rejects_bombs_and_garbage():
    with pytest.raises(AppError) as e:
        decode_image(b"<svg>not an image</svg>", 10**8)
    assert e.value.code == "UNSUPPORTED_FORMAT"
    buf = io.BytesIO()
    Image.new("L", (5000, 5000)).save(buf, format="PNG")
    with pytest.raises(AppError) as e:
        decode_image(buf.getvalue(), 1_000_000)
    assert e.value.code == "IMAGE_TOO_LARGE"


def test_telea_inpaints_textured_background():
    png, bubbles = make_page(art=False)
    rgb = rgb_of(png).copy()
    b = analyze_box(rgb, (400, 100, 120, 40))  # screentone area: no bubble
    assert b.interior is None
    clean_region(rgb, b, TeleaInpainter())
    assert rgb.shape == (1100, 800, 3)


# ---------------------------------------------------------------- translation helpers

def test_prompt_and_glossary():
    opts = TranslateOptions.model_validate({"targetLang": "ru", "glossary": [{"source": "田中", "target": "Танака", "forbidden": ["Танака-сан"]}], "context": {"entities": [{"source": "佐藤", "target": "Сато", "kind": "character", "locked": True}]}})
    p = system_prompt(opts)
    assert "田中 → Танака (never: Танака-сан)" in p
    assert "佐藤 → Сато (character) [fixed]" in p
    assert "SECURITY" in p
    hits = glossary_hits("田中さん", opts.glossary)
    assert violations("Танака-сан!", hits)


def test_parse_answers():
    assert extract_json('```json\n{"a":1,}\n```') == {"a": 1}
    tr, ents, summary, missing = parse_translations('{"translations":[{"id":"b1","text":"Да"},{"id":"b2","text":"Нет"}],"summary":"s"}', [{"id": "b1", "text": "はい"}, {"id": "b2", "text": "いいえ"}])
    assert tr["b1"]["text"] == "Да" and summary == "s" and not missing
    with pytest.raises(AppError):
        parse_translations('{"translations":[]}', [{"id": "b1", "text": "x"}])


def test_privacy_rules():
    assert is_local_url("http://localhost:1234/v1")
    assert is_local_url("http://192.168.0.5:11434/v1")
    assert not is_local_url("https://api.openai.com/v1")
    assert not is_local_url("http://localhost.evil.com")
    cloud = ProviderConfig(base_url="https://api.anthropic.com/v1", model="m", label="Claude")
    with pytest.raises(AppError):
        assert_privacy("local", cloud, "text")
    with pytest.raises(AppError):
        assert_privacy("hybrid", cloud, "image")
    assert_privacy("hybrid", cloud, "text")


# ---------------------------------------------------------------- full pipeline

async def _run(engine: Engine, png: bytes, opts: TranslateOptions):
    events = []

    async def emit(e, d):
        events.append((e, d))

    payload = await engine.process(png, opts, emit)
    return payload, events


async def test_pipeline_end_to_end_with_vision_ocr_and_local_translator(tmp_path):
    png, bubbles = make_page()
    llm = FakeLLM(ocr_texts=["どこへ行くの", "たなかさん待って"], translations={"たなかさん待って": "Танака, подожди!", "どこへ行くの": "Куда ты?"})
    engine = Engine(settings(tmp_path), llm.transport())
    opts = TranslateOptions.model_validate({"sourceLang": "ja", "targetLang": "ru", "privacy": "local", "vision": LOCAL_VISION, "translator": LOCAL_TEXT, "ocr": "vision"})
    payload, events = await _run(engine, png, opts)
    page = payload["page"]
    assert [b["originalText"] for b in page["blocks"]] == ["どこへ行くの", "たなかさん待って"]
    assert {b["translatedText"] for b in page["blocks"]} == {"Танака, подожди!", "Куда ты?"}
    assert all(b["writingDirection"] == "ttb-rl" for b in page["blocks"])
    assert all(b["bubble"]["shape"] == "ellipse" for b in page["blocks"])
    assert page["usage"] and page["timings"]["totalMs"] >= 0
    assert payload["contextUpdate"]["entities"][0]["target"] == "Танака"
    stages = [d["stage"] for e, d in events if e == "stage"]
    assert stages == ["decoding", "detecting", "ocr", "translating", "cleaning", "done"]
    # Cleaned tile: Japanese removed from bubbles, art untouched.
    tile = engine.assets.get(payload["cleanedTiles"][0]["assetId"])
    for b in bubbles:
        assert dark_inside(png, b) > 200
        assert dark_inside(tile, b) == 0
    art = rgb_of(tile)[960:1010, 140:200]
    assert (art < 60).all()
    # OCR used vision crops, translation used the text model.
    models = [c["body"]["model"] for c in llm.calls]
    assert models == ["qwen2.5vl:7b", "qwen3-14b"]
    # Second run hits the cache: no new model calls.
    payload2, events2 = await _run(engine, png, opts)
    assert len(llm.calls) == 2
    assert events2[-1][1].get("message") == "cache"
    assert payload2["page"]["blocks"] == page["blocks"]


async def test_vision_detection_single_call(tmp_path):
    png, bubbles = make_page(art=False)

    def norm(tb):
        return [round(tb[0] / 800 * 1000), round(tb[1] / 1100 * 1000), round((tb[0] + tb[2]) / 800 * 1000), round((tb[1] + tb[3]) / 1100 * 1000)]

    llm = FakeLLM(page_blocks=[{"box": norm(b["textBox"]), "text": b["text"], "translation": f"ПЕРЕВОД {i}", "type": "DIALOGUE", "vertical": True} for i, b in enumerate(bubbles)])
    engine = Engine(settings(tmp_path), llm.transport())
    opts = TranslateOptions.model_validate({"targetLang": "ru", "privacy": "local", "vision": LOCAL_VISION, "detector": "vision"})
    payload, _ = await _run(engine, png, opts)
    assert len(llm.calls) == 1
    assert [b["translatedText"] for b in payload["page"]["blocks"]] == ["ПЕРЕВОД 0", "ПЕРЕВОД 1"]
    tile = engine.assets.get(payload["cleanedTiles"][0]["assetId"])
    for b in bubbles:
        assert dark_inside(tile, b) == 0


async def test_sfx_kept_when_translation_off(tmp_path):
    png, bubbles = make_page(art=False)
    llm = FakeLLM(page_blocks=[{"box": [0, 0, 1, 1], "text": "x"}])
    llm.page_blocks = []
    engine = Engine(settings(tmp_path), llm.transport())
    opts = TranslateOptions.model_validate({"targetLang": "ru", "privacy": "local", "vision": LOCAL_VISION, "translator": LOCAL_TEXT, "ocr": "vision", "translateSfx": False})
    # Make the OCR say the first bubble is an SFX.
    orig = llm.handler

    def handler(request):
        resp = orig(request)
        import json

        data = json.loads(resp.content)
        content = json.loads(data["choices"][0]["message"]["content"])
        if "texts" in content:
            content["texts"][0]["type"] = "SFX"
            content["texts"][0]["text"] = "ドン"
            content["texts"][1]["text"] = "たなかさん待って"
            data["choices"][0]["message"]["content"] = json.dumps(content, ensure_ascii=False)
            import httpx

            return httpx.Response(200, json=data)
        return resp

    import httpx

    engine.transport = httpx.MockTransport(handler)
    payload, _ = await _run(engine, png, opts)
    sfx = [b for b in payload["page"]["blocks"] if b["textType"] == "SFX"]
    assert len(sfx) == 1 and sfx[0]["translate"] is False
    tile = engine.assets.get(payload["cleanedTiles"][0]["assetId"])
    # The SFX bubble (first in reading order = right-most/top) keeps its glyphs.
    kept = [b for b in bubbles if dark_inside(tile, b) > 200]
    assert len(kept) == 1


async def test_privacy_blocks_cloud_ocr_in_local_mode(tmp_path):
    png, _ = make_page(art=False)
    engine = Engine(settings(tmp_path), FakeLLM().transport())
    cloud = {**LOCAL_VISION, "baseUrl": "https://api.openai.com/v1", "label": "OpenAI"}
    opts = TranslateOptions.model_validate({"privacy": "local", "vision": cloud, "translator": LOCAL_TEXT, "ocr": "vision"})
    with pytest.raises(AppError) as e:
        await _run(engine, png, opts)
    assert e.value.code == "PRIVACY_VIOLATION"


async def test_tall_strip_pipeline_produces_4096_tiles(tmp_path):
    specs = [{"cx": 400, "cy": 600, "rx": 120, "ry": 150, "text": "はじめまして"}, {"cx": 400, "cy": 4096, "rx": 120, "ry": 150, "text": "よろしくね"}, {"cx": 400, "cy": 8200, "rx": 120, "ry": 150, "text": "またあした"}]
    png, bubbles = make_page(800, 9000, specs, art=False)
    llm = FakeLLM(ocr_texts=[s["text"] for s in specs])
    engine = Engine(settings(tmp_path), llm.transport())
    opts = TranslateOptions.model_validate({"sourceLang": "ja", "privacy": "local", "vision": LOCAL_VISION, "translator": LOCAL_TEXT, "ocr": "vision"})
    payload, _ = await _run(engine, png, opts)
    assert [(t["y"], t["h"]) for t in payload["cleanedTiles"]] == [(0, 4096), (4096, 4096), (8192, 808)]
    assert len(payload["page"]["blocks"]) == 3
    # The bubble across the tile boundary is clean in both tiles.
    t0 = rgb_of(engine.assets.get(payload["cleanedTiles"][0]["assetId"]))
    t1 = rgb_of(engine.assets.get(payload["cleanedTiles"][1]["assetId"]))
    stitched = np.concatenate([t0, t1])
    assert dark_inside(stitched, bubbles[1]) == 0
