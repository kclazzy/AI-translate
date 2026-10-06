#!/usr/bin/env bash
# AI Translate engine — Linux/macOS launcher.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -d .venv ] || python3 -m venv .venv
. .venv/bin/activate
python -m pip install --quiet --upgrade pip
python -m pip install --quiet -e .
[ -f .env ] || cp .env.example .env
exec python -m app "$@"
