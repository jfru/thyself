"""
Prepare monthly chunks from the message corpus for life extraction.

Pulls data from all four source tables (messages, chatgpt_messages,
gmail_messages) and assembles them into chronologically interleaved
monthly chunks ready to send to Claude.
"""

import json
import re
import sqlite3
from dataclasses import dataclass
from pathlib import Path

from config import DB_PATH, SUBJECT_NAME
from .prompt import BATCH_HEADER_TEMPLATE, PRIOR_CONTEXT_TEMPLATE

JUNK_PATTERNS = [
    re.compile(r"^__kIM\w+"),
    re.compile(r"^\x00"),
    re.compile(r"^&__kIM"),
    re.compile(r"^\+.$"),  # single char after + prefix
]


@dataclass
class Message:
    timestamp: str
    source: str
    sender: str
    recipient: str | None
    content: str
    meta: str | None = None  # conversation title, subject line, etc.


def _is_junk(content: str | None) -> bool:
    if not content or len(content.strip()) < 2:
        return True
    for pat in JUNK_PATTERNS:
        if pat.match(content):
            return True
    return False


def _clean_content(content: str) -> str:
    """Strip iMessage prefix bytes and clean up content."""
    if content and len(content) > 1 and content[0] == "+":
        first_char = content[1] if len(content) > 1 else ""
        if first_char.isupper() or first_char.isdigit() or first_char in "\"'([{":
            content = content[1:]
        elif len(content) > 2 and content[1] in "0123456789ABCDEFabcdef" and content[2:3].isupper():
            content = content[2:]
    return content.strip()


def _load_contact_cache(conn: sqlite3.Connection) -> dict[int, str]:
    """Pre-load contact display names, falling back to phone number."""
    cache = {}
    rows = conn.execute(
        "SELECT id, display_name, phone FROM contacts"
    ).fetchall()
    for contact_id, display_name, phone in rows:
        cache[contact_id] = display_name or phone or f"contact-{contact_id}"
    return cache


def _load_conversation_labels(conn: sqlite3.Connection) -> dict[int, str]:
    """Map conversation_id → label (contact name for 1:1, group name for groups)."""
    cache = {}

    # 1:1 conversations: use participant name
    rows = conn.execute("""
        SELECT cp.conversation_id, c.display_name, c.phone
        FROM conversation_participants cp
        JOIN contacts c ON c.id = cp.contact_id
        JOIN conversations conv ON conv.id = cp.conversation_id
        WHERE conv.is_group = 0
    """).fetchall()
    for conv_id, display_name, phone in rows:
        cache[conv_id] = display_name or phone or "unknown"

    # Group conversations: use group name
    rows = conn.execute("""
        SELECT id, group_name FROM conversations
        WHERE is_group = 1 AND group_name IS NOT NULL AND group_name != ''
    """).fetchall()
    for conv_id, group_name in rows:
        cache[conv_id] = f"group:{group_name}"

    return cache


def fetch_imessage_whatsapp(
    conn: sqlite3.Connection, month: str,
    contact_cache: dict[int, str], conv_cache: dict[int, str],
) -> list[Message]:
    """Fetch iMessage and WhatsApp messages for a month."""
    rows = conn.execute(
        """
        SELECT m.sent_at, m.source, m.is_from_me, m.contact_id, m.content,
               m.conversation_id
        FROM messages m
        WHERE strftime('%Y-%m', m.sent_at) = ?
          AND m.content IS NOT NULL
        ORDER BY m.sent_at
        """,
        (month,),
    ).fetchall()

    messages = []
    for sent_at, source, is_from_me, contact_id, content, conv_id in rows:
        if _is_junk(content):
            continue
        content = _clean_content(content)
        if len(content) < 2:
            continue

        if contact_id and contact_id in contact_cache:
            other = contact_cache[contact_id]
        elif conv_id and conv_id in conv_cache:
            other = conv_cache[conv_id]
        else:
            other = f"contact-{contact_id}" if contact_id else "unknown"

        sender = SUBJECT_NAME if is_from_me else other
        recipient = other if is_from_me else SUBJECT_NAME

        messages.append(Message(
            timestamp=sent_at,
            source=source,
            sender=sender,
            recipient=recipient,
            content=content,
        ))
    return messages


def fetch_chatgpt(conn: sqlite3.Connection, month: str) -> list[Message]:
    """Fetch ChatGPT messages for a month."""
    start = f"{month}-01"
    if month.endswith("12"):
        y = int(month[:4]) + 1
        end = f"{y:04d}-01-01"
    else:
        m = int(month[5:]) + 1
        end = f"{month[:5]}{m:02d}-01"

    rows = conn.execute(
        """
        SELECT datetime(cm.create_time, 'unixepoch') as ts,
               cm.role, cm.text, cc.title
        FROM chatgpt_messages cm
        JOIN chatgpt_conversations cc ON cm.conversation_id = cc.id
        WHERE cm.create_time >= strftime('%s', ?)
          AND cm.create_time < strftime('%s', ?)
          AND cm.text IS NOT NULL AND cm.text != ''
        ORDER BY cm.create_time
        """,
        (start, end),
    ).fetchall()

    messages = []
    for ts, role, text, title in rows:
        sender = SUBJECT_NAME if role == "user" else "ChatGPT"
        messages.append(Message(
            timestamp=ts,
            source="chatgpt",
            sender=sender,
            recipient="ChatGPT" if role == "user" else SUBJECT_NAME,
            content=text,
            meta=title,
        ))
    return messages


