"""
Incremental ChatGPT sync via Safari JavaScript injection.

Calls ChatGPT's internal backend API from within the active Safari tab
(bypassing Cloudflare) to fetch new conversations and messages, then
inserts them into thyself.db.

Prerequisites:
  - Safari open with chatgpt.com logged in
  - Safari → Settings → Developer → "Allow JavaScript from Apple Events"
"""

import json
import logging
import re
import sqlite3
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path

import sys
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from config import DB_PATH

log = logging.getLogger("thyself.sync")

BATCH_SIZE = 28
MAX_CONVERSATIONS = 500


def run_applescript(script: str) -> str:
    result = subprocess.run(
        ["osascript", "-e", script],
        capture_output=True, text=True, timeout=60,
    )
    if result.returncode != 0:
        raise RuntimeError(f"AppleScript error: {result.stderr.strip()}")
    return result.stdout.strip()


def find_chatgpt_tab() -> tuple[int, int]:
    script = '''
    tell application "Safari"
        repeat with w from 1 to count of windows
            repeat with t from 1 to count of tabs of window w
                if URL of tab t of window w contains "chatgpt.com" then
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
            "No ChatGPT tab found in Safari. "
            "Open chatgpt.com and log in first."
        )
    parts = result.split(",")
    return int(parts[0]), int(parts[1])


def safari_js(window_idx: int, tab_idx: int, js_code: str) -> str:
    escaped = js_code.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")
    script = f'''
    tell application "Safari"
        do JavaScript "{escaped}" in tab {tab_idx} of window {window_idx}
    end tell
    '''
    return run_applescript(script)


def get_access_token(window_idx: int, tab_idx: int) -> str:
    js = """
    (function() {
        var xhr = new XMLHttpRequest();
        xhr.open("GET", "/api/auth/session", false);
        xhr.withCredentials = true;
        xhr.send();
        try { return JSON.parse(xhr.responseText).accessToken; }
        catch(e) { return "ERROR:" + e.message; }
    })()
    """
    token = safari_js(window_idx, tab_idx, js)
    if not token or token.startswith("ERROR:"):
        raise RuntimeError(f"Failed to get ChatGPT access token: {token}")
    return token


def api_call(window_idx: int, tab_idx: int, token: str, endpoint: str) -> dict:
    """Call ChatGPT backend API from within Safari and return parsed JSON."""
    js = f"""
    (function() {{
        var xhr = new XMLHttpRequest();
        xhr.open("GET", "{endpoint}", false);
        xhr.setRequestHeader("Authorization", "Bearer " + "{token}");
        xhr.send();
        if (xhr.status !== 200) return JSON.stringify({{"error": xhr.status, "body": xhr.responseText.substring(0, 200)}});
        return xhr.responseText;
    }})()
    """
    raw = safari_js(window_idx, tab_idx, js)
    if not raw:
        raise RuntimeError(f"Empty response from {endpoint}")
    return json.loads(raw)


def api_call_chunked(window_idx: int, tab_idx: int, token: str, endpoint: str) -> dict:
    """Call API and read result in chunks to avoid AppleScript string limits."""
    store_js = f"""
    (function() {{
        var xhr = new XMLHttpRequest();
        xhr.open("GET", "{endpoint}", false);
        xhr.setRequestHeader("Authorization", "Bearer " + "{token}");
        xhr.send();
        if (xhr.status !== 200) {{
            window._thyself_chatgpt = JSON.stringify({{"error": xhr.status}});
        }} else {{
            window._thyself_chatgpt = xhr.responseText;
        }}
        return String(window._thyself_chatgpt.length);
    }})()
    """
    length_str = safari_js(window_idx, tab_idx, store_js)
    if not length_str:
        raise RuntimeError(f"Empty length response from {endpoint}")
    total_len = int(length_str)

    if total_len < 60000:
        raw = safari_js(window_idx, tab_idx, "window._thyself_chatgpt")
        return json.loads(raw)

    chunks = []
    chunk_size = 50000
    for offset in range(0, total_len, chunk_size):
        chunk = safari_js(
            window_idx, tab_idx,
            f"window._thyself_chatgpt.substring({offset}, {offset + chunk_size})"
        )
        chunks.append(chunk)

    full = "".join(chunks)
    safari_js(window_idx, tab_idx, "delete window._thyself_chatgpt")
    return json.loads(full)


def list_conversations(window_idx, tab_idx, token, offset=0, limit=BATCH_SIZE):
    endpoint = f"/backend-api/conversations?offset={offset}&limit={limit}&order=updated"
    return api_call(window_idx, tab_idx, token, endpoint)


def get_conversation(window_idx, tab_idx, token, conv_id):
    endpoint = f"/backend-api/conversation/{conv_id}"
    return api_call_chunked(window_idx, tab_idx, token, endpoint)


def extract_text(content: dict) -> str | None:
    if not content:
        return None
    parts = content.get("parts", [])
    text_parts = []
    for p in parts:
        if isinstance(p, str):
            text_parts.append(p)
        elif isinstance(p, dict) and p.get("content_type") == "image_asset_pointer":
            text_parts.append("[image]")
    combined = "\n".join(text_parts).strip()
    return combined if combined else None


def linearize_messages(mapping: dict) -> list[dict]:
    root_id = None
    for nid, node in mapping.items():
        if node.get("parent") is None:
            root_id = nid
            break
    if root_id is None:
        return []

    messages = []
    current_id = root_id
    while current_id:
        node = mapping.get(current_id)
        if not node:
            break
        msg = node.get("message")
        if msg:
            content = msg.get("content", {})
            ct = content.get("content_type", "")
            text = extract_text(content) if ct in ("text", "multimodal_text") else None
            role = msg.get("author", {}).get("role", "unknown")
            messages.append({
                "id": msg.get("id", current_id),
                "parent_id": node.get("parent"),
                "role": role,
                "content_type": ct,
                "text": text,
                "model_slug": msg.get("metadata", {}).get("model_slug"),
                "status": msg.get("status"),
                "create_time": msg.get("create_time"),
                "update_time": msg.get("update_time"),
                "weight": msg.get("weight"),
            })
        children = node.get("children", [])
        current_id = children[-1] if children else None

    return messages


def get_last_synced_time(conn: sqlite3.Connection) -> float:
    row = conn.execute(
        "SELECT MAX(create_time) FROM chatgpt_messages WHERE create_time IS NOT NULL"
    ).fetchone()
    return row[0] if row and row[0] else 0


def sync(thyself_db_path=None):
    db_path = str(thyself_db_path or DB_PATH)
    window_idx, tab_idx = find_chatgpt_tab()
    log.info("  ChatGPT: found tab in Safari (window %d, tab %d)", window_idx, tab_idx)

    token = get_access_token(window_idx, tab_idx)
    log.info("  ChatGPT: got access token (%d chars)", len(token))

    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA journal_mode=WAL")

    last_sync_time = get_last_synced_time(conn)
    log.info("  ChatGPT: last synced message create_time: %s",
             datetime.fromtimestamp(last_sync_time, tz=timezone.utc).isoformat() if last_sync_time else "never")

    new_conv_ids = []
    offset = 0
    done = False
    while not done and offset < MAX_CONVERSATIONS:
        batch = list_conversations(window_idx, tab_idx, token, offset=offset, limit=BATCH_SIZE)
        items = batch.get("items", [])
        if not items:
            break

        for item in items:
            update_time = item.get("update_time")
            if isinstance(update_time, str):
                try:
                    ut = datetime.fromisoformat(update_time.replace("Z", "+00:00")).timestamp()
                except ValueError:
                    ut = 0
            else:
                ut = update_time or 0

            if ut <= last_sync_time:
                done = True
                break
            new_conv_ids.append(item["id"])

        offset += len(items)
        if len(items) < BATCH_SIZE:
            break

    log.info("  ChatGPT: %d conversations updated since last sync", len(new_conv_ids))

    if not new_conv_ids:
        conn.close()
        return 0, None

    total_added = 0
    last_message_at = None

    for i, conv_id in enumerate(new_conv_ids):
        try:
            conv_data = get_conversation(window_idx, tab_idx, token, conv_id)
        except Exception as e:
            log.warning("  ChatGPT: failed to fetch conversation %s: %s", conv_id, e)
            continue

        if "error" in conv_data:
            log.warning("  ChatGPT: API error for %s: %s", conv_id, conv_data["error"])
            continue

        mapping = conv_data.get("mapping", {})
        messages = linearize_messages(mapping)
        storable = [
            m for m in messages
            if m["role"] in ("user", "assistant", "system")
            and (m["text"] is not None or m["role"] == "system")
        ]

        if not storable:
            continue

        model_slugs = [m["model_slug"] for m in storable if m.get("model_slug")]
        primary_model = model_slugs[-1] if model_slugs else None

        conn.execute(
            """INSERT OR REPLACE INTO chatgpt_conversations
               (id, title, create_time, update_time, model_slug,
                gizmo_id, is_archived, message_count)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                conv_id,
                conv_data.get("title"),
                conv_data.get("create_time"),
                conv_data.get("update_time"),
                primary_model,
                conv_data.get("gizmo_id"),
                1 if conv_data.get("is_archived") else 0,
                len(storable),
            ),
        )

        conv_added = 0
        for pos, msg in enumerate(storable):
            existing = conn.execute(
                "SELECT 1 FROM chatgpt_messages WHERE id = ?", (msg["id"],)
            ).fetchone()
            if existing:
                continue

            conn.execute(
                """INSERT OR IGNORE INTO chatgpt_messages
                   (id, conversation_id, parent_id, role, content_type,
                    text, model_slug, status, create_time, update_time,
                    position, weight)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    msg["id"], conv_id, msg["parent_id"], msg["role"],
                    msg["content_type"], msg["text"], msg["model_slug"],
                    msg["status"], msg["create_time"], msg["update_time"],
                    pos, msg["weight"],
                ),
            )
            conv_added += 1

            if msg["create_time"]:
                ts = datetime.fromtimestamp(msg["create_time"], tz=timezone.utc)
                iso = ts.strftime("%Y-%m-%dT%H:%M:%S")
                if last_message_at is None or iso > last_message_at:
                    last_message_at = iso

        total_added += conv_added
        if (i + 1) % 10 == 0:
            conn.commit()
            log.info("  ChatGPT: processed %d/%d conversations (%d messages so far)",
                     i + 1, len(new_conv_ids), total_added)

    conn.commit()
    conn.close()

    log.info("  ChatGPT: sync complete — %d new messages from %d conversations",
             total_added, len(new_conv_ids))
    return total_added, last_message_at


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
    count, last = sync()
    print(f"ChatGPT sync complete: {count} messages added, last at {last}")
