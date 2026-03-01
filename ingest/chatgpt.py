#!/usr/bin/env python3
"""
Ingest ChatGPT data export into thyself.db.

Parses the split conversations-NNN.json files from a ChatGPT data export,
linearizes the message tree, and inserts conversations + messages into SQLite.

Usage:
    python -m ingest.chatgpt /path/to/chatgpt-export-dir
"""

import json
import os
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

from config import DB_PATH

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS chatgpt_conversations (
    id TEXT PRIMARY KEY,
    title TEXT,
    create_time REAL,
    update_time REAL,
    model_slug TEXT,
    gizmo_id TEXT,
    is_archived BOOLEAN DEFAULT 0,
    message_count INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS chatgpt_messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    parent_id TEXT,
    role TEXT NOT NULL,
    content_type TEXT,
    text TEXT,
    model_slug TEXT,
    status TEXT,
    create_time REAL,
    update_time REAL,
    position INTEGER,
    weight REAL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (conversation_id) REFERENCES chatgpt_conversations(id)
);

CREATE INDEX IF NOT EXISTS idx_chatgpt_msg_conv ON chatgpt_messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_chatgpt_msg_role ON chatgpt_messages(role);
CREATE INDEX IF NOT EXISTS idx_chatgpt_msg_create ON chatgpt_messages(create_time);
CREATE INDEX IF NOT EXISTS idx_chatgpt_conv_create ON chatgpt_conversations(create_time);
"""


def extract_text(content: dict) -> str | None:
    """Extract text from a message content dict, handling text and multimodal_text."""
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
    """
    Walk the conversation tree depth-first following the primary branch
    (last child at each node) to produce the canonical message sequence.
    """
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
                "node_id": current_id,
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


def ingest_export(export_dir: str):
    export_path = Path(export_dir)
    if not export_path.is_dir():
        print(f"Error: {export_dir} is not a directory")
        sys.exit(1)

    conv_files = sorted(export_path.glob("conversations-*.json"))
    if not conv_files:
        print(f"Error: no conversations-*.json files found in {export_dir}")
        sys.exit(1)

    print(f"Found {len(conv_files)} conversation files")

    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.executescript(SCHEMA_SQL)

    total_convs = 0
    total_msgs = 0
    skipped_convs = 0

    for conv_file in conv_files:
        print(f"Processing {conv_file.name}...")
        with open(conv_file) as f:
            conversations = json.load(f)

        for conv in conversations:
            conv_id = conv.get("id") or conv.get("conversation_id")
            if not conv_id:
                continue

            mapping = conv.get("mapping", {})
            messages = linearize_messages(mapping)

            # Determine the primary model used
            model_slugs = [m["model_slug"] for m in messages if m.get("model_slug")]
            primary_model = model_slugs[-1] if model_slugs else None

            # Filter to messages worth storing: user/assistant with text,
            # plus system messages (for context)
            storable = [
                m for m in messages
                if m["role"] in ("user", "assistant", "system")
                and (m["text"] is not None or m["role"] == "system")
            ]

            if not storable:
                skipped_convs += 1
                continue

            try:
                conn.execute(
                    """INSERT OR IGNORE INTO chatgpt_conversations
                       (id, title, create_time, update_time, model_slug,
                        gizmo_id, is_archived, message_count)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                    (
                        conv_id,
                        conv.get("title"),
                        conv.get("create_time"),
                        conv.get("update_time"),
                        primary_model,
                        conv.get("gizmo_id"),
                        1 if conv.get("is_archived") else 0,
                        len(storable),
                    ),
                )
            except sqlite3.IntegrityError:
                skipped_convs += 1
                continue

            for pos, msg in enumerate(storable):
                conn.execute(
                    """INSERT OR IGNORE INTO chatgpt_messages
                       (id, conversation_id, parent_id, role, content_type,
                        text, model_slug, status, create_time, update_time,
                        position, weight)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (
                        msg["id"],
                        conv_id,
                        msg["parent_id"],
                        msg["role"],
                        msg["content_type"],
                        msg["text"],
                        msg["model_slug"],
                        msg["status"],
                        msg["create_time"],
                        msg["update_time"],
                        pos,
                        msg["weight"],
                    ),
                )
                total_msgs += 1

            total_convs += 1

        conn.commit()

    conn.close()

    print(f"\nDone!")
    print(f"  Conversations imported: {total_convs}")
    print(f"  Messages imported: {total_msgs}")
    print(f"  Conversations skipped (empty/duplicate): {skipped_convs}")

    # Summary stats
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    cur.execute("SELECT COUNT(*) FROM chatgpt_conversations")
    print(f"  Total conversations in DB: {cur.fetchone()[0]}")
    cur.execute("SELECT COUNT(*) FROM chatgpt_messages")
    print(f"  Total messages in DB: {cur.fetchone()[0]}")
    cur.execute("SELECT COUNT(*) FROM chatgpt_messages WHERE role='user'")
    print(f"  User messages: {cur.fetchone()[0]}")
    cur.execute("SELECT COUNT(*) FROM chatgpt_messages WHERE role='assistant'")
    print(f"  Assistant messages: {cur.fetchone()[0]}")
    cur.execute("""
        SELECT MIN(create_time), MAX(create_time) FROM chatgpt_messages
        WHERE create_time IS NOT NULL
    """)
    mn, mx = cur.fetchone()
    if mn and mx:
        print(f"  Date range: {datetime.fromtimestamp(mn, tz=timezone.utc).strftime('%Y-%m-%d')} — {datetime.fromtimestamp(mx, tz=timezone.utc).strftime('%Y-%m-%d')}")
    conn.close()


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(f"Usage: python -m ingest.chatgpt <export_dir>")
        sys.exit(1)
    ingest_export(sys.argv[1])