def fetch_gmail(conn: sqlite3.Connection, month: str) -> list[Message]:
    """Fetch Gmail messages for a month."""
    rows = conn.execute(
        """
        SELECT sent_at, is_from_me, from_name, from_addr, 
               to_addrs, subject, body_text
        FROM gmail_messages
        WHERE strftime('%Y-%m', sent_at) = ?
          AND body_text IS NOT NULL AND body_text != ''
        ORDER BY sent_at
        """,
        (month,),
    ).fetchall()

    messages = []
    for sent_at, is_from_me, from_name, from_addr, to_addrs, subject, body_text in rows:
        if is_from_me:
            sender = SUBJECT_NAME
            try:
                recipients = json.loads(to_addrs) if to_addrs else []
                recipient = ", ".join(recipients[:3]) if recipients else "unknown"
            except (json.JSONDecodeError, TypeError):
                recipient = str(to_addrs) if to_addrs else "unknown"
        else:
            sender = from_name or from_addr or "unknown"
            recipient = SUBJECT_NAME

        messages.append(Message(
            timestamp=sent_at,
            source="gmail",
            sender=sender,
            recipient=recipient,
            content=body_text,
            meta=subject,
        ))
    return messages


def format_message(msg: Message) -> str:
    """Format a single message for the chunk."""
    ts = msg.timestamp[:16] if msg.timestamp else "unknown"
    header = f"[{ts} | {msg.source} | {msg.sender} → {msg.recipient}]"
    if msg.meta:
        header += f"  ({msg.meta})"
    return f"{header}\n{msg.content}"


MAX_BATCH_TOKENS = 550_000  # actual tokens run ~1.6x this estimate for short-message months


@dataclass
class BatchSpec:
    """Specification for a single token-sized batch."""
    batch_num: int
    total_batches: int
    months: list[str]
    start_date: str
    end_date: str
    approx_tokens: int


def _fetch_all_for_month(
    conn: sqlite3.Connection, month: str,
    contact_cache: dict[int, str], conv_cache: dict[int, str],
) -> list[Message]:
    """Fetch all messages for a month from all sources."""
    msgs = []
    msgs.extend(fetch_imessage_whatsapp(conn, month, contact_cache, conv_cache))
    msgs.extend(fetch_chatgpt(conn, month))
    msgs.extend(fetch_gmail(conn, month))
    return msgs


def _estimate_tokens(messages: list[Message]) -> int:
    return sum(len(format_message(m)) for m in messages) // 4


def get_available_months(db_path: str | Path | None = None) -> list[str]:
    """Return all months that have message data, sorted chronologically."""
    db = Path(db_path) if db_path else DB_PATH
    conn = sqlite3.connect(db)
    try:
        months = set()
        for row in conn.execute("SELECT DISTINCT strftime('%Y-%m', sent_at) FROM messages WHERE sent_at IS NOT NULL"):
            if row[0]:
                months.add(row[0])
        for row in conn.execute(
            "SELECT DISTINCT strftime('%Y-%m', create_time, 'unixepoch') FROM chatgpt_messages WHERE create_time IS NOT NULL"
        ):
            if row[0]:
                months.add(row[0])
        for row in conn.execute(
            "SELECT DISTINCT strftime('%Y-%m', sent_at) FROM gmail_messages WHERE sent_at IS NOT NULL"
        ):
            if row[0]:
                months.add(row[0])
        return sorted(months)
    finally:
        conn.close()


def plan_batches(
    db_path: str | Path | None = None,
    max_tokens: int = MAX_BATCH_TOKENS,
) -> list[BatchSpec]:
    """Plan token-sized batches across the full timeline.

    Groups consecutive months into batches that each fit within max_tokens.
    Returns a list of BatchSpec objects describing each batch.
    """
    db = Path(db_path) if db_path else DB_PATH
    months = get_available_months(db)
    conn = sqlite3.connect(db)
    try:
        contact_cache = _load_contact_cache(conn)
        conv_cache = _load_conversation_labels(conn)

        month_tokens = {}
        for m in months:
            msgs = _fetch_all_for_month(conn, m, contact_cache, conv_cache)
            month_tokens[m] = _estimate_tokens(msgs)
    finally:
        conn.close()

    batches: list[BatchSpec] = []
    current_months: list[str] = []
    current_tokens = 0

    for m in months:
        t = month_tokens[m]
        if current_months and current_tokens + t > max_tokens:
            batches.append(BatchSpec(
                batch_num=len(batches) + 1,
                total_batches=0,
                months=current_months,
                start_date=f"{current_months[0]}-01",
                end_date=_month_end(current_months[-1]),
                approx_tokens=current_tokens,
            ))
            current_months = []
            current_tokens = 0
        current_months.append(m)
        current_tokens += t

    if current_months:
        batches.append(BatchSpec(
            batch_num=len(batches) + 1,
            total_batches=0,
            months=current_months,
            start_date=f"{current_months[0]}-01",
            end_date=_month_end(current_months[-1]),
            approx_tokens=current_tokens,
        ))

    for b in batches:
        b.total_batches = len(batches)

    return batches


