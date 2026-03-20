#!/usr/bin/env python3
"""
Hourly sync via datarep for Thyself.

Primary path: replays saved datarep recipes via GET /data/{recipe_id},
which streams NDJSON and does NOT require ANTHROPIC_API_KEY.

Fallback: uses legacy Python sync scripts when no recipe exists for a
source (backward-compatible with pre-datarep setups).

Before syncing, seeds datarep's sync_state from thyself.db when datarep
has no cursor yet (legacy users who never ran initial import via datarep).

Environment:
    DATAREP_BASE       Default http://127.0.0.1:7080
    DATAREP_HOME       Default ~/.datarep (for seeding sync_state)

Profile-aware: reads the active profile's data_dir, selected_sources,
and datarep_api_key from the Thyself profile system.

Usage:
    python sync/run_datarep.py                  # Sync all sources
    python sync/run_datarep.py --source gmail    # Sync one source
"""

import argparse
import json
import logging
import os
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

try:
    import httpx
except ImportError:
    print("httpx is required: pip install httpx", file=sys.stderr)
    sys.exit(1)

DATAREP_BASE = os.environ.get("DATAREP_BASE", "http://127.0.0.1:7080")

# Apple Core Data epoch (same as sync/imessage_sync.py)
APPLE_EPOCH = datetime(2001, 1, 1)
NANOSECONDS = 1_000_000_000

PROFILE_SOURCE_TO_DATAREP = {
    "imessage": "imessage",
    "whatsapp": "whatsapp_desktop",
    "whatsapp_web": "whatsapp_web",
    "gmail": "gmail",
    "chatgpt": "chatgpt",
    "email_cantab": "apple_mail",
}

