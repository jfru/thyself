"""
Incremental iMessage sync from ~/Library/Messages/chat.db.

Reads new messages since the last sync timestamp, maps handles to existing
contacts, and inserts into the messages table with source='imessage'.

Requires Full Disk Access for the running process.
"""

import os
import re
import shutil
import sqlite3
import tempfile
from datetime import datetime, timedelta
from pathlib import Path

import sys
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from config import DB_PATH

IMESSAGE_DB = os.path.expanduser("~/Library/Messages/chat.db")
APPLE_EPOCH = datetime(2001, 1, 1)
NANOSECONDS = 1_000_000_000


def apple_ns_to_iso(ns):
    """Convert Apple Core Data nanosecond timestamp to ISO datetime string."""
    if ns is None or ns == 0:
        return None
    try:
        dt = APPLE_EPOCH + timedelta(seconds=ns / NANOSECONDS)
        return dt.strftime("%Y-%m-%dT%H:%M:%S")
    except (ValueError, OverflowError):
        return None


def apple_ns_to_seconds(ns):
    """Convert Apple nanosecond timestamp to seconds since Apple epoch."""
    if ns is None or ns == 0:
        return 0
    return ns / NANOSECONDS


def extract_text_from_attributed_body(blob):
    """Extract plain text from iMessage attributedBody (NSTypedStream) blob.

    On modern macOS, the `text` column is often NULL and the actual message
    content lives in `attributedBody` as an NSKeyedArchiver-encoded
    NSAttributedString. The raw text follows the \\x01+ marker with a
    variable-length integer prefix.
    """
    if not blob:
        return None
    try:
        marker = b'\x01+'
        idx = blob.find(marker)
        if idx < 0:
            return None
        idx += len(marker)
        length = blob[idx]
        idx += 1
        if length == 0x81:
            length = int.from_bytes(blob[idx:idx+2], 'big')
            idx += 2
        elif length == 0x82:
            length = int.from_bytes(blob[idx:idx+3], 'big')
            idx += 3
        text_bytes = blob[idx:idx + length]
        return text_bytes.decode('utf-8', errors='ignore').strip() or None
    except (IndexError, ValueError):
        return None


def normalize_phone(phone):
    """Normalize a phone number for matching against contacts."""
    if not phone:
        return None
    digits = re.sub(r"[^\d+]", "", phone)
    if not digits.startswith("+"):
        digits = f"+{digits}"
    return digits


def load_contact_map(thyself_conn):
    """Build phone/email → contact_id lookup from existing contacts."""
    phone_map = {}
    cur = thyself_conn.execute(
        "SELECT id, phone, email, imessage_handle FROM contacts"
    )
    for cid, phone, email, handle in cur.fetchall():
        if phone:
            normalized = normalize_phone(phone)
            if normalized:
                phone_map[normalized] = cid
        if email:
            phone_map[email.lower().strip()] = cid
        if handle:
            phone_map[handle.lower().strip()] = cid
    return phone_map


def load_conversation_map(thyself_conn):
    """Build source_id → conversation_id for existing iMessage conversations."""
    cur = thyself_conn.execute(
        "SELECT id, source_id FROM conversations WHERE source = 'imessage'"
    )
    return {row[1]: row[0] for row in cur.fetchall()}


def get_last_synced_timestamp(thyself_conn):
    """Get the most recent iMessage timestamp as Apple nanoseconds."""
    row = thyself_conn.execute(
        "SELECT MAX(sent_at) FROM messages WHERE source = 'imessage'"
    ).fetchone()
    if row[0] is None:
        return 0
    try:
        dt = datetime.fromisoformat(row[0])
        delta = dt - APPLE_EPOCH
        return int(delta.total_seconds() * NANOSECONDS)
    except (ValueError, TypeError):
        return 0