def _month_end(month: str) -> str:
    """Return the last day of a month string like '2024-07'."""
    import calendar
    y, m = int(month[:4]), int(month[5:])
    _, last_day = calendar.monthrange(y, m)
    return f"{month}-{last_day}"


def build_batch_chunk(
    batch: BatchSpec,
    db_path: str | Path | None = None,
    prev_summary: str | None = None,
) -> str:
    """Build a complete batch chunk for extraction.

    Collects all messages across the months in this batch, sorts them
    chronologically, and formats them into a single user message.
    """
    db = Path(db_path) if db_path else DB_PATH
    conn = sqlite3.connect(db)
    try:
        contact_cache = _load_contact_cache(conn)
        conv_cache = _load_conversation_labels(conn)

        all_messages = []
        for month in batch.months:
            all_messages.extend(
                _fetch_all_for_month(conn, month, contact_cache, conv_cache)
            )
    finally:
        conn.close()

    all_messages.sort(key=lambda m: m.timestamp or "")

    chunk = BATCH_HEADER_TEMPLATE.format(
        batch_num=batch.batch_num,
        total_batches=batch.total_batches,
        start_date=batch.start_date,
        end_date=batch.end_date,
        approx_tokens=batch.approx_tokens,
        months_list=", ".join(batch.months),
    )

    if prev_summary:
        chunk += PRIOR_CONTEXT_TEMPLATE.format(
            prev_period=batch.start_date,
            prev_summary=prev_summary,
        )

    chunk += f"Total messages in this batch: {len(all_messages)}\n\n---\n\n"

    for msg in all_messages:
        chunk += format_message(msg) + "\n\n"

    return chunk


def chunk_stats(month: str, db_path: str | Path | None = None) -> dict:
    """Get message counts and approximate token count for a month."""
    db = Path(db_path) if db_path else DB_PATH
    conn = sqlite3.connect(db)
    try:
        contact_cache = _load_contact_cache(conn)
        conv_cache = _load_conversation_labels(conn)
        im = fetch_imessage_whatsapp(conn, month, contact_cache, conv_cache)
        cg = fetch_chatgpt(conn, month)
        gm = fetch_gmail(conn, month)
    finally:
        conn.close()

    total_chars = sum(len(m.content) for m in im + cg + gm)
    return {
        "month": month,
        "imessage_whatsapp": len(im),
        "chatgpt": len(cg),
        "gmail": len(gm),
        "total": len(im) + len(cg) + len(gm),
        "total_chars": total_chars,
        "approx_tokens": total_chars // 4,
    }


if __name__ == "__main__":
    import sys

    if "--batches" in sys.argv:
        batches = plan_batches()
        print(f"Planned {len(batches)} batches:\n")
        for b in batches:
            m_range = f"{b.months[0]} to {b.months[-1]}" if len(b.months) > 1 else b.months[0]
            print(
                f"  Batch {b.batch_num:>2}/{b.total_batches}: "
                f"{m_range:>20}  "
                f"({len(b.months):>2} months, ~{b.approx_tokens:>9,} tokens)"
            )
        total = sum(b.approx_tokens for b in batches)
        print(f"\n  Total: ~{total:,} tokens across {len(batches)} batches")
    elif len(sys.argv) > 1:
        months = [a for a in sys.argv[1:] if not a.startswith("-")]
        for month in months:
            stats = chunk_stats(month)
            print(
                f"  {stats['month']}: "
                f"{stats['imessage_whatsapp']:>5} iMsg/WA  "
                f"{stats['chatgpt']:>5} ChatGPT  "
                f"{stats['gmail']:>3} Gmail  "
                f"= {stats['total']:>5} total  "
                f"(~{stats['approx_tokens']:,} tokens)"
            )
    else:
        months = get_available_months()
        print(f"Found {len(months)} months with data: {months[0]} to {months[-1]}\n")

        batches = plan_batches()
        print(f"Planned {len(batches)} extraction batches at ~{MAX_BATCH_TOKENS:,} tokens each:\n")
        for b in batches:
            m_range = f"{b.months[0]} to {b.months[-1]}" if len(b.months) > 1 else b.months[0]
            print(
                f"  Batch {b.batch_num:>2}/{b.total_batches}: "
                f"{m_range:>20}  "
                f"({len(b.months):>2} months, ~{b.approx_tokens:>9,} tokens)"
            )
        total = sum(b.approx_tokens for b in batches)
        print(f"\n  Total: ~{total:,} tokens across {len(batches)} batches")
