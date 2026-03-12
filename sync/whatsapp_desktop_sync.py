"""
Incremental WhatsApp Desktop sync from the live ChatStorage.sqlite.

Reads new messages from ~/Library/Group Containers/group.net.whatsapp.WhatsApp.shared/
ChatStorage.sqlite (US number linked to WhatsApp Desktop app). Reuses parsing logic
from import_whatsapp.py but operates incrementally.
"""

import os
import re
import sqlite3
from datetime import datetime, timedelta
from pathlib import Path

import sys
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from config import DB_PATH

WA_DESKTOP_DB = os.path.expanduser(
    "~/Library/Group Containers/group.net.whatsapp.WhatsApp.shared/ChatStorage.sqlite"
)

APPLE_EPOCH = datetime(2001, 1, 1)
SOURCE_PREFIX = "wab"

MSG_TYPE_MAP = {
    0: "text",
    1: "image",
    2: "video",
    3: "audio",
    4: "contact",
    5: "location",
    6: "system",
    7: "text",
    8: "document",
    10: "call",
    11: "waiting",
    14: "deleted",
    15: "sticker",
    23: "poll_vote",
    46: "poll",
    59: "reaction",
}

ATTACHMENT_TYPES = {1, 2, 3, 4, 5, 8, 15}


def apple_ts_to_iso(ts):
    if ts is None:
        return None
    try:
        dt = APPLE_EPOCH + timedelta(seconds=ts)
        return dt.strftime("%Y-%m-%dT%H:%M:%S")
    except (ValueError, OverflowError):
        return None


def apple_ts_from_iso(iso_str):
    """Convert ISO datetime string back to Apple epoch seconds."""
    if not iso_str:
        return 0.0
    try:
        dt = datetime.fromisoformat(iso_str)
        return (dt - APPLE_EPOCH).total_seconds()
    except (ValueError, TypeError):
        return 0.0


def jid_to_phone(jid):
    if not jid or "@" not in jid:
        return None
    number = jid.split("@")[0]
    if "-" in number:
        return None
    if number.isdigit():
        return f"+{number}"
    return None


def normalize_phone(phone):
    if not phone:
        return None
    digits = re.sub(r"[^\d+]", "", phone)
    if not digits.startswith("+"):
        digits = f"+{digits}"
    return digits


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


def get_last_synced_apple_ts(thyself_conn):
    """Get the most recent WhatsApp Desktop message timestamp as Apple epoch seconds."""
    row = thyself_conn.execute(
        "SELECT MAX(sent_at) FROM messages WHERE source = 'whatsapp' AND source_id LIKE ?",
        (f"{SOURCE_PREFIX}_%",),
    ).fetchone()
    if row[0] is None:
        return 0.0
    return apple_ts_from_iso(row[0])