def sync(thyself_db_path=None, initial_sync=False):
    """Run iMessage sync. Returns (messages_added, last_message_at).

    initial_sync=True imports ALL messages (cutoff=0).
    initial_sync=False imports only new messages since the last sync.
    """
    db_path = str(thyself_db_path or DB_PATH)

    if not os.path.exists(IMESSAGE_DB):
        raise FileNotFoundError(
            f"iMessage database not found at {IMESSAGE_DB}. "
            "Ensure Full Disk Access is granted."
        )

    thyself = sqlite3.connect(db_path)
    thyself.execute("PRAGMA journal_mode=WAL")

    # Copy chat.db to a temp file to bypass macOS TCC/FDA restrictions.
    # The Thyself app has FDA but python3 may not — opening the original
    # file directly can silently return empty results on macOS.
    tmp_db = os.path.join(tempfile.gettempdir(), "thyself_chat.db")
    for suffix in ("", "-wal", "-shm"):
        try:
            os.remove(tmp_db + suffix)
        except FileNotFoundError:
            pass
    try:
        shutil.copy2(IMESSAGE_DB, tmp_db)
    except PermissionError:
        # Fallback: try cp command (may have different TCC permissions)
        import subprocess
        result = subprocess.run(["cp", IMESSAGE_DB, tmp_db], capture_output=True)
        if result.returncode != 0:
            python_bin = sys.executable
            raise PermissionError(
                f"Full Disk Access required. Grant FDA to: {python_bin}\n"
                "System Settings → Privacy & Security → Full Disk Access → add the Python binary"
            )

    try:
        imsg = sqlite3.connect(tmp_db)
        imsg.execute("PRAGMA query_only = ON")
        msg_count = imsg.execute("SELECT count(*) FROM message").fetchone()[0]
        print(f"  iMessage: opened database copy, {msg_count:,} messages available")
        if msg_count == 0:
            raise PermissionError(
                "iMessage database opened but contains 0 messages — likely a TCC/FDA issue. "
                f"Grant Full Disk Access to: {sys.executable}"
            )
    except sqlite3.DatabaseError as e:
        if "authorization" in str(e).lower():
            python_bin = sys.executable
            raise PermissionError(
                f"Full Disk Access required. Grant FDA to: {python_bin}\n"
                "System Settings → Privacy & Security → Full Disk Access → add the Python binary"
            ) from e
        raise

    contact_map = load_contact_map(thyself)
    conv_map = load_conversation_map(thyself)

    if initial_sync:
        cutoff_ns = 0
        print("  iMessage: running initial full sync (all messages)")
    else:
        last_ns = get_last_synced_timestamp(thyself)
        cutoff_ns = max(0, last_ns - (3600 * NANOSECONDS))
        if last_ns > 0:
            print(f"  iMessage: incremental sync from last timestamp")
        else:
            print("  iMessage: no previous sync found, importing all")

    handle_cache = {}
    rows = imsg.execute("SELECT ROWID, id, service FROM handle").fetchall()
    for rowid, handle_id, service in rows:
        handle_cache[rowid] = (handle_id, service)

    chat_cache = {}
    rows = imsg.execute(
        "SELECT ROWID, chat_identifier, display_name, style FROM chat"
    ).fetchall()
    for rowid, identifier, display_name, style in rows:
        is_group = (style == 43)
        chat_cache[rowid] = (identifier, display_name, is_group)

    chat_msg_map = {}
    rows = imsg.execute(
        "SELECT chat_id, message_id FROM chat_message_join WHERE message_date >= ?",
        (cutoff_ns,),
    ).fetchall()
    for chat_id, message_id in rows:
        chat_msg_map[message_id] = chat_id

    added = 0
    skipped_empty = 0
    last_message_at = None

    def _insert_message(rowid, guid, text, handle_id, is_from_me, date_ns, date_read_ns):
        """Insert a single message. Returns True if added."""
        nonlocal added, last_message_at

        source_id = f"imsg_{guid}"
        existing = thyself.execute(
            "SELECT 1 FROM messages WHERE source_id = ? AND source = 'imessage'",
            (source_id,),
        ).fetchone()
        if existing:
            return False

        contact_id = None
        if not is_from_me and handle_id and handle_id in handle_cache:
            handle_str, _ = handle_cache[handle_id]
            normalized = normalize_phone(handle_str) or handle_str.lower().strip()
            contact_id = contact_map.get(normalized)

        chat_id = chat_msg_map.get(rowid)
        conv_id = None
        if chat_id and chat_id in chat_cache:
            chat_identifier, display_name, is_group = chat_cache[chat_id]
            conv_source_id = f"imsg_{chat_identifier}"
            if conv_source_id in conv_map:
                conv_id = conv_map[conv_source_id]
            else:
                cur = thyself.execute(
                    """INSERT INTO conversations (source, source_id, is_group, group_name)
                       VALUES ('imessage', ?, ?, ?)""",
                    (conv_source_id, is_group, display_name if is_group else None),
                )
                conv_id = cur.lastrowid
                conv_map[conv_source_id] = conv_id

        sent_at = apple_ns_to_iso(date_ns)
        read_at = apple_ns_to_iso(date_read_ns)
        wc = len(text.split()) if text else 0

        thyself.execute(
            """INSERT OR IGNORE INTO messages
               (conversation_id, contact_id, source, source_id, is_from_me,
                content, content_type, sent_at, read_at, word_count, has_attachment)
               VALUES (?, ?, 'imessage', ?, ?, ?, 'text', ?, ?, ?, 0)""",
            (conv_id, contact_id, source_id, is_from_me, text, sent_at, read_at, wc),
        )
        added += 1
        if sent_at:
            last_message_at = sent_at

        if added % 5000 == 0:
            thyself.commit()
            print(f"  iMessage: {added:,} messages inserted...")
        return True

    # Pass 1: messages with text column populated (fast, no blob loading)
    for row in imsg.execute(
        """SELECT ROWID, guid, text, handle_id, is_from_me, date, date_read
           FROM message
           WHERE date >= ? AND text IS NOT NULL AND text != ''
           ORDER BY date""",
        (cutoff_ns,),
    ):
        _insert_message(*row)

    pass1_count = added
    print(f"  iMessage: pass 1 done — {pass1_count:,} messages with text column")

    # Pass 2: extract text from attributedBody for messages where text is NULL
    for rowid, guid, handle_id, is_from_me, date_ns, date_read_ns, attr_body in imsg.execute(
        """SELECT ROWID, guid, handle_id, is_from_me, date, date_read, attributedBody
           FROM message
           WHERE date >= ? AND (text IS NULL OR text = '') AND attributedBody IS NOT NULL
           ORDER BY date""",
        (cutoff_ns,),
    ):
        text = extract_text_from_attributed_body(attr_body)
        if not text:
            skipped_empty += 1
            continue
        _insert_message(rowid, guid, text, handle_id, is_from_me, date_ns, date_read_ns)

    thyself.commit()
    imsg.close()
    thyself.close()
    print(f"  iMessage: {added:,} added, {skipped_empty:,} skipped (no text content)")

    # Clean up temp copy
    for suffix in ("", "-wal", "-shm"):
        try:
            os.remove(tmp_db + suffix)
        except FileNotFoundError:
            pass

    return added, last_message_at


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Run iMessage sync for Thyself")
    parser.add_argument(
        "--initial",
        action="store_true",
        help="Run an initial full sync (all messages, not incremental)",
    )
    args = parser.parse_args()

    count, last = sync(initial_sync=args.initial)
    print(f"iMessage sync complete: {count} messages added, last at {last}")
