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
if not exist .env copy .env.example .env >nul
python -m app %*
