#!/usr/bin/env bash
set -e

# pysim-otaman-server start script
# Starts the server, preferring the venv if it exists.
# Auto-detects PC/SC reader if available.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VENV_DIR="$SCRIPT_DIR/.venv"

# Auto-detect reader
READER_ARGS=""
if command -v pcscd > /dev/null 2>&1 && pgrep -x pcscd > /dev/null 2>&1; then
    READER_ARGS="-p 0"
elif [ -e /dev/ttyUSB0 ]; then
    READER_ARGS="-d /dev/ttyUSB0"
fi

SERVER=""
if [ -f "$VENV_DIR/bin/pysim-otaman-server" ]; then
    SERVER="$VENV_DIR/bin/pysim-otaman-server"
elif command -v pysim-otaman-server &> /dev/null; then
    SERVER="pysim-otaman-server"
elif [ -f "$SCRIPT_DIR/pysim_otaman_server/__main__.py" ]; then
    echo "Starting pysim-otaman-server from source on http://127.0.0.1:8080"
    cd "$SCRIPT_DIR" && python3 -m pysim_otaman_server --http-port 8080 $READER_ARGS
    exit $?
else
    echo "Error: pysim-otaman-server not installed."
    echo "Run setup.sh first or install manually:"
    echo "  pip install pysim-otaman-server"
    exit 1
fi

echo "Starting pysim-otaman-server on http://127.0.0.1:8080"
echo "Press Ctrl+C to stop."
$SERVER --http-port 8080 $READER_ARGS