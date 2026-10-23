"""Make Manga OCR smaller for the browser: int8 weights (processor) and fp16 (video card).

python scripts/models/shrink.py <dir with encoder_model.onnx, decoder_model.onnx> <out dir>
"""

import sys
from pathlib import Path

import onnx
from onnxconverter_common import float16
from onnxruntime.quantization import QuantType, quantize_dynamic


def main(src: Path, out: Path) -> None:
    out.mkdir(parents=True, exist_ok=True)
    for part in ("encoder", "decoder"):
        model = src / f"{part}_model.onnx"
        quantize_dynamic(str(model), str(out / f"manga-ocr-{part}-int8.onnx"), weight_type=QuantType.QUInt8)
        half = float16.convert_float_to_float16(onnx.load(str(model)), keep_io_types=True)
        onnx.save(half, str(out / f"manga-ocr-{part}-fp16.onnx"))


if __name__ == "__main__":
    main(Path(sys.argv[1]), Path(sys.argv[2]))
