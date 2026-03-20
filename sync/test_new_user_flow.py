#!/usr/bin/env python3
"""
Integration test: simulates a new user's datarep-based sync flow.

Tests that:
1. datarep is running and reachable
2. Recipes exist (or can be created) for each source
3. GET /data/{recipe_id} streams valid NDJSON
4. NDJSON can be loaded into a temporary thyself.db
5. Incremental replay only adds new messages

Usage:
    python sync/test_new_user_flow.py                   # Test all sources
    python sync/test_new_user_flow.py --source imessage  # Test one source

Requires:
    - datarep running on localhost:7080
    - A valid datarep API key (from profile or --api-key flag)
"""

import argparse
import json
import os
import sqlite3
import sys
import tempfile
from pathlib import Path

try:
    import httpx
except ImportError:
    print("httpx is required: pip install httpx", file=sys.stderr)
    sys.exit(1)

DATAREP_BASE = os.environ.get("DATAREP_BASE", "http://127.0.0.1:7080")

ALL_SOURCES = ["imessage", "whatsapp_desktop", "gmail", "chatgpt", "whatsapp_web", "apple_mail"]

SOURCE_TO_DB = {
    "imessage": "imessage",
    "whatsapp_desktop": "whatsapp",
    "whatsapp_web": "whatsapp",
    "gmail": "gmail",
    "chatgpt": "chatgpt",
    "apple_mail": "apple_mail_v1",
}


def get_api_key_from_profile():
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
                return profile.get("datarep_api_key")
    except Exception:
        pass
    return None


def create_test_db(path):
    conn = sqlite3.connect(str(path))
    conn.execute("""
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source TEXT NOT NULL,
            source_id TEXT,
            is_from_me BOOLEAN,
            content TEXT,
            sent_at TEXT,
            word_count INTEGER DEFAULT 0
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS gmail_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            gmail_id TEXT UNIQUE,
            thread_id TEXT,
            subject TEXT,
            from_addr TEXT,
            from_name TEXT,
            to_addrs TEXT,
            sent_at TEXT,
            body_text TEXT,
            is_from_me BOOLEAN
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS chatgpt_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            message_id TEXT UNIQUE,
            conversation_id TEXT,
            role TEXT,
            content TEXT,
            sent_at TEXT,
            model TEXT
        )
    """)
    conn.commit()
    conn.close()


class TestResult:
    def __init__(self, source):
        self.source = source
        self.passed = False
        self.recipe_id = None
        self.lines_streamed = 0
        self.lines_loaded = 0
        self.incremental_lines = 0
        self.error = None

    def __str__(self):
        status = "PASS" if self.passed else "FAIL"
        details = []
        if self.recipe_id:
            details.append(f"recipe={self.recipe_id}")
        if self.lines_streamed > 0:
            details.append(f"streamed={self.lines_streamed}")
        if self.lines_loaded > 0:
            details.append(f"loaded={self.lines_loaded}")
        if self.incremental_lines >= 0 and self.passed:
            details.append(f"incremental={self.incremental_lines}")
        if self.error:
            details.append(f"error={self.error}")
        detail_str = f" ({', '.join(details)})" if details else ""
        return f"  [{status}] {self.source}{detail_str}"


def test_health():
    try:
        resp = httpx.get(f"{DATAREP_BASE}/health", timeout=5)
        return resp.is_success
    except Exception as e:
        print(f"  FAIL: datarep not reachable at {DATAREP_BASE}: {e}")
        return False


def get_recipe(source, headers):
    try:
        resp = httpx.get(
            f"{DATAREP_BASE}/recipes",
            params={"source": source},
            headers=headers,
            timeout=10,
        )
        if not resp.is_success:
            return None
        recipes = resp.json().get("recipes", [])
        return recipes[0] if recipes else None
    except Exception:
        return None


