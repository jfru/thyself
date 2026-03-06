"""
WhatsApp Web sync for the UK number via Safari JavaScript injection.

Injects JavaScript into the active WhatsApp Web Safari tab using AppleScript,
reads decrypted messages via WhatsApp's internal module system, and imports
them into thyself.db.

Prerequisites:
  - Safari → Settings → Developer → "Allow JavaScript from Apple Events" enabled
  - Safari open with WhatsApp Web logged in
"""

import json
import os
import re
import sqlite3
import subprocess
import tempfile
import time
from datetime import datetime, timedelta
from pathlib import Path

import sys
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from config import DB_PATH

JS_PAYLOAD_PATH = Path(__file__).parent / "whatsapp_web_extract.js"
SOURCE_PREFIX = "waw"


def normalize_phone(phone):
    if not phone:
        return None
    digits = re.sub(r"[^\d+]", "", phone)
    if not digits.startswith("+"):
        digits = f"+{digits}"
    return digits


def jid_to_phone(jid):
    if not jid or "@" not in jid:
        return None
    number = jid.split("@")[0]
    if "-" in number:
        return None
    if number.isdigit():
        return f"+{number}"
    return None


def run_applescript(script):
    """Run an AppleScript and return its stdout."""
    result = subprocess.run(
        ["osascript", "-e", script],
        capture_output=True, text=True, timeout=60,
    )
    if result.returncode != 0:
        raise RuntimeError(f"AppleScript error: {result.stderr.strip()}")
    return result.stdout.strip()


def find_whatsapp_tab():
    """Find the WhatsApp Web tab index in Safari, returns (window, tab) or raises."""
    script = '''
    tell application "Safari"
        repeat with w from 1 to count of windows
            repeat with t from 1 to count of tabs of window w
                if URL of tab t of window w contains "whatsapp" then
                    return (w as text) & "," & (t as text)
                end if
            end repeat
        end repeat
        return "not_found"
    end tell
    '''
    result = run_applescript(script)
    if result == "not_found":
        raise RuntimeError(
            "No WhatsApp Web tab found in Safari. "
            "Ensure Safari is open with web.whatsapp.com."
        )
    parts = result.split(",")
    return int(parts[0]), int(parts[1])


def inject_js(window_idx, tab_idx, js_code):
    """Inject JavaScript into a Safari tab and return the result."""
    escaped = js_code.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")
    script = f'''
    tell application "Safari"
        do JavaScript "{escaped}" in tab {tab_idx} of window {window_idx}
    end tell
    '''
    return run_applescript(script)


