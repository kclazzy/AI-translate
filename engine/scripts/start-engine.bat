@echo off
REM AI Translate engine — Windows launcher. Run from the engine folder or double-click.
cd /d "%~dp0\.."
if not exist .venv (
  echo Creating Python virtual environment...
  py -3.12 -m venv .venv 2>nul || python -m venv .venv
)
call .venv\Scripts\activate.bat
python -m pip install --quiet --upgrade pip
python -m pip install --quiet -e .
REM ONNX Runtime for the extension's networks on the video card: CUDA with an NVIDIA card, DirectML otherwise.
python -m pip show onnxruntime-gpu >nul 2>&1 || python -m pip show onnxruntime-directml >nul 2>&1 || (
  where nvidia-smi >nul 2>&1 && (
    echo Installing ONNX Runtime for NVIDIA ^(CUDA^), about 1 GB once...
    python -m pip uninstall -y onnxruntime >nul 2>&1
    python -m pip install --quiet "onnxruntime-gpu[cuda,cudnn]"
  ) || (
    echo Installing ONNX Runtime ^(DirectML^)...
    python -m pip uninstall -y onnxruntime >nul 2>&1
    python -m pip install --quiet onnxruntime-directml
  )
)
if not exist .env copy .env.example .env >nul
python -m app %*
