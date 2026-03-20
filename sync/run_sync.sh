#!/bin/bash
# Wrapper script for launchd to run the hourly sync.
# Loads the .env file, activates the venv if present, and runs the sync.
#
# Uses datarep for data retrieval when available, falls back to legacy
# direct-sync scripts if datarep is not running.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

# Load .env if present
if [ -f "$PROJECT_DIR/.env" ]; then
    set -a
    source "$PROJECT_DIR/.env"
    set +a
fi

# Activate venv if present
if [ -f "$PROJECT_DIR/.venv/bin/activate" ]; then
    source "$PROJECT_DIR/.venv/bin/activate"
fi

# Ensure log directory exists
mkdir -p "${THYSELF_DATA_DIR:-$HOME/Library/Application Support/Thyself}/logs"

# Auto-start datarep if not running
if ! curl -s --max-time 2 http://127.0.0.1:7080/health > /dev/null 2>&1; then
    echo "datarep not running, attempting auto-start..."
    if command -v datarep > /dev/null 2>&1; then
        datarep init 2>/dev/null || true
        datarep start &
    elif python3 -m datarep --help > /dev/null 2>&1; then
        python3 -m datarep init 2>/dev/null || true
        python3 -m datarep start &
    fi
    # Wait up to 10 seconds for health
    for i in $(seq 1 10); do
        sleep 1
        if curl -s --max-time 2 http://127.0.0.1:7080/health > /dev/null 2>&1; then
            echo "datarep started successfully"
            break
        fi
    done
fi

# Use datarep sync if healthy, otherwise fall back to legacy
if curl -s --max-time 2 http://127.0.0.1:7080/health > /dev/null 2>&1; then
    echo "datarep is running — using datarep sync"
    exec python3 "$SCRIPT_DIR/run_datarep.py"
else
    echo "datarep not available — falling back to legacy sync"
    exec python3 "$SCRIPT_DIR/run.py"
fi
