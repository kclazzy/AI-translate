"""LaMa ONNX plumbing test with a stand-in model that has the same inputs/outputs
(image [1,3,512,512] 0..1, mask [1,1,512,512]) and paints masked areas mid-grey."""
from __future__ import annotations

import numpy as np
import pytest

onnx = pytest.importorskip("onnx")
pytest.importorskip("onnxruntime")

from onnx import TensorProto, helper  # noqa: E402

from app.inpainting import LamaInpainter  # noqa: E402


def build_fake_lama(path: str) -> None:
    image = helper.make_tensor_value_info("image", TensorProto.FLOAT, [1, 3, 512, 512])
    mask = helper.make_tensor_value_info("mask", TensorProto.FLOAT, [1, 1, 512, 512])
    out = helper.make_tensor_value_info("output", TensorProto.FLOAT, [1, 3, 512, 512])
    zero = helper.make_tensor("zero", TensorProto.FLOAT, [], [0.0])
    grey = helper.make_tensor("grey", TensorProto.FLOAT, [], [127.0])
    nodes = [
        helper.make_node("Mul", ["image", "zero"], ["z"]),
        helper.make_node("Add", ["z", "grey"], ["g"]),
        helper.make_node("Mul", ["mask", "zero"], ["mz"]),
        helper.make_node("Add", ["g", "mz"], ["output"]),
    ]
    graph = helper.make_graph(nodes, "fake_lama", [image, mask], [out], initializer=[zero, grey])
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 13)])
    model.ir_version = 8
    onnx.save(model, path)


def test_lama_inpainter_only_changes_masked_pixels(tmp_path):
    path = str(tmp_path / "lama.onnx")
    build_fake_lama(path)
    lama = LamaInpainter(path, ["CUDAExecutionProvider", "CPUExecutionProvider"])
    rgb = np.full((300, 200, 3), 250, np.uint8)
    rgb[100:150, 50:120] = 10
    mask = np.zeros((300, 200), np.uint8)
    mask[100:150, 50:120] = 1
    out = lama.inpaint(rgb, mask)
    assert out.shape == rgb.shape
    assert np.all(out[0:90] == 250)
    inside = out[105:145, 55:115]
    assert abs(int(inside.mean()) - 127) <= 2


def test_plain_background_is_filled_without_the_model():
    import numpy as np

    from app.inpainting import inpaint_or_fill

    class Boom:
        name = "boom"

        def inpaint(self, rgb, mask):  # pragma: no cover - must not be called
            raise AssertionError("LaMa called on a plain background")

    # A white bubble with JPEG-like noise.
    rng = np.random.default_rng(1)
    rgb = (250 - rng.integers(0, 12, (60, 60, 3))).astype(np.uint8)
    rgb[20:40, 20:40] = 0
    mask = np.zeros((60, 60), np.uint8)
    mask[18:42, 18:42] = 1
    out = inpaint_or_fill(rgb, mask, Boom())
    assert all(v > 235 for v in out[30, 30])

    # A grey plate goes to the model.
    grey = np.full((60, 60, 3), (60, 62, 70), np.uint8)
    seen = []

    class Grey:
        name = "g"

        def inpaint(self, rgb, mask):
            seen.append(1)
            return rgb

    inpaint_or_fill(grey, mask, Grey())
    assert seen == [1]

    # Art around the letters: the model is asked.
    art = (np.indices((60, 60)).sum(axis=0)[..., None] * np.array([7, 3, 5]) % 256).astype(np.uint8)
    called = []

    class Model:
        name = "m"

        def inpaint(self, rgb, mask):
            called.append(1)
            return rgb

    inpaint_or_fill(art, mask, Model())
    assert called == [1]
