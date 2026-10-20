@echo off
REM ---------------------------------------------------------------
REM  DiskScope launcher.
REM  Two deliberate choices:
REM    1. ASCII only, no UTF-8 BOM -- cmd.exe mis-parses the first
REM       line of a BOM'd batch file.
REM    2. python -u so the banner appears instantly instead of
REM       sitting in stdio's block buffer.
REM ---------------------------------------------------------------
chcp 65001 >nul
cd /d "%~dp0"
python -u server.py %*
if errorlevel 1 (
  echo.
  echo   [DiskScope] Failed to start.
  echo   Make sure Python 3.10+ is installed and on PATH, then try:
  echo     python "%~dp0server.py"
  echo.
  pause
)
