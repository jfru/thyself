#!/bin/bash
# Wrapper script for launchd to run the weekly sync.
# Loads the .env file, activates the venv if present, and runs the sync.

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

exec python3 "$SCRIPT_DIR/run.py"
