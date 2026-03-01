"""
Populate the contacts table in thyself.db by matching phone/email aliases
against macOS Contacts and the annotated contacts CSV from the
relationship-graph project.

Two sources:
  1. macOS AddressBook — real names from the phone's contacts
  2. contacts_for_annotation.csv — manually labelled names from prior project
"""

import csv
import re
import sqlite3
from pathlib import Path

from config import DB_PATH as THYSELF_DB, MACOS_CONTACTS_DB, CONTACTS_ANNOTATION_CSV

CONTACTS_DB = Path(MACOS_CONTACTS_DB) if MACOS_CONTACTS_DB else None
ANNOTATION_CSV = Path(CONTACTS_ANNOTATION_CSV) if CONTACTS_ANNOTATION_CSV else None


def normalize_phone(phone: str) -> str | None:
    if not phone:
        return None
    digits = re.sub(r"\D", "", phone)
    if len(digits) == 10:
        return f"+1{digits}"
    if len(digits) == 11 and digits[0] in "14":
        return f"+{digits}"
    if len(digits) == 12 and digits.startswith("44"):
        return f"+{digits}"
    return f"+{digits}" if digits else None


def load_macos_contacts() -> tuple[dict, dict]:
    """Read macOS AddressBook. Returns (phone_to_info, email_to_info)."""
    if not CONTACTS_DB.exists():
        print(f"  macOS Contacts DB not found at {CONTACTS_DB}")
        return {}, {}

    conn = sqlite3.connect(f"file:{CONTACTS_DB}?mode=ro", uri=True)

    rows = conn.execute("""
        SELECT r.ZFIRSTNAME, r.ZLASTNAME, r.ZORGANIZATION, r.ZNICKNAME, p.ZFULLNUMBER
        FROM ZABCDRECORD r
        JOIN ZABCDPHONENUMBER p ON r.Z_PK = p.ZOWNER
        WHERE p.ZFULLNUMBER IS NOT NULL
    """).fetchall()

    phone_map = {}
    for first, last, org, nick, phone in rows:
        norm = normalize_phone(phone)
        if not norm:
            continue
        parts = [p for p in [first, last] if p]
        display = " ".join(parts) if parts else (org or nick)
        if display:
            phone_map[norm] = {
                "display_name": display,
                "first_name": first,
                "last_name": last,
                "organization": org,
            }

    rows = conn.execute("""
        SELECT r.ZFIRSTNAME, r.ZLASTNAME, r.ZORGANIZATION, e.ZADDRESS
        FROM ZABCDRECORD r
        JOIN ZABCDEMAILADDRESS e ON r.Z_PK = e.ZOWNER
        WHERE e.ZADDRESS IS NOT NULL
    """).fetchall()

    email_map = {}
    for first, last, org, email in rows:
        if not email:
            continue
        parts = [p for p in [first, last] if p]
        display = " ".join(parts) if parts else org
        if display:
            email_map[email.lower().strip()] = {
                "display_name": display,
                "first_name": first,
                "last_name": last,
                "organization": org,
            }

    conn.close()
    print(f"  macOS Contacts: {len(phone_map)} phone mappings, {len(email_map)} email mappings")
    return phone_map, email_map


def load_annotation_csv() -> dict:
    """Load name mappings from the annotated CSV. Returns {phone: info, ...}."""
    if not ANNOTATION_CSV.exists():
        print(f"  Annotation CSV not found at {ANNOTATION_CSV}")
        return {}

    mapping = {}
    with open(ANNOTATION_CSV) as f:
        for row in csv.DictReader(f):
            phone = row.get("phone", "").strip()
            name = row.get("name", "").strip()
            if phone and name:
                norm = normalize_phone(phone)
                if norm:
                    parts = name.split(None, 1)
                    mapping[norm] = {
                        "display_name": name,
                        "first_name": parts[0] if parts else name,
                        "last_name": parts[1] if len(parts) > 1 else None,
                        "relationship_type": row.get("relationship_type", "").strip() or None,
                        "organization": row.get("organization", "").strip() or None,
                        "location": row.get("location", "").strip() or None,
                        "notes": row.get("notes", "").strip() or None,
                    }

    print(f"  Annotation CSV: {len(mapping)} phone mappings")
    return mapping


def populate_contacts(db_path: str | Path | None = None) -> None:
    """Match contact_aliases against name sources and populate contacts table."""
    db = Path(db_path) if db_path else THYSELF_DB
    conn = sqlite3.connect(db)

    print("Loading name sources...")
    phone_map, email_map = load_macos_contacts()
    csv_map = load_annotation_csv()

    aliases = conn.execute(
        "SELECT contact_id, alias_type, alias_value FROM contact_aliases"
    ).fetchall()

    # Group aliases by contact_id
    contact_aliases: dict[int, list[tuple[str, str]]] = {}
    for cid, atype, aval in aliases:
        contact_aliases.setdefault(cid, []).append((atype, aval))

    print(f"\nMatching {len(contact_aliases)} contacts...")

    inserted = 0
    matched_macos = 0
    matched_csv = 0

    for contact_id, alias_list in contact_aliases.items():
        info = None
        source = None

        for atype, aval in alias_list:
            if atype == "phone":
                norm = normalize_phone(aval)
                if norm and norm in phone_map:
                    info = phone_map[norm]
                    source = "macos"
                    break
            elif atype == "email":
                email = aval.lower().strip()
                if email in email_map:
                    info = email_map[email]
                    source = "macos"
                    break

        if not info:
            for atype, aval in alias_list:
                if atype == "phone":
                    norm = normalize_phone(aval)
                    if norm and norm in csv_map:
                        info = csv_map[norm]
                        source = "csv"
                        break

        if not info:
            # Use the raw alias as a fallback display name
            phone_alias = next((v for t, v in alias_list if t == "phone"), None)
            info = {"display_name": phone_alias, "first_name": None, "last_name": None}

        phone_val = next((v for t, v in alias_list if t == "phone"), None)
        email_val = next((v for t, v in alias_list if t == "email"), None)

        conn.execute(
            """INSERT OR REPLACE INTO contacts 
               (id, display_name, first_name, last_name, phone, email,
                relationship_type, organization, location, notes)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                contact_id,
                info.get("display_name"),
                info.get("first_name"),
                info.get("last_name"),
                phone_val,
                email_val,
                info.get("relationship_type"),
                info.get("organization"),
                info.get("location"),
                info.get("notes"),
            ),
        )
        inserted += 1
        if source == "macos":
            matched_macos += 1
        elif source == "csv":
            matched_csv += 1

    conn.commit()

    total_named = conn.execute(
        "SELECT COUNT(*) FROM contacts WHERE first_name IS NOT NULL"
    ).fetchone()[0]

    print(f"\nResults:")
    print(f"  {inserted} contacts created")
    print(f"  {matched_macos} matched from macOS Contacts")
    print(f"  {matched_csv} matched from annotation CSV")
    print(f"  {total_named} have real names")
    print(f"  {inserted - total_named} have phone number as display name (unresolved)")

    # Show top contacts by message volume
    print("\nTop contacts by message volume:")
    rows = conn.execute("""
        SELECT c.display_name, c.phone, COUNT(m.id) as msgs
        FROM contacts c
        JOIN messages m ON m.contact_id = c.id
        GROUP BY c.id
        ORDER BY msgs DESC
        LIMIT 15
    """).fetchall()
    for name, phone, msgs in rows:
        print(f"  {name or '?':<25} {phone or '':<16} {msgs:>6} msgs")

    conn.close()


if __name__ == "__main__":
    populate_contacts()
