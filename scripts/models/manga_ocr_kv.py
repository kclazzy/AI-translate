"""Export the Manga OCR decoder for reading one character at a time with a cache (models-3).

Optimum will not export a BERT decoder with past keys, so the two decoder layers are written out
here with the model's own weights (kha-white/manga-ocr-base, Apache-2.0):

- manga-ocr-cross.onnx: the picture's features -> the keys and values of the cross-attention of
  both layers (made once per bubble);
- manga-ocr-step.onnx: one character -> the next character's scores, with the self-attention
  cache of the steps before (a first column that is masked out keeps every shape non-empty).

The step is checked against the model in PyTorch (the same scores), then made int8.

python scripts/models/manga_ocr_kv.py <model snapshot dir> <out dir>
"""

import sys
from pathlib import Path

import torch
from onnxruntime.quantization import QuantType, quantize_dynamic
from torch import nn
from transformers import VisionEncoderDecoderModel

H, D = 12, 64


def heads(x):
    return x.view(1, -1, H, D).transpose(1, 2)


class Cross(nn.Module):
    def __init__(self, dec):
        super().__init__()
        self.layers = dec.bert.encoder.layer

    def forward(self, enc):
        out = []
        for layer in self.layers:
            a = layer.crossattention.self
            out += [heads(a.key(enc)), heads(a.value(enc))]
        return tuple(out)


class Step(nn.Module):
    def __init__(self, dec):
        super().__init__()
        self.d = dec

    def forward(self, ids, pos, mask, k0, v0, k1, v1, ck0, cv0, ck1, cv1):
        b = self.d.bert
        e = b.embeddings
        h = e.LayerNorm(e.word_embeddings(ids) + e.position_embeddings(pos) + e.token_type_embeddings(torch.zeros_like(ids)))
        neg = (1.0 - mask[:, None, None, :].float()) * -1e9
        past = [(k0, v0), (k1, v1)]
        cross = [(ck0, cv0), (ck1, cv1)]
        present = []
        for i, layer in enumerate(b.encoder.layer):
            a = layer.attention.self
            q = heads(a.query(h))
            k = torch.cat([past[i][0], heads(a.key(h))], 2)
            v = torch.cat([past[i][1], heads(a.value(h))], 2)
            present += [k, v]
            att = (torch.softmax(q @ k.transpose(-1, -2) / 8.0 + neg, -1) @ v).transpose(1, 2).reshape(1, -1, H * D)
            h = layer.attention.output.LayerNorm(layer.attention.output.dense(att) + h)
            c = layer.crossattention.self
            q = heads(c.query(h))
            att = (torch.softmax(q @ cross[i][0].transpose(-1, -2) / 8.0, -1) @ cross[i][1]).transpose(1, 2).reshape(1, -1, H * D)
            h = layer.crossattention.output.LayerNorm(layer.crossattention.output.dense(att) + h)
            h = layer.output.LayerNorm(layer.output.dense(layer.intermediate.intermediate_act_fn(layer.intermediate.dense(h))) + h)
        return (self.d.cls(h), *present)


def main(src: Path, out: Path) -> None:
    out.mkdir(parents=True, exist_ok=True)
    m = VisionEncoderDecoderModel.from_pretrained(str(src)).eval()
    assert m.decoder.config.num_hidden_layers == 2 and m.decoder.config.hidden_size == H * D, m.decoder.config
    assert getattr(m, "enc_to_dec_proj", None) is None
    dec = m.decoder
    cross, step = Cross(dec).eval(), Step(dec).eval()
    with torch.no_grad():
        # The same scores as the model itself, character by character, on random features.
        enc = torch.randn(1, 197, H * D)
        ids = [2, 150, 900, 33, 4000]
        ref = dec(input_ids=torch.tensor([ids]), encoder_hidden_states=enc).logits[0]
        ck = cross(enc)
        past = [torch.zeros(1, H, 1, D) for _ in range(4)]
        worst = 0.0
        for t, tok in enumerate(ids):
            mask = torch.tensor([[0] + [1] * (t + 1)])
            logits, *past = step(torch.tensor([[tok]]), torch.tensor([[t]]), mask, *past, *ck)
            worst = max(worst, (logits[0, 0] - ref[t]).abs().max().item())
        print(f"largest score difference against the model: {worst:.2e}")
        assert worst < 1e-3, worst
        torch.onnx.export(cross, (enc,), str(out / "cross-fp32.onnx"), input_names=["encoder_hidden_states"], output_names=["ck0", "cv0", "ck1", "cv1"], dynamic_axes={"encoder_hidden_states": {1: "n"}}, opset_version=17)
        mask = torch.tensor([[0, 1]])
        p0 = [torch.zeros(1, H, 1, D) for _ in range(4)]
        names = ["k0", "v0", "k1", "v1"]
        torch.onnx.export(
            step,
            (torch.tensor([[2]]), torch.tensor([[0]]), mask, *p0, *ck),
            str(out / "step-fp32.onnx"),
            input_names=["input_ids", "position_ids", "attention_mask", *names, "ck0", "cv0", "ck1", "cv1"],
            output_names=["logits", *[f"present_{n}" for n in names]],
            dynamic_axes={"attention_mask": {1: "p1"}, **{n: {2: "p"} for n in names}, **{f"present_{n}": {2: "p1"} for n in names}, **{n: {2: "n"} for n in ["ck0", "cv0", "ck1", "cv1"]}},
            opset_version=17,
        )
    quantize_dynamic(str(out / "step-fp32.onnx"), str(out / "manga-ocr-step-int8.onnx"), weight_type=QuantType.QUInt8)
    quantize_dynamic(str(out / "cross-fp32.onnx"), str(out / "manga-ocr-cross-int8.onnx"), weight_type=QuantType.QUInt8)


if __name__ == "__main__":
    main(Path(sys.argv[1]), Path(sys.argv[2]))
