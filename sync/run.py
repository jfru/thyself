#!/usr/bin/env python3
"""
Weekly sync orchestrator for thyself.

Runs each data source sync in sequence, logs results to the sync_runs table,
and handles errors gracefully so one failed source doesn't block the others.

Profile-aware: reads the active profile's data_dir and selected_sources from
the Thyself profile system. Falls back to config.py / env vars if no profile
system is configured.

Usage:
    python sync/run.py              # Run all sources for the active profile
    python sync/run.py --source gmail   # Run one source
"""

import argparse
import json
import logging
import sqlite3
import sys
import traceback
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

# Profile source keys → sync module keys
PROFILE_SOURCE_TO_SYNC = {
    "imessage": ["imessage"],
    "whatsapp": ["whatsapp_desktop"],
    "gmail": ["gmail"],
}


def get_active_profile() -> tuple[Path | None, list[str] | None]:
    """Read the active profile from the Thyself profile system.

    Returns (data_dir, selected_sources) or (None, None) if no profile
    system is configured.
    """
    app_support = Path.home() / "Library" / "Application Support" / "Thyself"
    active_file = app_support / "active_profile"
    profiles_file = app_support / "profiles.json"

    if not active_file.exists() or not profiles_file.exists():
        return None, None

    try:
        active_id = active_file.read_text().strip()
        profiles = json.loads(profiles_file.read_text())
        for profile in profiles:
            if profile["id"] == active_id:
                return Path(profile["data_dir"]), profile.get("selected_sources", [])
    except (json.JSONDecodeError, KeyError, OSError):
        pass

    return None, None


def resolve_paths() -> tuple[Path, Path]:
    """Return (db_path, log_dir) using the profile system with config.py fallback."""
    profile_data_dir, _ = get_active_profile()
    if profile_data_dir:
        db_path = profile_data_dir / "thyself.db"
        log_dir = profile_data_dir / "logs"
    else:
        from config import DB_PATH as _db, DATA_DIR as _data
        db_path = _db
        log_dir = _data / "logs"
    return db_path, log_dir


DEFAULT_DB_PATH, LOG_DIR = resolve_paths()
LOG_DIR.mkdir(parents=True, exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler(LOG_DIR / "sync.log"),
    ],
)
log = logging.getLogger("thyself.sync")


SYNC_RUNS_SCHEMA = """
CREATE TABLE IF NOT EXISTS sync_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    started_at DATETIME NOT NULL,
    finished_at DATETIME,
    messages_added INTEGER DEFAULT 0,
    status TEXT DEFAULT 'running',
    error_message TEXT,
    last_message_at DATETIME
);
"""


def ensure_sync_runs_table(db_path):
    conn = sqlite3.connect(str(db_path))
    conn.execute(SYNC_RUNS_SCHEMA)
    conn.commit()
    conn.close()


def start_run(db_path, source):
    conn = sqlite3.connect(str(db_path))
    now = datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S")
    cur = conn.execute(
        "INSERT INTO sync_runs (source, started_at, status) VALUES (?, ?, 'running')",
        (source, now),
    )
    run_id = cur.lastrowid
    conn.commit()
    conn.close()
    return run_id


def finish_run(db_path, run_id, messages_added, last_message_at, error=None):
    conn = sqlite3.connect(str(db_path))
    now = datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S")
    status = "failed" if error else "completed"
    conn.execute(
        """UPDATE sync_runs
           SET finished_at = ?, messages_added = ?, status = ?,
               error_message = ?, last_message_at = ?
           WHERE id = ?""",
        (now, messages_added, status, error, last_message_at, run_id),
    )
    conn.commit()
    conn.close()


SOURCES = {
    "imessage": {
        "label": "iMessage",
        "module": "sync.imessage_sync",
    },
    "whatsapp_desktop": {
        "label": "WhatsApp Desktop",
        "module": "sync.whatsapp_desktop_sync",
    },
    "whatsapp_web": {
        "label": "WhatsApp Web",
        "module": "sync.whatsapp_web_sync",
    },
    "gmail": {
        "label": "Gmail",
        "module": "sync.gmail_sync",
    },
}


def run_source_sync(source_key, db_path):
    """Run sync for a single source. Returns (messages_added, last_message_at, error)."""
    source_info = SOURCES[source_key]
    label = source_info["label"]
    module_name = source_info["module"]

    log.info(f"Starting {label} sync...")
    run_id = start_run(db_path, source_key)

    try:
        import importlib
        mod = importlib.import_module(module_name)
        messages_added, last_message_at = mod.sync(thyself_db_path=db_path)

        finish_run(db_path, run_id, messages_added, last_message_at)
        log.info(f"  {label}: {messages_added} messages added (last: {last_message_at})")
        return messages_added, last_message_at, None

    except Exception as e:
        error_msg = f"{type(e).__name__}: {e}"
        finish_run(db_path, run_id, 0, None, error=error_msg)
        log.error(f"  {label} failed: {error_msg}")
        log.debug(traceback.format_exc())
        return 0, None, error_msg


def run_all(db_path=None, sources=None):
    """Run sync for all (or specified) sources.

    When sources is None, uses the active profile's selected_sources to
    determine which sync modules to run. Falls back to all sources if
    no profile is configured.
    """
    db_path = db_path or DEFAULT_DB_PATH
    ensure_sync_runs_table(db_path)

    if sources is None:
        _, profile_sources = get_active_profile()
        if profile_sources:
            source_keys = []
            for ps in profile_sources:
                source_keys.extend(PROFILE_SOURCE_TO_SYNC.get(ps, []))
            if not source_keys:
                log.info("Active profile has no syncable sources configured")
                return {}
        else:
            source_keys = list(SOURCES.keys())
    else:
        source_keys = sources

    log.info(f"Starting weekly sync for: {', '.join(source_keys)}")
    log.info(f"Database: {db_path}")

    results = {}
    total_added = 0

    for key in source_keys:
        if key not in SOURCES:
            log.warning(f"Unknown source: {key}, skipping")
            continue
        added, last, error = run_source_sync(key, db_path)
        results[key] = {"added": added, "last": last, "error": error}
        total_added += added

    log.info(f"\nSync complete: {total_added} total messages added")
    for key, result in results.items():
        status = "FAILED" if result["error"] else "OK"
        log.info(f"  {SOURCES[key]['label']}: {result['added']} messages [{status}]")

    return results


def main():
    parser = argparse.ArgumentParser(description="Thyself weekly message sync")
    parser.add_argument(
        "--source",
        choices=list(SOURCES.keys()),
        help="Run sync for a single source (default: all)",
    )
    parser.add_argument(
        "--db",
        type=str,
        default=None,
        help="Path to thyself.db (default: from config)",
    )
    args = parser.parse_args()

    sources = [args.source] if args.source else None
    db_path = Path(args.db) if args.db else None
    run_all(db_path=db_path, sources=sources)


if __name__ == "__main__":
    main()
