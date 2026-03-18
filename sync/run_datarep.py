#!/usr/bin/env python3
"""
Weekly sync via datarep for Thyself.

Calls datarep's /sync endpoint for each registered source, then loads
the returned data into thyself.db using a lightweight Python loader.

Profile-aware: reads the active profile's data_dir, selected_sources,
and datarep_api_key from the Thyself profile system.

Usage:
    python sync/run_datarep.py                  # Sync all sources
    python sync/run_datarep.py --source gmail    # Sync one source
"""

import argparse
import json
import logging
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

try:
    import httpx
except ImportError:
    print("httpx is required: pip install httpx", file=sys.stderr)
    sys.exit(1)

DATAREP_BASE = "http://127.0.0.1:7080"

PROFILE_SOURCE_TO_DATAREP = {
    "imessage": "imessage",
    "whatsapp": "whatsapp_desktop",
    "gmail": "gmail",
}

DATAREP_SOURCE_TO_DB = {
    "imessage": "imessage",
    "whatsapp_desktop": "whatsapp",
    "gmail": "gmail",
}


def get_active_profile():
    app_support = Path.home() / "Library" / "Application Support" / "Thyself"
    active_file = app_support / "active_profile"
    profiles_file = app_support / "profiles.json"

    if not active_file.exists() or not profiles_file.exists():
        return None

    try:
        active_id = active_file.read_text().strip()
        profiles = json.loads(profiles_file.read_text())
        for profile in profiles:
            if profile["id"] == active_id:
                return profile
    except (json.JSONDecodeError, KeyError, OSError):
        pass
    return None


def resolve_config():
    profile = get_active_profile()
    if not profile:
        print("No active Thyself profile found", file=sys.stderr)
        sys.exit(1)

    data_dir = Path(profile["data_dir"])
    db_path = data_dir / "thyself.db"
    api_key = profile.get("datarep_api_key")
    selected = profile.get("selected_sources", [])

    if not api_key:
        print("No datarep API key in profile. Run Thyself onboarding first.", file=sys.stderr)
        sys.exit(1)

    return db_path, api_key, selected


DB_PATH, API_KEY, SELECTED_SOURCES = resolve_config()
LOG_DIR = DB_PATH.parent / "logs"
LOG_DIR.mkdir(parents=True, exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler(LOG_DIR / "sync.log"),
    ],
)
log = logging.getLogger("thyself.sync.datarep")


def ensure_sync_runs_table(db_path):
    conn = sqlite3.connect(str(db_path))
    conn.execute("""
        CREATE TABLE IF NOT EXISTS sync_runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source TEXT NOT NULL,
            started_at DATETIME NOT NULL,
            finished_at DATETIME,
            messages_added INTEGER DEFAULT 0,
            status TEXT DEFAULT 'running',
            error_message TEXT,
            last_message_at DATETIME
        )
    """)
    conn.commit()
    conn.close()


def start_run(db_path, source):
    conn = sqlite3.connect(str(db_path))
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")
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
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")
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


def count_messages(db_path, source):
    conn = sqlite3.connect(str(db_path))
    try:
        if source == "gmail":
            return conn.execute("SELECT COUNT(*) FROM gmail_messages").fetchone()[0]
        elif source == "chatgpt":
            return conn.execute("SELECT COUNT(*) FROM chatgpt_messages").fetchone()[0]
        else:
            return conn.execute(
                "SELECT COUNT(*) FROM messages WHERE source = ?", (source,)
            ).fetchone()[0]
    except Exception:
        return 0
    finally:
        conn.close()


def load_json_lines(db_path, json_lines, source):
    """Minimal Python loader to insert datarep results into thyself.db."""
    conn = sqlite3.connect(str(db_path))
    inserted = 0

    for line in json_lines.strip().split("\n"):
        line = line.strip()
        if not line:
            continue
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            continue

        if source in ("imessage", "whatsapp"):
            source_id = (
                record.get("source_message_id")
                or record.get("source_id")
                or record.get("id")
            )
            if source_id:
                exists = conn.execute(
                    "SELECT 1 FROM messages WHERE source = ? AND source_id = ?",
                    (source, str(source_id)),
                ).fetchone()
                if exists:
                    continue

            content = record.get("content") or record.get("text") or record.get("body")
            sent_at = record.get("sent_at") or record.get("timestamp")
            is_from_me = record.get("is_from_me")
            if isinstance(is_from_me, int):
                is_from_me = bool(is_from_me)
            word_count = len(content.split()) if content else 0

            conn.execute(
                "INSERT INTO messages (source, source_id, is_from_me, content, sent_at, word_count) VALUES (?, ?, ?, ?, ?, ?)",
                (source, source_id, is_from_me, content, sent_at, word_count),
            )
            inserted += 1

        elif source == "gmail":
            gmail_id = record.get("gmail_id") or record.get("id") or record.get("message_id")
            if not gmail_id:
                continue
            exists = conn.execute(
                "SELECT 1 FROM gmail_messages WHERE gmail_id = ?", (gmail_id,)
            ).fetchone()
            if exists:
                continue

            conn.execute(
                "INSERT OR IGNORE INTO gmail_messages (gmail_id, thread_id, subject, from_addr, from_name, to_addrs, sent_at, body_text, is_from_me) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    gmail_id,
                    record.get("thread_id", ""),
                    record.get("subject"),
                    record.get("from_addr") or record.get("from"),
                    record.get("from_name"),
                    json.dumps(record.get("to_addrs")) if isinstance(record.get("to_addrs"), list) else record.get("to_addrs"),
                    record.get("sent_at") or record.get("date"),
                    record.get("body_text") or record.get("body") or record.get("content"),
                    record.get("is_from_me"),
                ),
            )
            inserted += 1

    conn.commit()
    conn.close()
    return inserted


