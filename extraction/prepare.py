"""
Prepare token-sized batches from the message corpus for life extraction.

Loads all messages from all source tables (messages, chatgpt_messages,
gmail_messages), sorts them chronologically, and packs them into
batches sized to fill the ~1M context window.
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
    msg_id: str | None = None  # source-prefixed ID: #m(messages), #c(chatgpt), #g(gmail)


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
    """Map conversation_id -> label (contact name for 1:1, group name for groups)."""
    cache = {}

    rows = conn.execute("""
        SELECT cp.conversation_id, c.display_name, c.phone
        FROM conversation_participants cp
        JOIN contacts c ON c.id = cp.contact_id
        JOIN conversations conv ON conv.id = cp.conversation_id
        WHERE conv.is_group = 0
    """).fetchall()
    for conv_id, display_name, phone in rows:
        cache[conv_id] = display_name or phone or "unknown"

    rows = conn.execute("""
        SELECT id, group_name FROM conversations
        WHERE is_group = 1 AND group_name IS NOT NULL AND group_name != ''
    """).fetchall()
    for conv_id, group_name in rows:
        cache[conv_id] = f"group:{group_name}"

    return cache


def _fetch_imessage_whatsapp(
    conn: sqlite3.Connection,
    contact_cache: dict[int, str], conv_cache: dict[int, str],
) -> list[Message]:
    """Fetch all iMessage and WhatsApp messages."""
    rows = conn.execute(
        """
        SELECT m.rowid, m.sent_at, m.source, m.is_from_me, m.contact_id, m.content,
               m.conversation_id
        FROM messages m
        WHERE m.content IS NOT NULL
        ORDER BY m.sent_at
        """,
    ).fetchall()

    messages = []
    for rowid, sent_at, source, is_from_me, contact_id, content, conv_id in rows:
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
            msg_id=f"#m{rowid}",
        ))
    return messages


def _fetch_chatgpt(conn: sqlite3.Connection) -> list[Message]:
    """Fetch all ChatGPT messages."""
    rows = conn.execute(
        """
        SELECT cm.rowid, datetime(cm.create_time, 'unixepoch') as ts,
               cm.role, cm.text, cc.title
        FROM chatgpt_messages cm
        JOIN chatgpt_conversations cc ON cm.conversation_id = cc.id
        WHERE cm.text IS NOT NULL AND cm.text != ''
        ORDER BY cm.create_time
        """,
    ).fetchall()

    messages = []
    for rowid, ts, role, text, title in rows:
        sender = SUBJECT_NAME if role == "user" else "ChatGPT"
        messages.append(Message(
            timestamp=ts,
            source="chatgpt",
            sender=sender,
            recipient="ChatGPT" if role == "user" else SUBJECT_NAME,
            content=text,
            meta=title,
            msg_id=f"#c{rowid}",
        ))
    return messages


def _fetch_gmail(conn: sqlite3.Connection) -> list[Message]:
    """Fetch all Gmail messages."""
    rows = conn.execute(
        """
        SELECT rowid, sent_at, is_from_me, from_name, from_addr,
               to_addrs, subject, body_text
        FROM gmail_messages
        WHERE body_text IS NOT NULL AND body_text != ''
        ORDER BY sent_at
        """,
    ).fetchall()

    messages = []
    for rowid, sent_at, is_from_me, from_name, from_addr, to_addrs, subject, body_text in rows:
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
            msg_id=f"#g{rowid}",
        ))
    return messages


def fetch_all_messages(db_path: str | Path | None = None) -> list[Message]:
    """Load all messages from all sources, sorted chronologically."""
    db = Path(db_path) if db_path else DB_PATH
    conn = sqlite3.connect(db)
    try:
        contact_cache = _load_contact_cache(conn)
        conv_cache = _load_conversation_labels(conn)

        msgs: list[Message] = []
        msgs.extend(_fetch_imessage_whatsapp(conn, contact_cache, conv_cache))
        msgs.extend(_fetch_chatgpt(conn))
        msgs.extend(_fetch_gmail(conn))
    finally:
        conn.close()

    msgs.sort(key=lambda m: m.timestamp or "")
    return msgs


def format_message(msg: Message) -> str:
    """Format a single message for the chunk."""
    ts = msg.timestamp[:16] if msg.timestamp else "unknown"
    id_prefix = f"{msg.msg_id} | " if msg.msg_id else ""
    header = f"[{id_prefix}{ts} | {msg.source} | {msg.sender} → {msg.recipient}]"
    if msg.meta:
        header += f"  ({msg.meta})"
    return f"{header}\n{msg.content}"


MAX_BATCH_TOKENS = 550_000  # actual tokens run ~1.6x this estimate for short-message months


@dataclass
class BatchSpec:
    """Specification for a single token-sized batch."""
    batch_num: int
    total_batches: int
    start_idx: int        # index into the sorted message list
    end_idx: int          # exclusive end index
    start_date: str       # timestamp of first message
    end_date: str         # timestamp of last message
    months: list[str]     # derived: calendar months spanned (for the prompt header)
    approx_tokens: int


def _estimate_tokens(messages: list[Message]) -> int:
    return sum(len(format_message(m)) for m in messages) // 4


def plan_batches(
    messages: list[Message],
    max_tokens: int = MAX_BATCH_TOKENS,
) -> list[BatchSpec]:
    """Plan token-sized batches by packing messages to fill each batch.

    Iterates the chronologically sorted message list, cutting a new batch
    whenever adding the next message would exceed max_tokens. Each batch
    is packed to near-100% capacity (except the last).
    """
    if not messages:
        return []

    batches: list[BatchSpec] = []
    batch_start = 0
    current_chars = 0

    for i, msg in enumerate(messages):
        msg_chars = len(format_message(msg))

        if current_chars > 0 and (current_chars + msg_chars) // 4 > max_tokens:
            months = sorted({m.timestamp[:7] for m in messages[batch_start:i] if m.timestamp})
            batches.append(BatchSpec(
                batch_num=len(batches) + 1,
                total_batches=0,
                start_idx=batch_start,
                end_idx=i,
                start_date=messages[batch_start].timestamp[:10] if messages[batch_start].timestamp else "?",
                end_date=messages[i - 1].timestamp[:10] if messages[i - 1].timestamp else "?",
                months=months,
                approx_tokens=current_chars // 4,
            ))
            batch_start = i
            current_chars = 0

        current_chars += msg_chars

    if batch_start < len(messages):
        months = sorted({m.timestamp[:7] for m in messages[batch_start:] if m.timestamp})
        batches.append(BatchSpec(
            batch_num=len(batches) + 1,
            total_batches=0,
            start_idx=batch_start,
            end_idx=len(messages),
            start_date=messages[batch_start].timestamp[:10] if messages[batch_start].timestamp else "?",
            end_date=messages[-1].timestamp[:10] if messages[-1].timestamp else "?",
            months=months,
            approx_tokens=current_chars // 4,
        ))

    for b in batches:
        b.total_batches = len(batches)

    return batches


def build_batch_chunk(
    messages: list[Message],
    batch: BatchSpec,
    prev_summary: str | None = None,
) -> str:
    """Build a complete batch chunk for extraction.

    Takes the full message list and a BatchSpec, slices the relevant
    messages, and formats them into a single user message.
    """
    batch_messages = messages[batch.start_idx:batch.end_idx]

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

    chunk += f"Total messages in this batch: {len(batch_messages)}\n\n---\n\n"

    for msg in batch_messages:
        chunk += format_message(msg) + "\n\n"

    return chunk


if __name__ == "__main__":
    import sys

    db_path = None
    if "--db" in sys.argv:
        idx = sys.argv.index("--db")
        db_path = sys.argv[idx + 1]

    print("Loading messages...", end=" ", flush=True)
    all_messages = fetch_all_messages(db_path)
    print(f"{len(all_messages):,} messages loaded.")

    batches = plan_batches(all_messages)
    total = sum(b.approx_tokens for b in batches)
    print(f"Planned {len(batches)} batches at ~{MAX_BATCH_TOKENS:,} tokens each:\n")

    for b in batches:
        pct = b.approx_tokens / MAX_BATCH_TOKENS * 100
        print(
            f"  Batch {b.batch_num:>2}/{b.total_batches}: "
            f"{b.start_date} to {b.end_date}  "
            f"({len(b.months):>2} months, ~{b.approx_tokens:>9,} tokens, {pct:.0f}% full)"
        )
    print(f"\n  Total: ~{total:,} tokens across {len(batches)} batches")
