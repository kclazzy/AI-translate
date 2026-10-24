"""Faster Manga OCR for the browser (models-3), checked against the way it reads now:

- the encoder in fp16 for the video card (WebGPU), inputs and outputs kept fp32 (made here from
  the fp32 export used for models-1);
- the decoder with a cache (manga_ocr_kv.py): cross-attention once per bubble, one step per character.

On rendered Japanese lines: the same text as before, and the time per character. The report goes
into the release as REPORT.txt.

python scripts/models/manga_ocr_fast.py <fp32 encoder> <old int8 encoder> <old int8 decoder> <vocab> <out dir (with the kv files)>
"""

import sys
import time
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort
from onnxconverter_common import float16
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


def new_read(enc, cross, step, x):
    h = enc.run(None, {enc.get_inputs()[0].name: x})[0]
    t0 = time.perf_counter()
    ck = cross.run(None, {"encoder_hidden_states": h})
    past = [np.zeros((1, 12, 1, 64), np.float32) for _ in range(4)]
    ids = [2]
    for t in range(60):
        feeds = {"input_ids": np.array([[ids[-1]]], np.int64), "position_ids": np.array([[t]], np.int64), "attention_mask": np.array([[0] + [1] * (t + 1)], np.int64)}
        feeds.update({n: v for n, v in zip(["k0", "v0", "k1", "v1"], past)})
        feeds.update({n: v for n, v in zip(["ck0", "cv0", "ck1", "cv1"], ck)})
        logits, *past = step.run(None, feeds)
        n = int(logits[0, -1].argmax())
        if n == 3:
            break
        ids.append(n)
    return ids, (time.perf_counter() - t0) / max(1, len(ids))


def main(enc32: Path, old_enc: Path, old_dec: Path, vocab_path: Path, out: Path) -> None:
    out.mkdir(parents=True, exist_ok=True)
    report = []
    enc16 = float16.convert_float_to_float16(onnx.load(str(enc32)), keep_io_types=True)
    onnx.save(enc16, str(out / "manga-ocr-encoder-fp16.onnx"))
    vocab = vocab_path.read_text(encoding="utf-8").split("\n")
    so = ort.SessionOptions()
    so.intra_op_num_threads = 1
    cpu = ["CPUExecutionProvider"]
    S = lambda p: ort.InferenceSession(str(p), so, providers=cpu)
    o_enc, o_dec = S(old_enc), S(old_dec)
    n_enc = S(out / "manga-ocr-encoder-fp16.onnx")
    cross, step = S(out / "manga-ocr-cross-int8.onnx"), S(out / "manga-ocr-step-int8.onnx")
    cross32, step32 = S(out / "cross-fp32.onnx"), S(out / "step-fp32.onnx")
    report.append("step inputs: " + ", ".join(f"{i.name}{i.shape}:{i.type}" for i in step.get_inputs()))
    report.append("step outputs: " + ", ".join(f"{o.name}{o.shape}" for o in step.get_outputs()))
    report.append("encoder fp16: " + ", ".join(f"{i.name}{i.shape}:{i.type}" for i in n_enc.get_inputs()) + " -> " + ", ".join(f"{o.name}{o.shape}:{o.type}" for o in n_enc.get_outputs()))
    same = 0
    total = 0
    for text in LINES:
        for vertical in (False, True):
            x = picture(text, vertical)
            a, ta = old_read(o_enc, o_dec, x)
            b, tb = new_read(n_enc, cross, step, x)
            c, tc = new_read(n_enc, cross32, step32, x)
            total += 1
            same += text_of(a, vocab) == text_of(b, vocab)
            report.append(f"{text} {'v' if vertical else 'h'}: old={text_of(a, vocab)} ({ta*1000:.0f} ms/char) kv-int8={text_of(b, vocab)} ({tb*1000:.0f} ms/char) kv-fp32={text_of(c, vocab)} ({tc*1000:.0f} ms/char)")
    report.append(f"same text as before: {same}/{total}")
    (out / "REPORT.txt").write_text("\n".join(report) + "\n", encoding="utf-8")
    print("\n".join(report))
    for f in ("cross-fp32.onnx", "step-fp32.onnx"):
        (out / f).unlink()


if __name__ == "__main__":
    main(*(Path(a) for a in sys.argv[1:6]))
