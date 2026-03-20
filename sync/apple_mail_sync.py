"""
Incremental Apple Mail sync for the Cantab email account.

Reads from ~/Library/Mail/V10/MailData/Envelope Index (Apple Mail's SQLite DB)
and inserts new messages into thyself.db as source='apple_mail_v1'.

Requires Full Disk Access for the running process.
"""

import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

import sys
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from config import DB_PATH

MAIL_DB = os.path.expanduser("~/Library/Mail/V10/MailData/Envelope Index")
CANTAB_ACCOUNT_UUID = "E27B2908-82AF-4039-AB98-E946760B961E"
SOURCE_PREFIX = "am"

INCLUDE_MAILBOX_SUFFIXES = ["/INBOX", "/Archive", "/Sent%20Messages", "/Sent"]
EXCLUDE_MAILBOX_SUFFIXES = ["/Trash", "/Junk", "/Drafts", "/Migrated"]


def get_cantab_mailbox_ids(mail_conn: sqlite3.Connection) -> list[int]:
    rows = mail_conn.execute(
        "SELECT ROWID, url FROM mailboxes WHERE url LIKE ?",
        (f"%{CANTAB_ACCOUNT_UUID}%",),
    ).fetchall()

    ids = []
    for rowid, url in rows:
        if any(url.endswith(s) for s in EXCLUDE_MAILBOX_SUFFIXES):
            continue
        if any(s in url for s in ["/Migrated"]):
            continue
        ids.append(rowid)
    return ids


def get_last_synced_timestamp(thyself_conn: sqlite3.Connection) -> float:
    row = thyself_conn.execute(
        "SELECT MAX(sent_at) FROM messages WHERE source = 'apple_mail_v1' AND source_id LIKE ?",
        (f"{SOURCE_PREFIX}_%",),
    ).fetchone()
    if row[0] is None:
        return 0
    try:
        dt = datetime.fromisoformat(row[0].replace("Z", "+00:00"))
        return dt.timestamp()
    except (ValueError, TypeError):
        return 0


def sync(thyself_db_path=None):
    import logging
    log = logging.getLogger("thyself.sync")

    db_path = str(thyself_db_path or DB_PATH)

    if not os.path.exists(MAIL_DB):
        raise RuntimeError(f"Apple Mail database not found at {MAIL_DB}")

    mail_conn = sqlite3.connect(f"file:{MAIL_DB}?mode=ro", uri=True)
    thyself_conn = sqlite3.connect(db_path)
    thyself_conn.execute("PRAGMA journal_mode=WAL")

    mailbox_ids = get_cantab_mailbox_ids(mail_conn)
    if not mailbox_ids:
        mail_conn.close()
        thyself_conn.close()
        raise RuntimeError(f"No cantab mailboxes found for account {CANTAB_ACCOUNT_UUID}")

    log.info("  Apple Mail: found %d cantab mailboxes", len(mailbox_ids))

    last_ts = get_last_synced_timestamp(thyself_conn)
    cutoff_ts = max(0, last_ts - 3600)

    placeholders = ",".join("?" * len(mailbox_ids))
    query = f"""
        SELECT m.ROWID, m.date_sent, m.date_received, m.read, m.flagged,
               m.deleted, m.size,
               s.subject,
               a.address as sender_address, a.comment as sender_name,
               su.summary as body_summary
        FROM messages m
        LEFT JOIN subjects s ON m.subject = s.ROWID
        LEFT JOIN addresses a ON m.sender = a.ROWID
        LEFT JOIN summaries su ON m.summary = su.ROWID
        WHERE m.mailbox IN ({placeholders})
          AND m.deleted = 0
          AND m.date_sent > ?
        ORDER BY m.date_sent ASC
    """

    existing_ids = set(
        r[0] for r in thyself_conn.execute(
            "SELECT source_id FROM messages WHERE source = 'apple_mail_v1' AND source_id IS NOT NULL"
        ).fetchall()
    )

    rows = mail_conn.execute(query, mailbox_ids + [cutoff_ts]).fetchall()
    log.info("  Apple Mail: %d candidate messages, %d already synced",
             len(rows), len(existing_ids))

    added = 0
    last_message_at = None
    batch = []

    for row in rows:
        (rowid, date_sent, date_received, is_read, flagged,
         deleted, size, subject, sender_addr, sender_name,
         body_summary) = row

        source_id = f"{SOURCE_PREFIX}_{rowid}"
        if source_id in existing_ids:
            continue

        sent_at = None
        if date_sent:
            sent_at = datetime.fromtimestamp(date_sent, tz=timezone.utc).strftime(
                "%Y-%m-%dT%H:%M:%S"
            )

        content = body_summary or ""
        is_from_me = False
        if sender_addr and "cantab.net" in sender_addr.lower():
            is_from_me = True
        if sender_addr and "cam.ac.uk" in sender_addr.lower():
            is_from_me = sender_addr.lower().startswith("jfruhman")

        word_count = len(content.split()) if content else 0

        batch.append((source_id, is_from_me, content, sent_at, word_count))
        if sent_at:
            last_message_at = sent_at

    if batch:
        thyself_conn.executemany(
            """INSERT OR IGNORE INTO messages
               (source, source_id, is_from_me, content, sent_at, word_count)
               VALUES ('apple_mail_v1', ?, ?, ?, ?, ?)""",
            batch,
        )
        added = len(batch)

    thyself_conn.commit()

    mail_conn.close()
    thyself_conn.close()

    return added, last_message_at


if __name__ == "__main__":
    import logging
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
    count, last = sync()
    print(f"Apple Mail sync complete: {count} messages added, last at {last}")