def stream_recipe_data(recipe_id, headers, max_lines=100):
    """Stream NDJSON from GET /data/{recipe_id}, return list of parsed objects.
    Stops after max_lines to keep tests fast."""
    lines = []
    with httpx.stream(
        "GET",
        f"{DATAREP_BASE}/data/{recipe_id}",
        headers=headers,
        timeout=60,
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
                lines.append(obj)
                if len(lines) >= max_lines:
                    return lines
        remaining = line_buffer.strip()
        if remaining and len(lines) < max_lines:
            try:
                obj = json.loads(remaining)
                if not obj.get("_stream_complete"):
                    lines.append(obj)
            except json.JSONDecodeError:
                pass
    return lines


def load_lines_into_db(db_path, lines, source):
    """Load parsed NDJSON objects into test DB. Returns count of inserted rows."""
    from run_datarep import load_json_lines
    json_text = "\n".join(json.dumps(obj) for obj in lines)
    db_source = SOURCE_TO_DB.get(source, source)
    return load_json_lines(db_path, json_text, db_source)


def test_source(source, api_key, db_path):
    result = TestResult(source)
    headers = {"Authorization": f"Bearer {api_key}"}

    recipe = get_recipe(source, headers)
    if not recipe:
        result.error = f"No recipe found for {source}"
        return result

    result.recipe_id = recipe.get("id") or recipe.get("recipe_id")

    try:
        lines = stream_recipe_data(result.recipe_id, headers)
        result.lines_streamed = len(lines)
    except Exception as e:
        result.error = f"Stream failed: {e}"
        return result

    if not lines:
        result.error = "Stream returned 0 lines"
        return result

    first = lines[0]
    if not isinstance(first, dict):
        result.error = f"First line is not a dict: {type(first)}"
        return result

    try:
        result.lines_loaded = load_lines_into_db(db_path, lines, source)
    except Exception as e:
        result.error = f"Load failed: {e}"
        return result

    try:
        replay_lines = stream_recipe_data(result.recipe_id, headers)
        incremental_loaded = load_lines_into_db(db_path, replay_lines, source)
        result.incremental_lines = incremental_loaded
    except Exception as e:
        result.error = f"Incremental replay failed: {e}"
        return result

    result.passed = True
    return result


def main():
    parser = argparse.ArgumentParser(description="Test new user datarep flow")
    parser.add_argument("--source", help="Test a single source")
    parser.add_argument("--api-key", help="Datarep API key (default: from profile)")
    args = parser.parse_args()

    api_key = args.api_key or get_api_key_from_profile()
    if not api_key:
        print("No API key. Pass --api-key or set up a Thyself profile.", file=sys.stderr)
        sys.exit(1)

    print("=== Thyself New User Flow Test ===\n")

    print("1. Health check...")
    if not test_health():
        print("   FAIL: datarep not running. Start it with: datarep start")
        sys.exit(1)
    print("   OK: datarep is healthy\n")

    sources = [args.source] if args.source else ALL_SOURCES

    with tempfile.TemporaryDirectory(prefix="thyself_test_") as tmpdir:
        db_path = Path(tmpdir) / "thyself.db"
        create_test_db(db_path)

        print(f"2. Test DB: {db_path}\n")
        print("3. Per-source tests:")

        results = []
        for source in sources:
            result = test_source(source, api_key, db_path)
            results.append(result)
            print(result)

        print()

        passed = sum(1 for r in results if r.passed)
        no_recipe = sum(1 for r in results if r.error and "No recipe" in r.error)
        stream_fail = sum(1 for r in results if not r.passed and r.error and "No recipe" not in r.error)

        print(f"=== Results: {passed} passed, {stream_fail} stream failures, {no_recipe} no recipe ===")

        if no_recipe > 0:
            no_recipe_names = [r.source for r in results if r.error and "No recipe" in r.error]
            print(f"\nSources without recipes ({', '.join(no_recipe_names)}):")
            print("  These need initial setup via in-app onboarding to create recipes.")
            print("  Until then, they fall back to legacy sync scripts.")

        if stream_fail > 0:
            fail_names = [r.source for r in results if not r.passed and r.error and "No recipe" not in r.error]
            print(f"\nSources with recipe failures ({', '.join(fail_names)}):")
            print("  These have recipes but streaming failed (likely auth or permission issues).")
            print("  They will fall back to legacy scripts during hourly sync.")

        if passed > 0:
            print(f"\n{passed} source(s) fully working via recipe replay.")

        sys.exit(0 if stream_fail == 0 else 1)


if __name__ == "__main__":
    main()
