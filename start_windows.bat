@echo off
setlocal
cd /d "%~dp0"
where py >nul 2>nul
if not errorlevel 1 (
  py -3 -c "import sys; raise SystemExit(0 if sys.version_info >= (3,10) else 1)" >nul 2>nul
  if not errorlevel 1 (
    py -3 -m ats_viewer --open %*
    if errorlevel 1 pause
    exit /b
  )
)
where python >nul 2>nul
if not errorlevel 1 (
  python -c "import sys; raise SystemExit(0 if sys.version_info >= (3,10) else 1)" >nul 2>nul
  if not errorlevel 1 (
    python -m ats_viewer --open %*
    if errorlevel 1 pause
    exit /b
  )
)
echo Python 3.10 or newer is required. Install it from https://www.python.org/downloads/
echo Choose Add Python to PATH during installation, then reopen this launcher.
pause
exit /b 1
