"""Print what the upscaler takes and gives (names, shapes, value range) for the browser code.

python scripts/models/inspect_upscale.py <model.onnx>
"""

import sys

import numpy as np
import onnxruntime as ort


def main(path: str) -> None:
    s = ort.InferenceSession(path, providers=["CPUExecutionProvider"])
    for i in s.get_inputs():
        print("input", i.name, i.shape, i.type)
    for o in s.get_outputs():
        print("output", o.name, o.shape, o.type)
    name = s.get_inputs()[0].name
    for h, w in [(64, 64), (100, 80), (128, 96), (156, 156)]:
        x = np.random.default_rng(0).random((1, 3, h, w), dtype=np.float32)
        try:
            y = s.run(None, {name: x})[0]
            print(f"in {h}x{w} -> out {y.shape[2]}x{y.shape[3]} range {y.min():.3f}..{y.max():.3f}")
        except Exception as e:  # noqa: BLE001
            print(f"in {h}x{w} -> error {str(e)[:200]}")


if __name__ == "__main__":
    main(sys.argv[1])