def sync_source(datarep_source, db_path, api_key):
    db_source = DATAREP_SOURCE_TO_DB.get(datarep_source, datarep_source)
    label = datarep_source.replace("_", " ").title()

    log.info(f"Starting {label} sync via datarep...")
    run_id = start_run(db_path, db_source)
    count_before = count_messages(db_path, db_source)

    try:
        headers = {"Authorization": f"Bearer {api_key}"}
        resp = httpx.post(
            f"{DATAREP_BASE}/sync",
            json={"source": datarep_source},
            headers=headers,
            timeout=300,
        )
        result = resp.json()

        if result.get("status") == "action_required":
            error = f"Action required: {result.get('explanation', 'unknown')}"
            finish_run(db_path, run_id, 0, None, error=error)
            log.warning(f"  {label}: {error}")
            return 0, None, error

        if result.get("status") != "success":
            error = result.get("detail") or str(result)
            finish_run(db_path, run_id, 0, None, error=error)
            log.error(f"  {label}: {error}")
            return 0, None, error

        raw = result.get("result", "")
        if isinstance(raw, dict):
            raw = json.dumps(raw)

        loaded = load_json_lines(db_path, raw, db_source)
        count_after = count_messages(db_path, db_source)
        messages_added = count_after - count_before

        last_at = None
        conn = sqlite3.connect(str(db_path))
        try:
            if db_source == "gmail":
                row = conn.execute("SELECT MAX(sent_at) FROM gmail_messages").fetchone()
            else:
                row = conn.execute(
                    "SELECT MAX(sent_at) FROM messages WHERE source = ?", (db_source,)
                ).fetchone()
            last_at = row[0] if row else None
        except Exception:
            pass
        finally:
            conn.close()

        finish_run(db_path, run_id, messages_added, last_at)
        log.info(f"  {label}: {messages_added} messages added (loaded {loaded} records)")
        return messages_added, last_at, None

    except Exception as e:
        error = f"{type(e).__name__}: {e}"
        finish_run(db_path, run_id, 0, None, error=error)
        log.error(f"  {label} failed: {error}")
        return 0, None, error


def run_all(db_path=None, api_key=None, sources=None):
    db_path = db_path or DB_PATH
    api_key = api_key or API_KEY
    ensure_sync_runs_table(db_path)

    # Check datarep health
    try:
        resp = httpx.get(f"{DATAREP_BASE}/health", timeout=3)
        if not resp.is_success:
            log.error("datarep is not healthy. Aborting sync.")
            return {}
    except Exception as e:
        log.error(f"datarep is not reachable: {e}. Aborting sync.")
        return {}

    if sources is None:
        datarep_sources = []
        for ps in SELECTED_SOURCES:
            if ps in PROFILE_SOURCE_TO_DATAREP:
                datarep_sources.append(PROFILE_SOURCE_TO_DATAREP[ps])
        if not datarep_sources:
            log.info("No syncable sources configured in profile")
            return {}
    else:
        datarep_sources = sources

    log.info(f"Starting weekly sync via datarep for: {', '.join(datarep_sources)}")
    log.info(f"Database: {db_path}")

    results = {}
    total_added = 0

    for src in datarep_sources:
        added, last, error = sync_source(src, db_path, api_key)
        results[src] = {"added": added, "last": last, "error": error}
        total_added += added

    log.info(f"\nSync complete: {total_added} total messages added")
    for key, result in results.items():
        status = "FAILED" if result["error"] else "OK"
        log.info(f"  {key}: {result['added']} messages [{status}]")

    return results


def main():
    parser = argparse.ArgumentParser(description="Thyself weekly sync via datarep")
    parser.add_argument(
        "--source",
        help="Sync a single datarep source (e.g. imessage, whatsapp_desktop, gmail)",
    )
    args = parser.parse_args()

    sources = [args.source] if args.source else None
    run_all(sources=sources)


if __name__ == "__main__":
    main()
