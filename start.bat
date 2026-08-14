@echo off
REM pysim-otaman-server start script for Windows
REM Starts the server, preferring the venv if it exists.
REM PC/SC is built into Windows, so defaults to reader 0.

set VENV_DIR=%~dp0.venv

if exist "%VENV_DIR%\Scripts\pysim-otaman-server.exe" (
    echo Starting pysim-otaman-server from venv on http://127.0.0.1:8080
    echo Press Ctrl+C to stop.
    "%VENV_DIR%\Scripts\pysim-otaman-server.exe" --http-port 8080 -p 0
    goto :eof
)

if exist "%~dp0pysim_otaman_server\__main__.py" (
    echo Starting pysim-otaman-server from source on http://127.0.0.1:8080
    echo Press Ctrl+C to stop.
    python -m pysim_otaman_server --http-port 8080 -p 0
    goto :eof
)

where pysim-otaman-server >nul 2>&1
if %errorlevel% equ 0 (
    echo Starting pysim-otaman-server on http://127.0.0.1:8080
    echo Press Ctrl+C to stop.
    pysim-otaman-server --http-port 8080 -p 0
    goto :eof
)

echo Error: pysim-otaman-server not installed.
echo Run setup.bat first or install manually:
echo   pip install pysim-otaman-server
pause