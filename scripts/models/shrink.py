"""Make Manga OCR smaller for the browser: int8 weights (the processor).

The fp16 files of models-1 are not used: the converted decoder does not load (a Cast of the wrong type).

python scripts/models/shrink.py <dir with encoder_model.onnx, decoder_model.onnx> <out dir>
"""

import sys
from pathlib import Path

from onnxruntime.quantization import QuantType, quantize_dynamic


def main(src: Path, out: Path) -> None:
    out.mkdir(parents=True, exist_ok=True)
    for part in ("encoder", "decoder"):
        model = src / f"{part}_model.onnx"
        quantize_dynamic(str(model), str(out / f"manga-ocr-{part}-int8.onnx"), weight_type=QuantType.QUInt8)


if __name__ == "__main__":
    main(Path(sys.argv[1]), Path(sys.argv[2]))
