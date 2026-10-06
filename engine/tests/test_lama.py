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
