#!/usr/bin/env bash
# AI Translate engine — Linux/macOS launcher.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -d .venv ] || python3 -m venv .venv
. .venv/bin/activate
python -m pip install --quiet --upgrade pip
python -m pip install --quiet -e .
# ONNX Runtime for the extension's networks: CUDA with an NVIDIA card, the processor otherwise.
if ! python -c "import onnxruntime" 2>/dev/null; then
  if command -v nvidia-smi >/dev/null 2>&1; then python -m pip install --quiet "onnxruntime-gpu[cuda,cudnn]"; else python -m pip install --quiet onnxruntime; fi
fi
[ -f .env ] || cp .env.example .env
exec python -m app "$@"
