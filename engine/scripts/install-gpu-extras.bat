@echo off
REM Optional local models for RTX 30/40/50 cards. RTX 50xx (Blackwell) needs PyTorch built for CUDA 12.8 (cu128).
cd /d "%~dp0\.."
call .venv\Scripts\activate.bat
echo Installing PyTorch (CUDA 12.8)...
python -m pip install torch --index-url https://download.pytorch.org/whl/cu128
echo Installing manga-ocr (Japanese OCR, downloads ~450 MB of weights on first use)...
python -m pip install manga-ocr
echo Installing ONNX Runtime GPU (for LaMa inpainting)...
python -m pip uninstall -y onnxruntime >nul 2>&1
python -m pip install onnxruntime-gpu
echo Done. Put lama_fp32.onnx into engine\models and set AIT_LAMA_ONNX=models\lama_fp32.onnx in .env
pause
