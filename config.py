"""
Centralized configuration for thyself.

All paths and identity settings are configurable via environment variables.
Set them in your .env file or shell profile. Defaults assume macOS with data
stored in ~/Library/Application Support/Thyself/.
"""

from pathlib import Path
import os

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

# ─── Data directory (all user data lives here) ───────────────────────
DATA_DIR = Path(os.environ.get(
    "THYSELF_DATA_DIR",
    Path.home() / "Library" / "Application Support" / "Thyself",
))
DATA_DIR.mkdir(parents=True, exist_ok=True)

DB_PATH = DATA_DIR / "thyself.db"
SESSIONS_DIR = DATA_DIR / "sessions"
EXTRACTION_RESULTS_DIR = DATA_DIR / "extraction_results"
SYNTHESIS_RESULTS_DIR = DATA_DIR / "synthesis_results"
MEDITATIONS_DIR = DATA_DIR / "meditations"

# ─── Identity ────────────────────────────────────────────────────────
SUBJECT_NAME = os.environ.get("THYSELF_SUBJECT_NAME", "User")
MY_EMAIL = os.environ.get("THYSELF_EMAIL", "")

# ─── Model ───────────────────────────────────────────────────────────
CLAUDE_MODEL = os.environ.get("THYSELF_MODEL", "claude-opus-4-6")
CLAUDE_BETA_FLAGS = ["context-1m-2025-08-07"]

# ─── Device-specific (override via env or .env) ─────────────────────
IPHONE_BACKUP_PATH = os.environ.get("THYSELF_IPHONE_BACKUP", "")
MACOS_CONTACTS_DB = os.environ.get("THYSELF_CONTACTS_DB", "")
CONTACTS_ANNOTATION_CSV = os.environ.get("THYSELF_CONTACTS_CSV", "") or None
GOOGLE_CLOUD_PROJECT = os.environ.get("THYSELF_GCP_PROJECT", "")