DATAREP_SOURCE_TO_DB = {
    "imessage": "imessage",
    "whatsapp_desktop": "whatsapp",
    "whatsapp_web": "whatsapp",
    "gmail": "gmail",
    "chatgpt": "chatgpt",
    "apple_mail": "apple_mail_v1",
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


def _sent_at_to_apple_ns(sent_at: str) -> int:
    """Convert thyself sent_at ISO string to Apple nanoseconds since 2001-01-01."""
    if not sent_at:
        return 0
    s = sent_at.strip()
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        return 0
    if dt.tzinfo is not None:
        dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
    delta = dt - APPLE_EPOCH
    return int(delta.total_seconds() * NANOSECONDS)


def seed_datarep_sync_state(thyself_db_path: Path, datarep_sources: list, log: logging.Logger) -> None:
    """If thyself has messages but datarep has no sync_state, seed cursor from MAX(sent_at)."""
    datarep_home = Path(os.environ.get("DATAREP_HOME", Path.home() / ".datarep"))
    dr_db = datarep_home / "datarep.db"
    if not dr_db.exists():
        log.warning("datarep DB not found at %s — skip sync_state seed", dr_db)
        return

    conn_thy = sqlite3.connect(str(thyself_db_path))
    conn_dr = sqlite3.connect(str(dr_db))

    try:
        for dr_src in datarep_sources:
            db_src = DATAREP_SOURCE_TO_DB.get(dr_src, dr_src)

            existing = conn_dr.execute(
                "SELECT 1 FROM sync_state WHERE source_name = ? LIMIT 1",
                (dr_src,),
            ).fetchone()
            if existing:
                continue

            recipe_row = conn_dr.execute(
                """SELECT id FROM recipes WHERE source_name = ?
                   ORDER BY COALESCE(last_used_at, created_at) DESC LIMIT 1""",
                (dr_src,),
            ).fetchone()
            if not recipe_row:
                log.info("No datarep recipe for %s — skip sync_state seed", dr_src)
                continue
            recipe_id = recipe_row[0]

            cursor = None
            if db_src == "gmail":
                row = conn_thy.execute(
                    "SELECT MAX(sent_at) FROM gmail_messages"
                ).fetchone()
                if row and row[0]:
                    cursor = row[0]
            else:
                row = conn_thy.execute(
                    "SELECT MAX(sent_at) FROM messages WHERE source = ?",
                    (db_src,),
                ).fetchone()
                if row and row[0]:
                    cursor = _sent_at_to_apple_ns(row[0])

            if cursor is None:
                continue
            if isinstance(cursor, int) and cursor == 0:
                continue
            if isinstance(cursor, str) and not str(cursor).strip():
                continue

            now = datetime.now(timezone.utc).isoformat()
            cursor_str = json.dumps(cursor)
            conn_dr.execute(
                """INSERT OR REPLACE INTO sync_state
                   (source_name, recipe_id, last_cursor, last_status, last_run_at, items_retrieved)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                (dr_src, recipe_id, cursor_str, "seeded_from_thyself", now, 0),
            )
            conn_dr.commit()
            log.info(
                "Seeded datarep sync_state for %s (recipe=%s)",
                dr_src,
                recipe_id,
            )
    except Exception as e:
        log.warning("seed_datarep_sync_state failed: %s", e)
    finally:
        conn_thy.close()
        conn_dr.close()


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

        if source == "gmail":
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

        elif source == "chatgpt":
            msg_id = record.get("message_id") or record.get("id")
            if not msg_id:
                continue
            exists = conn.execute(
                "SELECT 1 FROM chatgpt_messages WHERE message_id = ?", (msg_id,)
            ).fetchone()
            if exists:
                continue

            conn.execute(
                "INSERT OR IGNORE INTO chatgpt_messages (message_id, conversation_id, role, content, sent_at, model) VALUES (?, ?, ?, ?, ?, ?)",
                (
                    msg_id,
                    record.get("conversation_id"),
                    record.get("role"),
                    record.get("content") or record.get("text") or record.get("body"),
                    record.get("sent_at") or record.get("timestamp"),
                    record.get("model"),
                ),
            )
            inserted += 1

        else:
            source_id = (
                record.get("source_message_id")
                or record.get("source_id")
                or record.get("message_id")
                or record.get("id")
                or record.get("guid")
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

    conn.commit()
    conn.close()
    return inserted


LEGACY_SOURCES = {
    "imessage": "imessage_sync",
    "whatsapp_desktop": "whatsapp_desktop_sync",
    "whatsapp_web": "whatsapp_web_sync",
    "gmail": "gmail_sync",
    "chatgpt": "chatgpt_sync",
    "apple_mail": "apple_mail_sync",
}


def _sync_legacy(datarep_source, db_path):
    """Sync via legacy script when no datarep recipe exists."""
    module_file = LEGACY_SOURCES[datarep_source]
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        module_file,
        Path(__file__).parent / f"{module_file}.py",
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    messages_added, last_message_at = mod.sync(thyself_db_path=db_path)
    return messages_added, last_message_at


def _get_latest_recipe(datarep_source, api_key):
    """Find the most recent datarep recipe for a source, or None."""
    headers = {"Authorization": f"Bearer {api_key}"}
    try:
        resp = httpx.get(
            f"{DATAREP_BASE}/recipes",
            params={"source": datarep_source},
            headers=headers,
            timeout=10,
        )
        if not resp.is_success:
            return None
        recipes = resp.json().get("recipes", [])
        return recipes[0] if recipes else None
    except Exception:
        return None


def _sync_via_recipe(recipe_id, db_path, db_source, api_key):
    """Stream NDJSON from GET /data/{recipe_id} and load into thyself.db."""
    headers = {"Authorization": f"Bearer {api_key}"}
    count_before = count_messages(db_path, db_source)
    all_lines = []

    with httpx.stream(
        "GET",
        f"{DATAREP_BASE}/data/{recipe_id}",
        headers=headers,
        timeout=600,
    ) as resp:
        resp.raise_for_status()
        line_buffer = ""
        for chunk in resp.iter_text():
            line_buffer += chunk
            while "\n" in line_buffer:
                line, line_buffer = line_buffer.split("\n", 1)
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if obj.get("_stream_complete"):
                    continue
                all_lines.append(line)
        remaining = line_buffer.strip()
        if remaining:
            try:
                obj = json.loads(remaining)
                if not obj.get("_stream_complete"):
                    all_lines.append(remaining)
            except json.JSONDecodeError:
                all_lines.append(remaining)

    json_text = "\n".join(all_lines)
    loaded = load_json_lines(db_path, json_text, db_source)
    count_after = count_messages(db_path, db_source)
    messages_added = count_after - count_before
    if messages_added == 0 and loaded > 0:
        messages_added = loaded
    return messages_added


def _get_last_message_at(db_path, db_source):
    conn = sqlite3.connect(str(db_path))
    try:
        if db_source == "gmail":
            row = conn.execute("SELECT MAX(sent_at) FROM gmail_messages").fetchone()
        elif db_source == "chatgpt":
            row = conn.execute("SELECT MAX(sent_at) FROM chatgpt_messages").fetchone()
        else:
            row = conn.execute(
                "SELECT MAX(sent_at) FROM messages WHERE source = ?", (db_source,)
            ).fetchone()
        return row[0] if row else None
    except Exception:
        return None
    finally:
        conn.close()


def sync_source(datarep_source, db_path, api_key):
    db_source = DATAREP_SOURCE_TO_DB.get(datarep_source, datarep_source)
    label = datarep_source.replace("_", " ").title()

    recipe = _get_latest_recipe(datarep_source, api_key)

    if recipe:
        recipe_id = recipe.get("id") or recipe.get("recipe_id")
        log.info(f"Starting {label} sync via recipe replay ({recipe_id})...")
        run_id = start_run(db_path, db_source)
        try:
            added = _sync_via_recipe(recipe_id, db_path, db_source, api_key)
            last_at = _get_last_message_at(db_path, db_source)
            finish_run(db_path, run_id, added, last_at)
            log.info(f"  {label}: {added} messages added (last: {last_at})")
            return added, last_at, None
        except Exception as e:
            error = f"{type(e).__name__}: {e}"
            finish_run(db_path, run_id, 0, None, error=error)
            log.error(f"  {label} recipe replay failed: {error}")
            return 0, None, error

    if datarep_source in LEGACY_SOURCES:
        log.info(f"No recipe for {label} — falling back to legacy script...")
        run_id = start_run(db_path, db_source)
        try:
            added, last_at = _sync_legacy(datarep_source, db_path)
            finish_run(db_path, run_id, added, last_at)
            log.info(f"  {label}: {added} messages added (last: {last_at})")
            return added, last_at, None
        except Exception as e:
            error = f"{type(e).__name__}: {e}"
            finish_run(db_path, run_id, 0, None, error=error)
            log.error(f"  {label} legacy sync failed: {error}")
            return 0, None, error

    log.warning(f"  {label}: no recipe and no legacy script — skipping")
    return 0, None, "No recipe or legacy script available"


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

    log.info(f"Starting sync via datarep for: {', '.join(datarep_sources)}")
    log.info(f"Database: {db_path}")

    seed_datarep_sync_state(Path(db_path), datarep_sources, log)

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
    parser = argparse.ArgumentParser(description="Thyself sync via datarep")
    parser.add_argument(
        "--source",
        help="Sync a single datarep source (e.g. imessage, whatsapp_desktop, gmail)",
    )
    args = parser.parse_args()

    sources = [args.source] if args.source else None
    run_all(sources=sources)


if __name__ == "__main__":
    main()