def poll_result(window_idx, tab_idx, timeout=30, interval=2):
    """Poll window._thyself until it's no longer 'working'."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        time.sleep(interval)
        result = inject_js(window_idx, tab_idx, "window._thyself")
        if result and result != "working":
            return result
    raise TimeoutError("Timed out waiting for WhatsApp Web extraction")


def read_messages_in_batches(window_idx, tab_idx, total, batch_size=50):
    """Read messages from window._thyselfMessages in batches to avoid AppleScript size limits."""
    all_messages = []
    for offset in range(0, total, batch_size):
        js = f"JSON.stringify(window._thyselfMessages.slice({offset}, {offset + batch_size}))"
        raw = inject_js(window_idx, tab_idx, js)
        try:
            batch = json.loads(raw)
            all_messages.extend(batch)
        except json.JSONDecodeError:
            print(f"  Warning: failed to parse batch at offset {offset}")
    return all_messages


def extract_messages_from_safari(cutoff_ts):
    """Inject JS into Safari WhatsApp Web tab and extract messages."""
    window_idx, tab_idx = find_whatsapp_tab()

    title = inject_js(window_idx, tab_idx, "document.title")
    if "WhatsApp" not in title:
        raise RuntimeError(f"Tab doesn't appear to be WhatsApp Web (title: {title})")

    js_payload = JS_PAYLOAD_PATH.read_text()
    js_payload = js_payload.replace("__CUTOFF_TS__", str(int(cutoff_ts)))

    inject_js(window_idx, tab_idx, js_payload)

    raw = poll_result(window_idx, tab_idx, timeout=120, interval=3)

    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        raise RuntimeError(f"Invalid JSON response from WhatsApp Web: {raw[:200]}")

    if data.get("status") == "error":
        raise RuntimeError(f"WhatsApp Web extraction error: {data.get('error')}")

    total = data.get("count", 0)
    if total == 0:
        return []

    return read_messages_in_batches(window_idx, tab_idx, total)


def load_contact_map(thyself_conn):
    phone_map = {}
    cur = thyself_conn.execute(
        "SELECT id, phone, whatsapp_jid FROM contacts WHERE phone IS NOT NULL AND phone != ''"
    )
    for cid, phone, jid in cur.fetchall():
        normalized = normalize_phone(phone)
        if normalized:
            phone_map[normalized] = cid
        if jid:
            phone_map[jid] = cid
    return phone_map


def load_conversation_map(thyself_conn):
    cur = thyself_conn.execute(
        "SELECT id, source_id FROM conversations WHERE source = 'whatsapp'"
    )
    return {row[1]: row[0] for row in cur.fetchall()}


def get_last_synced_timestamp(thyself_conn):
    """Get the most recent WhatsApp Web message timestamp as Unix seconds."""
    row = thyself_conn.execute(
        "SELECT MAX(sent_at) FROM messages WHERE source = 'whatsapp' AND source_id LIKE ?",
        (f"{SOURCE_PREFIX}_%",),
    ).fetchone()
    if row[0] is None:
        return 0
    try:
        dt = datetime.fromisoformat(row[0])
        return int(dt.timestamp())
    except (ValueError, TypeError):
        return 0


def sync(thyself_db_path=None):
    """Run WhatsApp Web sync via Safari. Returns (messages_added, last_message_at)."""
    db_path = str(thyself_db_path or DB_PATH)

    thyself = sqlite3.connect(db_path)
    thyself.execute("PRAGMA journal_mode=WAL")

    last_ts = get_last_synced_timestamp(thyself)
    # Overlap by 1 hour
    cutoff_ts = max(0, last_ts - 3600)

    messages = extract_messages_from_safari(cutoff_ts)

    if not messages:
        thyself.close()
        return 0, None

    contact_map = load_contact_map(thyself)
    conv_map = load_conversation_map(thyself)

    added = 0
    last_message_at = None

    for msg in messages:
        msg_id = msg.get("id")
        if not msg_id:
            continue

        source_id = f"{SOURCE_PREFIX}_{msg_id}"

        existing = thyself.execute(
            "SELECT 1 FROM messages WHERE source_id = ? AND source = 'whatsapp'",
            (source_id,),
        ).fetchone()
        if existing:
            continue

        chat_jid = msg.get("chat", "")
        conv_source_id = f"{SOURCE_PREFIX}_{chat_jid}"
        is_group = msg.get("isGroup", False)
        chat_name = msg.get("chatName")

        if conv_source_id in conv_map:
            conv_id = conv_map[conv_source_id]
        else:
            cur = thyself.execute(
                """INSERT INTO conversations (source, source_id, is_group, group_name)
                   VALUES ('whatsapp', ?, ?, ?)""",
                (conv_source_id, is_group, chat_name if is_group else None),
            )
            conv_id = cur.lastrowid
            conv_map[conv_source_id] = conv_id

        contact_id = None
        if not msg.get("fromMe", False):
            from_jid = msg.get("from", "")
            phone = jid_to_phone(from_jid)
            if phone:
                normalized = normalize_phone(phone)
                if normalized:
                    contact_id = contact_map.get(normalized)
            if contact_id is None and from_jid:
                contact_id = contact_map.get(from_jid)

        timestamp = msg.get("timestamp", 0)
        sent_at = datetime.utcfromtimestamp(timestamp).strftime("%Y-%m-%dT%H:%M:%S") if timestamp else None
        body = msg.get("body", "")
        wc = len(body.split()) if body else 0

        thyself.execute(
            """INSERT OR IGNORE INTO messages
               (conversation_id, contact_id, source, source_id, is_from_me,
                content, content_type, sent_at, word_count, has_attachment)
               VALUES (?, ?, 'whatsapp', ?, ?, ?, 'text', ?, ?, 0)""",
            (conv_id, contact_id, source_id, msg.get("fromMe", False),
             body, sent_at, wc),
        )
        added += 1
        if sent_at:
            last_message_at = sent_at

    thyself.commit()
    thyself.close()

    return added, last_message_at


if __name__ == "__main__":
    count, last = sync()
    print(f"WhatsApp Web sync complete: {count} messages added, last at {last}")
