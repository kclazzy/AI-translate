"""Faster Manga OCR for the browser (models-3):

- the decoder with a cache of past steps (one file, "merged": the first step and the next ones),
  int8 weights — each next character no longer runs the whole text and the picture again;
- the encoder in fp16 for the video card (WebGPU), inputs and outputs kept fp32.

Then the new decoder is checked against the old way (no cache) on rendered Japanese lines: the same
text, and the time per character. The report goes into the release as REPORT.txt.

python scripts/models/manga_ocr_fast.py <optimum export dir> <old int8 encoder> <old int8 decoder> <vocab> <out dir>
"""

import sys
import time
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort
from onnxconverter_common import float16
from onnxruntime.quantization import QuantType, quantize_dynamic
from PIL import Image, ImageDraw, ImageFont

LINES = ["なにしてるの", "おはようございます", "ちょっと待って！", "今日はいい天気ですね", "ありがとう", "どこへ行くの？"]


def picture(text: str, vertical: bool) -> np.ndarray:
    font = ImageFont.truetype("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", 40)
    w, h = (90, 60 + 46 * len(text)) if vertical else (60 + 44 * len(text), 90)
    im = Image.new("RGB", (w, h), "white")
    d = ImageDraw.Draw(im)
    if vertical:
        for i, ch in enumerate(text):
            d.text((25, 25 + 46 * i), ch, fill="black", font=font)
    else:
        d.text((30, 20), text, fill="black", font=font)
    g = np.asarray(im.convert("L").resize((224, 224), Image.BILINEAR), dtype=np.float32)
    v = (g / 255 - 0.5) / 0.5
    return np.stack([v, v, v])[None]


def text_of(ids, vocab):
    out = ""
    for i in ids:
        if i < 5:
            continue
        t = vocab[i]
        if t.startswith("[") and t.endswith("]"):
            continue
        out += t[2:] if t.startswith("##") else t
    return out


def old_read(enc, dec, x):
    h = enc.run(None, {"pixel_values": x})[0]
    ids = [2]
    t0 = time.perf_counter()
    for _ in range(60):
        logits = dec.run(None, {"input_ids": np.array([ids], dtype=np.int64), "encoder_hidden_states": h})[0]
        n = int(logits[0, -1].argmax())
        if n == 3:
            break
        ids.append(n)
    return ids, (time.perf_counter() - t0) / max(1, len(ids))


def new_read(enc, dec, x):
    h = enc.run(None, {enc.get_inputs()[0].name: x})[0]
    names = [i.name for i in dec.get_inputs()]
    past = {}
    for i in dec.get_inputs():
        if i.name.startswith("past_key_values"):
            shape = [1 if d == "batch_size" or not isinstance(d, int) and "batch" in str(d) else (0 if not isinstance(d, int) else d) for d in i.shape]
            past[i.name] = np.zeros(shape, dtype=np.float32)
    ids = [2]
    t0 = time.perf_counter()
    first = True
    for _ in range(60):
        feeds = {"input_ids": np.array([[ids[-1]]], dtype=np.int64), "encoder_hidden_states": h, **past}
        if "use_cache_branch" in names:
            feeds["use_cache_branch"] = np.array([not first])
        outs = dec.run(None, feeds)
        out_names = [o.name for o in dec.get_outputs()]
        logits = outs[out_names.index("logits")]
        for k, v in zip(out_names, outs):
            if k.startswith("present"):
                pk = k.replace("present", "past_key_values")
                # The cross-attention cache stays what the first step made.
                if first or ".decoder." in pk:
                    past[pk] = v
        first = False
        n = int(logits[0, -1].argmax())
        if n == 3:
            break
        ids.append(n)
    return ids, (time.perf_counter() - t0) / max(1, len(ids))


def main(exp: Path, old_enc: Path, old_dec: Path, vocab_path: Path, out: Path) -> None:
    out.mkdir(parents=True, exist_ok=True)
    report = []
    merged = exp / "decoder_model_merged.onnx"
    quantize_dynamic(str(merged), str(out / "manga-ocr-decoder-kv-int8.onnx"), weight_type=QuantType.QUInt8)
    enc16 = float16.convert_float_to_float16(onnx.load(str(exp / "encoder_model.onnx")), keep_io_types=True)
    onnx.save(enc16, str(out / "manga-ocr-encoder-fp16.onnx"))
    vocab = vocab_path.read_text(encoding="utf-8").split("\n")
    so = ort.SessionOptions()
    so.intra_op_num_threads = 1
    cpu = ["CPUExecutionProvider"]
    o_enc, o_dec = ort.InferenceSession(str(old_enc), so, providers=cpu), ort.InferenceSession(str(old_dec), so, providers=cpu)
    n_enc = ort.InferenceSession(str(out / "manga-ocr-encoder-fp16.onnx"), so, providers=cpu)
    n_dec = ort.InferenceSession(str(out / "manga-ocr-decoder-kv-int8.onnx"), so, providers=cpu)
    f_dec = ort.InferenceSession(str(merged), so, providers=cpu)
    report.append("decoder inputs: " + ", ".join(f"{i.name}{i.shape}:{i.type}" for i in n_dec.get_inputs()))
    report.append("decoder outputs: " + ", ".join(f"{o.name}{o.shape}" for o in n_dec.get_outputs()))
    report.append("encoder fp16 inputs: " + ", ".join(f"{i.name}{i.shape}:{i.type}" for i in n_enc.get_inputs()) + " outputs: " + ", ".join(f"{o.name}{o.shape}:{o.type}" for o in n_enc.get_outputs()))
    same = 0
    total = 0
    for text in LINES:
        for vertical in (False, True):
            x = picture(text, vertical)
            a, ta = old_read(o_enc, o_dec, x)
            b, tb = new_read(n_enc, n_dec, x)
            c, tc = new_read(n_enc, f_dec, x)
            total += 1
            same += text_of(a, vocab) == text_of(b, vocab)
            report.append(f"{text} {'v' if vertical else 'h'}: old={text_of(a, vocab)} ({ta*1000:.0f} ms/char) kv-int8={text_of(b, vocab)} ({tb*1000:.0f} ms/char) kv-fp32={text_of(c, vocab)} ({tc*1000:.0f} ms/char)")
    report.append(f"same text as before: {same}/{total}")
    (out / "REPORT.txt").write_text("\n".join(report) + "\n", encoding="utf-8")
    print("\n".join(report))


if __name__ == "__main__":
    main(*(Path(a) for a in sys.argv[1:6]))
