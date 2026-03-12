"""
Incremental Gmail sync.

Wraps the existing GmailIngester from ingest/gmail.py with a date filter
based on the most recent gmail_messages.sent_at timestamp. Dedup is
handled by INSERT OR IGNORE on gmail_id.
"""

import sqlite3
from datetime import datetime, timedelta
from pathlib import Path

import sys
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "ingest"))
from config import DB_PATH
from gmail import GmailIngester, DEFAULT_QUERY

FULL_SYNC_QUERY = "-label:spam -label:trash"


def get_last_synced_date(db_path):
    """Get the most recent gmail_messages sent_at as a date string for Gmail API."""
    conn = sqlite3.connect(str(db_path))
    row = conn.execute("SELECT MAX(sent_at) FROM gmail_messages").fetchone()
    conn.close()

    if row[0] is None:
        return None

    try:
        dt = datetime.fromisoformat(row[0].replace("Z", "+00:00"))
        # Go back 7 days for safety overlap (dedup handles it)
        dt -= timedelta(days=7)
        return dt.strftime("%Y/%m/%d")
    except (ValueError, TypeError):
        return None


def sync(thyself_db_path=None, initial_sync=False):
    """Run Gmail sync. Returns (messages_added, last_message_at)."""
    db_path = thyself_db_path or DB_PATH

    if initial_sync:
        query = FULL_SYNC_QUERY
        print("  Gmail: running initial full sync (all non-spam/non-trash messages)")
    else:
        last_date = get_last_synced_date(db_path)
        query = DEFAULT_QUERY
        if last_date:
            query = f"after:{last_date} {query}"
            print(f"  Gmail: syncing messages after {last_date}")
        else:
            print("  Gmail: no previous sync found, doing full sync")

    conn = sqlite3.connect(str(db_path))
    count_before = conn.execute("SELECT COUNT(*) FROM gmail_messages").fetchone()[0]
    conn.close()

    ingester = GmailIngester(db_path=db_path)
    ingester.ingest(query=query)

    conn = sqlite3.connect(str(db_path))
    count_after = conn.execute("SELECT COUNT(*) FROM gmail_messages").fetchone()[0]
    last_msg = conn.execute("SELECT MAX(sent_at) FROM gmail_messages").fetchone()[0]
    conn.close()

    added = count_after - count_before
    return added, last_msg


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Run Gmail sync for Thyself")
    parser.add_argument(
        "--initial",
        action="store_true",
        help="Run an initial full sync (all non-spam/non-trash messages)",
    )
    args = parser.parse_args()

    count, last = sync(initial_sync=args.initial)
    print(f"Gmail sync complete: {count} messages added, last at {last}")
