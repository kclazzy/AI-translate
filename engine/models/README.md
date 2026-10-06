# Optional model weights

Nothing here is required: the engine works out of the box with the classical bubble
detector, a vision LLM (Ollama / LM Studio / cloud) for OCR and OpenCV inpainting.

| Model | What for | How to get it | License (check before redistributing) |
| --- | --- | --- | --- |
| manga-ocr | Japanese OCR trained on manga | `pip install manga-ocr` — downloads weights from Hugging Face on first use | Apache-2.0 |
| PaddleOCR | Korean / Chinese OCR | `pip install paddleocr paddlepaddle` | Apache-2.0 |
| LaMa (ONNX) | High-quality inpainting of text over artwork | Download `lama_fp32.onnx` (Carve/LaMa-ONNX on Hugging Face), put it here, set `AIT_LAMA_ONNX=models/lama_fp32.onnx` | Apache-2.0 |

Weights are not committed to the repository and are not bundled in releases.
