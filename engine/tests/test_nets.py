from __future__ import annotations

import hashlib
import struct
import json

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.api import create_app
from app.config import Settings
from app.nets import decode_frame, encode_frame

onnx = pytest.importorskip("onnx")
pytest.importorskip("onnxruntime")
from onnx import TensorProto, helper  # noqa: E402

EXT = "chrome-extension://abcdefghijklmnopabcdefghijklmnop"
H = {"authorization": "Bearer t", "origin": EXT}


def tiny_model() -> bytes:
    """y = x * 2 + 1 (float32) and the int64 ids passed through + 1: the shapes of a real net's feeds."""
    x = helper.make_tensor_value_info("x", TensorProto.FLOAT, [1, 3, None, None])
    ids = helper.make_tensor_value_info("ids", TensorProto.INT64, [1, None])
    y = helper.make_tensor_value_info("y", TensorProto.FLOAT, [1, 3, None, None])
    nid = helper.make_tensor_value_info("next", TensorProto.INT64, [1, None])
    two = helper.make_tensor("two", TensorProto.FLOAT, [], [2.0])
    one = helper.make_tensor("one", TensorProto.FLOAT, [], [1.0])
    one64 = helper.make_tensor("one64", TensorProto.INT64, [], [1])
    nodes = [helper.make_node("Mul", ["x", "two"], ["m"]), helper.make_node("Add", ["m", "one"], ["y"]), helper.make_node("Add", ["ids", "one64"], ["next"])]
    g = helper.make_graph(nodes, "tiny", [x, ids], [y, nid], [two, one, one64])
    m = helper.make_model(g, opset_imports=[helper.make_opsetid("", 17)])
    m.ir_version = 8
    return m.SerializeToString()


@pytest.fixture()
def client(tmp_path):
    app = create_app(Settings(data_dir=tmp_path, token="t", onnx_providers=["CUDAExecutionProvider", "CPUExecutionProvider"]))
    with TestClient(app) as c:
        yield c


def test_frames_round_trip():
    a = np.arange(12, dtype=np.float32).reshape(1, 3, 2, 2)
    b = np.array([[5, 6, 7]], dtype=np.int64)
    c = np.zeros((2,), dtype=np.float16)
    back = dict(decode_frame(encode_frame([("a", a), ("b", b), ("c", c)])))
    assert np.array_equal(back["a"], a) and np.array_equal(back["b"], b) and back["c"].dtype == np.float16


def test_store_open_run_release(client):
    model = tiny_model()
    sha = hashlib.sha256(model).hexdigest()
    # Not stored yet: the extension is told to send it.
    r = client.post(f"/v1/nets/{sha}/open", headers=H)
    assert r.status_code == 404
    # Wrong bytes for the id are refused.
    assert client.put(f"/v1/nets/{sha}", content=model + b"x", headers=H).status_code >= 400
    r = client.put(f"/v1/nets/{sha}", content=model, headers=H)
    assert r.json() == {"stored": True, "new": True}
    assert client.put(f"/v1/nets/{sha}", content=model, headers=H).json()["new"] is False
    r = client.post(f"/v1/nets/{sha}/open?gpu=1", headers=H)
    d = r.json()
    assert d["inputs"] == ["x", "ids"] and d["outputs"] == ["y", "next"] and d["on"] == "CPUExecutionProvider"
    x = np.random.rand(1, 3, 4, 5).astype(np.float32)
    ids = np.array([[1, 2, 3]], dtype=np.int64)
    # Many runs a minute (Manga OCR decodes a character per run): not rate limited.
    for _ in range(130):
        r = client.post(f"/v1/nets/{sha}/run?gpu=1", content=encode_frame([("x", x), ("ids", ids)]), headers=H)
        assert r.status_code == 200
    out = dict(decode_frame(r.content))
    assert np.allclose(out["y"], x * 2 + 1) and out["next"].tolist() == [[2, 3, 4]]
    info = client.get("/v1/nets", headers=H).json()
    assert info["available"] and sha in info["stored"] and info["loaded"]
    assert client.delete(f"/v1/nets/{sha}/session", headers=H).json()["released"] == 1
    assert client.get("/v1/nets", headers=H).json()["loaded"] == []


def test_needs_the_token_and_checks_frames(client):
    model = tiny_model()
    sha = hashlib.sha256(model).hexdigest()
    assert client.put(f"/v1/nets/{sha}", content=model, headers={"origin": EXT}).status_code == 401
    assert client.put("/v1/nets/notasha", content=model, headers=H).status_code >= 400
    client.put(f"/v1/nets/{sha}", content=model, headers=H)
    bad = struct.pack("<I", 10) + b"{}"
    assert client.post(f"/v1/nets/{sha}/run", content=bad, headers=H).status_code >= 400
    hdr = json.dumps({"tensors": [{"name": "x", "type": "complex", "dims": [1], "length": 8}]}).encode()
    assert client.post(f"/v1/nets/{sha}/run", content=struct.pack("<I", len(hdr)) + hdr + bytes(8), headers=H).status_code >= 400
