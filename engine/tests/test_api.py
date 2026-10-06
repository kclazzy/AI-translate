from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from app.api import create_app
from app.config import Settings

from .conftest import LOCAL_TEXT, LOCAL_VISION, FakeLLM, dark_inside, make_page

EXT = "chrome-extension://abcdefghijklmnopabcdefghijklmnop"


@pytest.fixture()
def env(tmp_path):
    s = Settings(data_dir=tmp_path, token="test-token")
    llm = FakeLLM(ocr_texts=["どこへ行くの", "たなかさん待って"])
    app = create_app(s, llm.transport())
    # One event loop for the whole test so background jobs outlive the POST request.
    with TestClient(app) as client:
        yield client, llm


def auth(origin: str | None = EXT) -> dict[str, str]:
    h = {"authorization": "Bearer test-token"}
    if origin:
        h["origin"] = origin
    return h


def test_health_is_public_but_details_need_token(env):
    client, _ = env
    r = client.get("/v1/health")
    assert r.status_code == 200 and r.json() == {"status": "ok", "version": "0.3.5", "paired": False}
    r = client.get("/v1/health", headers=auth())
    body = r.json()
    assert body["paired"] is True and "detectors" in body
    assert r.headers["access-control-allow-origin"] == EXT


def test_token_required(env):
    client, _ = env
    r = client.get("/v1/capabilities")
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "ENGINE_UNAUTHORIZED"
    r = client.get("/v1/capabilities", headers={"authorization": "Bearer wrong"})
    assert r.status_code == 401


def test_web_pages_cannot_call_the_engine(env):
    client, _ = env
    r = client.get("/v1/capabilities", headers=auth("https://evil.example"))
    assert r.status_code == 401
    assert "access-control-allow-origin" not in r.headers


def test_dns_rebinding_host_is_rejected(env):
    client, _ = env
    r = client.get("/v1/health", headers={"host": "attacker.example:8765"})
    assert r.status_code == 401


def test_cors_preflight_for_extension(env):
    client, _ = env
    r = client.options("/v1/pages/translate", headers={"origin": EXT, "access-control-request-method": "POST", "access-control-request-private-network": "true"})
    assert r.status_code == 204
    assert r.headers["access-control-allow-origin"] == EXT
    assert r.headers["access-control-allow-private-network"] == "true"


def test_rejects_bad_uploads(env):
    client, _ = env
    r = client.post("/v1/pages/translate", headers=auth(), files={"image": ("x.svg", b"<svg/>", "image/svg+xml")}, data={"options": "{}"})
    assert r.status_code == 202  # accepted as a job; the job reports the error
    job = r.json()["jobId"]
    events = client.get(f"/v1/jobs/{job}/events", headers=auth()).text
    assert "event: error" in events and "UNSUPPORTED_FORMAT" in events
    r = client.post("/v1/pages/translate", headers=auth(), files={"image": ("a.png", b"x", "image/png")}, data={"options": "not json"})
    assert r.status_code == 415


def test_full_translate_flow_over_sse(env):
    client, llm = env
    png, bubbles = make_page()
    opts = {"sourceLang": "ja", "targetLang": "ru", "privacy": "local", "vision": LOCAL_VISION, "translator": LOCAL_TEXT, "ocr": "vision"}
    r = client.post("/v1/pages/translate", headers=auth(), files={"image": ("p.png", png, "image/png")}, data={"options": json.dumps(opts)})
    assert r.status_code == 202
    job = r.json()["jobId"]
    stream = client.get(f"/v1/jobs/{job}/events", headers=auth())
    assert stream.headers["content-type"].startswith("text/event-stream")
    events = [chunk for chunk in stream.text.split("\n\n") if chunk.strip()]
    names = [e.split("\n")[0].replace("event: ", "") for e in events]
    assert names[-1] == "done" and "stage" in names
    done = json.loads(events[-1].split("data: ", 1)[1])
    assert len(done["page"]["blocks"]) == 2
    tile_id = done["cleanedTiles"][0]["assetId"]
    asset = client.get(f"/v1/assets/{tile_id}", headers=auth())
    assert asset.status_code == 200 and asset.headers["content-type"] == "image/png"
    for b in bubbles:
        assert dark_inside(asset.content, b) == 0
    status = client.get(f"/v1/jobs/{job}", headers=auth()).json()
    assert status["finished"] is True and status["error"] is None
    # Asset ids are validated (no path traversal).
    assert client.get("/v1/assets/..%2F..%2Ftoken", headers=auth()).status_code == 404


def test_text_translate_endpoint(env):
    client, _ = env
    body = {"blocks": [{"id": "b1", "type": "DIALOGUE", "text": "はい"}], "options": {"privacy": "local", "translator": LOCAL_TEXT}}
    r = client.post("/v1/text/translate", headers=auth(), json=body)
    assert r.status_code == 200
    assert r.json()["translations"]["b1"]["text"] == "RU:b1"


def test_ocr_region_endpoint(env):
    client, _ = env
    png, bubbles = make_page()
    tb = bubbles[1]["textBox"]
    opts = {"sourceLang": "ja", "privacy": "local", "vision": LOCAL_VISION, "translator": LOCAL_TEXT, "ocr": "vision"}
    r = client.post("/v1/ocr/region", headers=auth(), files={"image": ("p.png", png, "image/png")}, data={"box": json.dumps(tb), "options": json.dumps(opts)})
    assert r.status_code == 200, r.text
    block = r.json()["blocks"][0]
    assert block["originalText"] == "どこへ行くの"
    assert block["bubble"]["shape"] == "ellipse"


def test_upload_size_limit(tmp_path):
    s = Settings(data_dir=tmp_path, token="t", max_upload_bytes=1000)
    client = TestClient(create_app(s))
    r = client.post("/v1/pages/translate", headers={"authorization": "Bearer t"}, files={"image": ("big.png", b"\x89PNG" + b"0" * 5000, "image/png")})
    assert r.status_code == 413
    assert r.json()["error"]["code"] == "IMAGE_TOO_LARGE"


def test_lan_mode_accepts_private_hosts(tmp_path):
    s = Settings(data_dir=tmp_path, token="t", lan=True)
    client = TestClient(create_app(s))
    assert client.get("/v1/health", headers={"host": "192.168.1.10:8765"}).status_code == 200
    assert client.get("/v1/health", headers={"host": "8.8.8.8"}).status_code == 401
    s2 = Settings(data_dir=tmp_path, token="t", lan=False)
    client2 = TestClient(create_app(s2))
    assert client2.get("/v1/health", headers={"host": "192.168.1.10:8765"}).status_code == 401