def sync(thyself_db_path=None, initial_sync=False):
    """Run WhatsApp Desktop sync. Returns (messages_added, last_message_at).

    initial_sync=True imports ALL messages (cutoff=0).
    initial_sync=False imports only new messages since the last sync.
    """
    db_path = str(thyself_db_path or DB_PATH)

    if not os.path.exists(WA_DESKTOP_DB):
        raise FileNotFoundError(
            f"WhatsApp Desktop database not found at {WA_DESKTOP_DB}. "
            "Is WhatsApp Desktop installed and linked?"
        )

    thyself = sqlite3.connect(db_path)
    thyself.execute("PRAGMA journal_mode=WAL")

    wa = sqlite3.connect(f"file:{WA_DESKTOP_DB}?mode=ro&immutable=1", uri=True)
    wa.execute("PRAGMA query_only = ON")

    contact_map = load_contact_map(thyself)
    conv_map = load_conversation_map(thyself)

    if initial_sync:
        cutoff = 0.0
        print("  WhatsApp Desktop: running initial full sync (all messages)")
    else:
        last_apple_ts = get_last_synced_apple_ts(thyself)
        cutoff = max(0.0, last_apple_ts - 3600)
        if last_apple_ts > 0:
            print(f"  WhatsApp Desktop: incremental sync from last timestamp")
        else:
            print("  WhatsApp Desktop: no previous sync found, importing all")

    sessions = wa.execute("""
        SELECT Z_PK, ZCONTACTJID, ZPARTNERNAME, ZSESSIONTYPE
        FROM ZWACHATSESSION
        WHERE ZCONTACTJID IS NOT NULL
    """).fetchall()

    session_conv = {}
    session_contact = {}

    for zpk, jid, partner_name, session_type in sessions:
        is_group = "@g.us" in jid
        phone = jid_to_phone(jid)
        conv_source_id = f"{SOURCE_PREFIX}_{jid}"

        if conv_source_id in conv_map:
            conv_id = conv_map[conv_source_id]
        else:
            cur = thyself.execute(
                """INSERT INTO conversations (source, source_id, is_group, group_name)
                   VALUES ('whatsapp', ?, ?, ?)""",
                (conv_source_id, is_group, partner_name if is_group else None),
            )
            conv_id = cur.lastrowid
            conv_map[conv_source_id] = conv_id

        session_conv[zpk] = conv_id

        if not is_group and phone:
            normalized = normalize_phone(phone)
            if normalized and normalized in contact_map:
                session_contact[zpk] = contact_map[normalized]

    thyself.commit()

    group_member_contacts = {}
    for gm_pk, member_jid in wa.execute(
        "SELECT Z_PK, ZMEMBERJID FROM ZWAGROUPMEMBER WHERE ZMEMBERJID IS NOT NULL"
    ).fetchall():
        member_phone = jid_to_phone(member_jid)
        if member_phone:
            normalized = normalize_phone(member_phone)
            if normalized and normalized in contact_map:
                group_member_contacts[member_jid] = contact_map[normalized]

    messages = wa.execute("""
        SELECT
            m.Z_PK, m.ZCHATSESSION, m.ZISFROMME, m.ZMESSAGETYPE,
            m.ZMESSAGEDATE, m.ZTEXT, m.ZSTANZAID, m.ZFROMJID
        FROM ZWAMESSAGE m
        WHERE m.ZCHATSESSION IS NOT NULL AND m.ZMESSAGEDATE >= ?
        ORDER BY m.ZMESSAGEDATE
    """, (cutoff,)).fetchall()

    added = 0
    last_message_at = None

    for zpk, session_pk, is_from_me, msg_type, msg_date, text, stanza_id, from_jid in messages:
        conv_id = session_conv.get(session_pk)
        if conv_id is None:
            continue

        source_id = f"{SOURCE_PREFIX}_{stanza_id}" if stanza_id else f"{SOURCE_PREFIX}_zpk_{zpk}"

        existing = thyself.execute(
            "SELECT 1 FROM messages WHERE source_id = ? AND source = 'whatsapp'",
            (source_id,),
        ).fetchone()
        if existing:
            continue

        contact_id = None
        if not is_from_me:
            contact_id = session_contact.get(session_pk)
            if contact_id is None and from_jid:
                contact_id = group_member_contacts.get(from_jid)

        content_type = MSG_TYPE_MAP.get(msg_type, "other")
        sent_at = apple_ts_to_iso(msg_date)
        has_attachment = msg_type in ATTACHMENT_TYPES
        wc = len(text.split()) if text and content_type == "text" else 0

        thyself.execute(
            """INSERT OR IGNORE INTO messages
               (conversation_id, contact_id, source, source_id, is_from_me,
                content, content_type, sent_at, word_count, has_attachment)
               VALUES (?, ?, 'whatsapp', ?, ?, ?, ?, ?, ?, ?)""",
            (conv_id, contact_id, source_id, is_from_me, text, content_type,
             sent_at, wc, has_attachment),
        )
        added += 1
        if sent_at:
            last_message_at = sent_at

        if added % 5000 == 0:
            thyself.commit()
            print(f"  WhatsApp Desktop: {added:,} messages inserted...")

    thyself.commit()
    wa.close()
    thyself.close()

    return added, last_message_at


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Run WhatsApp Desktop sync for Thyself")
    parser.add_argument(
        "--initial",
        action="store_true",
        help="Run an initial full sync (all messages, not incremental)",
    )
    args = parser.parse_args()

    count, last = sync(initial_sync=args.initial)
    print(f"WhatsApp Desktop sync complete: {count} messages added, last at {last}")
