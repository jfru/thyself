#!/usr/bin/env python3
"""
Import WhatsApp messages from extracted iPhone backup databases into thyself.db.

Handles both WhatsApp Personal (UK) and WhatsApp Business (US) databases.
Replaces existing WhatsApp data with complete dataset from iPhone backup.
"""

import os
import re
import sqlite3
from datetime import datetime, timedelta

from config import DB_PATH, DATA_DIR

THYSELF_DB = str(DB_PATH)
WA_EXPORT_DIR = str(DATA_DIR / "whatsapp_export")

WA_SOURCES = [
    {
        "label": "personal",
        "prefix": "wap",
        "db": os.path.join(
            WA_EXPORT_DIR,
            "AppDomainGroup_group_net_whatsapp_WhatsApp_shared__ChatStorage.sqlite",
        ),
    },
    {
        "label": "business",
        "prefix": "wab",
        "db": os.path.join(
            WA_EXPORT_DIR,
            "AppDomainGroup_group_net_whatsapp_WhatsAppSMB_shared__ChatStorage.sqlite",
        ),
    },
]

APPLE_EPOCH = datetime(2001, 1, 1)

MSG_TYPE_MAP = {
    0: "text",
    1: "image",
    2: "video",
    3: "audio",
    4: "contact",
    5: "location",
    6: "system",
    7: "text",       # link preview — still has text content
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


def jid_to_phone(jid):
    """Extract E.164 phone number from a WhatsApp JID like '447707665121@s.whatsapp.net'."""
    if not jid or "@" not in jid:
        return None
    number = jid.split("@")[0]
    if "-" in number:  # group JID
        return None
    if number.isdigit():
        return f"+{number}"
    return None


def word_count(text):
    if not text:
        return 0
    return len(text.split())


def load_existing_contacts(thyself_conn):
    """Build phone → contact_id lookup from existing contacts."""
    cur = thyself_conn.execute(
        "SELECT id, phone, display_name FROM contacts WHERE phone IS NOT NULL AND phone != ''"
    )
    phone_map = {}
    for cid, phone, name in cur.fetchall():
        normalized = re.sub(r"[^\d+]", "", phone)
        if not normalized.startswith("+"):
            normalized = f"+{normalized}"
        phone_map[normalized] = (cid, name)
    return phone_map


def create_contact(thyself_conn, phone, display_name, jid):
    """Create a new contact and return its id."""
    cur = thyself_conn.execute(
        """INSERT INTO contacts (display_name, phone, whatsapp_jid, created_at, updated_at)
           VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)""",
        (display_name, phone, jid),
    )
    return cur.lastrowid


def run_import():
    thyself = sqlite3.connect(THYSELF_DB)
    thyself.execute("PRAGMA journal_mode=WAL")
    thyself.execute("PRAGMA foreign_keys=OFF")

    phone_map = load_existing_contacts(thyself)
    print(f"Loaded {len(phone_map)} existing contacts with phone numbers\n")

    # ── Step 1: Back up by keeping old data until we're sure ──
    old_wa_msg_count = thyself.execute(
        "SELECT COUNT(*) FROM messages WHERE source='whatsapp'"
    ).fetchone()[0]
    old_wa_conv_count = thyself.execute(
        "SELECT COUNT(*) FROM conversations WHERE source='whatsapp'"
    ).fetchone()[0]
    print(f"Existing WhatsApp data: {old_wa_conv_count:,} conversations, {old_wa_msg_count:,} messages")

    # ── Step 2: Clear existing WhatsApp data ──
    print("Clearing existing WhatsApp data...")
    thyself.execute(
        """DELETE FROM conversation_participants 
           WHERE conversation_id IN (SELECT id FROM conversations WHERE source='whatsapp')"""
    )
    thyself.execute("DELETE FROM messages WHERE source='whatsapp'")
    thyself.execute("DELETE FROM conversations WHERE source='whatsapp'")
    thyself.commit()
    print("  Cleared.\n")

    # ── Step 3: Update whatsapp_jid on existing contacts ──
    # (Will be done as we encounter JIDs during import)

    total_convs = 0
    total_msgs = 0
    total_contacts_created = 0
    total_contacts_updated = 0
    total_participants = 0

    for source in WA_SOURCES:
        label = source["label"]
        prefix = source["prefix"]
        db_path = source["db"]

        if not os.path.exists(db_path):
            print(f"SKIP: {label} — database not found at {db_path}")
            continue

        print(f"{'=' * 60}")
        print(f"Importing: WhatsApp {label.upper()}")
        print(f"{'=' * 60}\n")

        wa = sqlite3.connect(db_path)

        # ── Load chat sessions ──
        sessions = wa.execute("""
            SELECT Z_PK, ZCONTACTJID, ZPARTNERNAME, ZSESSIONTYPE, ZMESSAGECOUNTER
            FROM ZWACHATSESSION
            WHERE ZCONTACTJID IS NOT NULL
        """).fetchall()

        # Map WA session Z_PK → thyself conversation_id
        session_to_conv = {}
        # Map WA session Z_PK → contact_id (for DMs)
        session_to_contact = {}

        for zpk, jid, partner_name, session_type, msg_count in sessions:
            is_group = "@g.us" in jid
            phone = jid_to_phone(jid)

            # Create conversation
            group_name = partner_name if is_group else None
            conv_source_id = f"{prefix}_{jid}"

            cur = thyself.execute(
                """INSERT INTO conversations (source, source_id, is_group, group_name)
                   VALUES ('whatsapp', ?, ?, ?)""",
                (conv_source_id, is_group, group_name),
            )
            conv_id = cur.lastrowid
            session_to_conv[zpk] = conv_id
            total_convs += 1

            # For DMs, resolve or create contact
            if not is_group and phone:
                contact_id = None
                if phone in phone_map:
                    contact_id, existing_name = phone_map[phone]
                    # Update whatsapp_jid if not set
                    thyself.execute(
                        "UPDATE contacts SET whatsapp_jid = ? WHERE id = ? AND (whatsapp_jid IS NULL OR whatsapp_jid = '')",
                        (jid, contact_id),
                    )
                    total_contacts_updated += 1
                else:
                    contact_id = create_contact(thyself, phone, partner_name, jid)
                    phone_map[phone] = (contact_id, partner_name)
                    total_contacts_created += 1

                session_to_contact[zpk] = contact_id

                # Add conversation participant
                if contact_id:
                    thyself.execute(
                        "INSERT OR IGNORE INTO conversation_participants (conversation_id, contact_id) VALUES (?, ?)",
                        (conv_id, contact_id),
                    )
                    total_participants += 1

        print(f"  Created {total_convs} conversations")
        print(f"  Created {total_contacts_created} new contacts, updated {total_contacts_updated} existing")
        thyself.commit()

        # ── Build group member JID → contact_id map ──
        group_member_contacts = {}
        group_members = wa.execute("""
            SELECT gm.Z_PK, gm.ZMEMBERJID
            FROM ZWAGROUPMEMBER gm
            WHERE gm.ZMEMBERJID IS NOT NULL
        """).fetchall()
        for gm_pk, member_jid in group_members:
            member_phone = jid_to_phone(member_jid)
            if member_phone and member_phone in phone_map:
                group_member_contacts[member_jid] = phone_map[member_phone][0]

        # ── Load and insert messages in batches ──
        print(f"\n  Loading messages...")
        msg_cursor = wa.execute("""
            SELECT 
                m.Z_PK, m.ZCHATSESSION, m.ZISFROMME, m.ZMESSAGETYPE,
                m.ZMESSAGEDATE, m.ZSENTDATE, m.ZTEXT, m.ZSTANZAID,
                m.ZFROMJID, m.ZTOJID, m.ZGROUPMEMBER
            FROM ZWAMESSAGE m
            WHERE m.ZCHATSESSION IS NOT NULL
            ORDER BY m.ZMESSAGEDATE
        """)

        batch = []
        BATCH_SIZE = 5000
        msg_count = 0
        skipped = 0

        for row in msg_cursor:
            zpk, session_pk, is_from_me, msg_type, msg_date, sent_date, text, stanza_id, from_jid, to_jid, group_member_pk = row

            conv_id = session_to_conv.get(session_pk)
            if conv_id is None:
                skipped += 1
                continue

            # Determine contact_id
            contact_id = None
            if not is_from_me:
                # DM: use the session's contact
                contact_id = session_to_contact.get(session_pk)
                # Group: try from_jid
                if contact_id is None and from_jid:
                    if from_jid in group_member_contacts:
                        contact_id = group_member_contacts[from_jid]
                    else:
                        member_phone = jid_to_phone(from_jid)
                        if member_phone and member_phone in phone_map:
                            contact_id = phone_map[member_phone][0]
                            group_member_contacts[from_jid] = contact_id

            content_type = MSG_TYPE_MAP.get(msg_type, "other")
            sent_at = apple_ts_to_iso(msg_date)
            has_attachment = msg_type in ATTACHMENT_TYPES
            wc = word_count(text) if content_type in ("text",) else 0

            source_id = f"{prefix}_{stanza_id}" if stanza_id else f"{prefix}_zpk_{zpk}"

            batch.append((
                conv_id, contact_id, "whatsapp", source_id,
                is_from_me, text, content_type,
                sent_at, wc, has_attachment,
            ))

            if len(batch) >= BATCH_SIZE:
                thyself.executemany(
                    """INSERT INTO messages 
                       (conversation_id, contact_id, source, source_id, is_from_me, content, content_type, sent_at, word_count, has_attachment)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    batch,
                )
                thyself.commit()
                msg_count += len(batch)
                print(f"    {msg_count:>9,} messages inserted...")
                batch = []

        # Final batch
        if batch:
            thyself.executemany(
                """INSERT INTO messages 
                   (conversation_id, contact_id, source, source_id, is_from_me, content, content_type, sent_at, word_count, has_attachment)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                batch,
            )
            msg_count += len(batch)

        thyself.commit()
        total_msgs += msg_count
        print(f"    {msg_count:>9,} messages total ({skipped} skipped)")

        # ── Update conversation timestamps ──
        print("  Updating conversation timestamps...")
        thyself.execute("""
            UPDATE conversations SET
                created_at = (SELECT MIN(sent_at) FROM messages WHERE messages.conversation_id = conversations.id),
                last_message_at = (SELECT MAX(sent_at) FROM messages WHERE messages.conversation_id = conversations.id)
            WHERE source = 'whatsapp'
            AND id IN (SELECT DISTINCT conversation_id FROM messages WHERE source = 'whatsapp')
        """)

        # Update participant counts for groups
        thyself.execute("""
            UPDATE conversations SET
                participant_count = (
                    SELECT COUNT(DISTINCT contact_id) 
                    FROM messages 
                    WHERE messages.conversation_id = conversations.id 
                    AND contact_id IS NOT NULL
                )
            WHERE source = 'whatsapp' AND is_group = 1
        """)
        thyself.commit()

        wa.close()
        print(f"  Done with {label}.\n")

    # ── Final summary ──
    print(f"\n{'=' * 60}")
    print(f"IMPORT COMPLETE")
    print(f"{'=' * 60}")
    print(f"  Conversations:  {total_convs:,}")
    print(f"  Messages:       {total_msgs:,}")
    print(f"  Contacts created: {total_contacts_created:,}")
    print(f"  Contacts updated (JID): {total_contacts_updated:,}")
    print(f"  Participants linked: {total_participants:,}")
    print(f"\n  (Previous: {old_wa_conv_count:,} conversations, {old_wa_msg_count:,} messages)")

    # Quick verification
    new_count = thyself.execute("SELECT COUNT(*) FROM messages WHERE source='whatsapp'").fetchone()[0]
    date_range = thyself.execute(
        "SELECT MIN(sent_at), MAX(sent_at) FROM messages WHERE source='whatsapp'"
    ).fetchone()
    print(f"\n  Verified: {new_count:,} messages in thyself.db")
    print(f"  Date range: {date_range[0]} to {date_range[1]}")

    thyself.close()
    print("\nDone!")


if __name__ == "__main__":
    run_import()
