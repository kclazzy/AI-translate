"""Neural networks of the browser pipeline, run here on the video card (CUDA) when asked.

The extension keeps its own page pipeline (detection, recognition, cleaning and typesetting logic
all stay in the browser); only the networks' sessions run here: the detector, PaddleOCR, Manga
OCR, LaMa and the upscaler. The extension sends each model file once (it already has them,
checked); they are kept under ``data_dir/nets`` by their SHA-256. A run gets the input tensors and
gives back the output tensors, in a small binary frame:

    u32 little-endian header length | header JSON | the tensors' bytes one after another

with the header ``{"tensors": [{"name", "type", "dims", "length"}]}``. Types: float32, float16,
int64, int32, uint8, bool.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import struct
import threading
from collections import OrderedDict
from pathlib import Path
from typing import Any

import numpy as np

from .errors import AppError

log = logging.getLogger("ait.nets")

DTYPES: dict[str, Any] = {
    "float32": np.float32,
    "float16": np.float16,
    "int64": np.int64,
    "int32": np.int32,
    "uint8": np.uint8,
    "bool": np.bool_,
}
NAMES = {np.dtype(v).str: k for k, v in DTYPES.items()}
SHA = re.compile(r"^[0-9a-f]{64}$")
#: The largest model accepted (the Manga OCR encoder in fp32 is about 350 MB).
MAX_MODEL_BYTES = 600 * 1024 * 1024
#: The largest frame of tensors (a LaMa input of 512 × 512 is 4 MB; detector windows ~5 MB).
MAX_FRAME_BYTES = 128 * 1024 * 1024
#: Sessions kept at once (each one holds its weights in video memory).
MAX_SESSIONS = 8


def available() -> bool:
    try:
        import onnxruntime  # type: ignore  # noqa: F401

        return True
    except ImportError:
        return False


def decode_frame(body: bytes) -> list[tuple[str, np.ndarray]]:
    if len(body) < 4:
        raise AppError("UNSUPPORTED_FORMAT", "Empty tensor frame", retryable=False)
    (n,) = struct.unpack_from("<I", body, 0)
    if n > 1_000_000 or 4 + n > len(body):
        raise AppError("UNSUPPORTED_FORMAT", "Bad tensor frame header", retryable=False)
    try:
        header = json.loads(body[4 : 4 + n])
        specs = header["tensors"]
    except Exception as exc:  # noqa: BLE001
        raise AppError("UNSUPPORTED_FORMAT", "Bad tensor frame header", retryable=False) from exc
    out: list[tuple[str, np.ndarray]] = []
    pos = 4 + n
    for t in specs:
        dtype = DTYPES.get(str(t.get("type")))
        if dtype is None:
            raise AppError("UNSUPPORTED_FORMAT", f"Tensor type {t.get('type')} is not supported", retryable=False)
        dims = [int(d) for d in t["dims"]]
        length = int(t["length"])
        if any(d < 0 for d in dims) or pos + length > len(body):
            raise AppError("UNSUPPORTED_FORMAT", "Tensor is cut off", retryable=False)
        arr = np.frombuffer(body, dtype=dtype, count=length // np.dtype(dtype).itemsize, offset=pos)
        if arr.size != int(np.prod(dims)):
            raise AppError("UNSUPPORTED_FORMAT", f"Tensor {t.get('name')} has a wrong size", retryable=False)
        out.append((str(t["name"]), arr.reshape(dims)))
        pos += length
    return out


def encode_frame(tensors: list[tuple[str, np.ndarray]]) -> bytes:
    specs = []
    parts = []
    for name, arr in tensors:
        a = np.ascontiguousarray(arr)
        kind = NAMES.get(a.dtype.str)
        if kind is None:
            a = a.astype(np.float32)
            kind = "float32"
        data = a.tobytes()
        specs.append({"name": name, "type": kind, "dims": list(a.shape), "length": len(data)})
        parts.append(data)
    header = json.dumps({"tensors": specs}).encode()
    return struct.pack("<I", len(header)) + header + b"".join(parts)


class Nets:
    """The stored models and their sessions (on the video card when there is one)."""

    def __init__(self, data_dir: Path, providers: list[str]):
        self.dir = data_dir / "nets"
        self.providers = providers
        self.sessions: OrderedDict[tuple[str, bool], Any] = OrderedDict()
        self.lock = threading.Lock()
        self.devices: dict[tuple[str, bool], str] = {}

    # ---- what is here ------------------------------------------------------------------
    def info(self) -> dict[str, Any]:
        ok = available()
        prov: list[str] = []
        if ok:
            import onnxruntime as ort  # type: ignore

            prov = list(ort.get_available_providers())
        stored = sorted(p.stem for p in self.dir.glob("*.onnx")) if self.dir.exists() else []
        gpu = next((p for p in self.providers if p in prov and p != "CPUExecutionProvider"), None)
        return {
            "available": ok,
            "providers": prov,
            "device": {"CUDAExecutionProvider": "cuda", "DmlExecutionProvider": "directml", "ROCMExecutionProvider": "rocm", "CoreMLExecutionProvider": "coreml"}.get(gpu or "", "cpu"),
            "stored": stored,
            "loaded": [{"sha": k[0], "gpu": k[1], "on": self.devices.get(k, "?")} for k in self.sessions],
        }

    def path(self, sha: str) -> Path:
        if not SHA.match(sha):
            raise AppError("UNSUPPORTED_FORMAT", "Model id must be a SHA-256", retryable=False)
        return self.dir / f"{sha}.onnx"

    def has(self, sha: str) -> bool:
        return self.path(sha).exists()

    def store(self, sha: str, data: bytes) -> None:
        if hashlib.sha256(data).hexdigest() != sha:
            raise AppError("UNSUPPORTED_FORMAT", "The model's bytes do not match its SHA-256", retryable=False)
        self.dir.mkdir(parents=True, exist_ok=True)
        p = self.path(sha)
        tmp = p.with_suffix(".part")
        tmp.write_bytes(data)
        os.replace(tmp, p)

    # ---- sessions ----------------------------------------------------------------------
    def _session(self, sha: str, gpu: bool):
        key = (sha, gpu)
        with self.lock:
            s = self.sessions.get(key)
            if s is not None:
                self.sessions.move_to_end(key)
                return s
        p = self.path(sha)
        if not p.exists():
            raise AppError("NOT_FOUND", "Model is not stored here yet", retryable=False)
        import onnxruntime as ort  # type: ignore

        # onnxruntime-gpu[cuda,cudnn] brings the CUDA libraries as Python packages: load them first.
        if gpu and hasattr(ort, "preload_dlls") and not getattr(Nets, "_preloaded", False):
            try:
                ort.preload_dlls()
            except Exception as exc:  # noqa: BLE001
                log.info("preload_dlls: %s", exc)
            Nets._preloaded = True
        have = set(ort.get_available_providers())
        wanted = [x for x in self.providers if x in have and (gpu or x == "CPUExecutionProvider")] or ["CPUExecutionProvider"]
        opts = ort.SessionOptions()
        opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        opts.enable_mem_pattern = "DmlExecutionProvider" not in wanted
        try:
            s = ort.InferenceSession(str(p), sess_options=opts, providers=wanted)
        except Exception as exc:  # noqa: BLE001 — a card the provider cannot use: the processor instead
            if wanted == ["CPUExecutionProvider"]:
                raise
            log.warning("%s on %s failed (%s): on the processor instead", sha[:12], wanted[0], exc)
            s = ort.InferenceSession(str(p), sess_options=opts, providers=["CPUExecutionProvider"])
        with self.lock:
            self.sessions[key] = s
            self.devices[key] = s.get_providers()[0]
            while len(self.sessions) > MAX_SESSIONS:
                old, _ = self.sessions.popitem(last=False)
                self.devices.pop(old, None)
        log.info("net %s loaded on %s", sha[:12], self.devices[key])
        return s

    def describe(self, sha: str, gpu: bool) -> dict[str, Any]:
        s = self._session(sha, gpu)
        return {"inputs": [i.name for i in s.get_inputs()], "outputs": [o.name for o in s.get_outputs()], "on": s.get_providers()[0]}

    def run(self, sha: str, gpu: bool, body: bytes) -> bytes:
        if len(body) > MAX_FRAME_BYTES:
            raise AppError("IMAGE_TOO_LARGE", "Tensor frame too large", retryable=False)
        s = self._session(sha, gpu)
        feeds = dict(decode_frame(body))
        names = [o.name for o in s.get_outputs()]
        outs = s.run(names, feeds)
        return encode_frame(list(zip(names, outs)))

    def release(self, sha: str | None = None) -> int:
        with self.lock:
            keys = [k for k in self.sessions if sha is None or k[0] == sha]
            for k in keys:
                self.sessions.pop(k, None)
                self.devices.pop(k, None)
        return len(keys)
