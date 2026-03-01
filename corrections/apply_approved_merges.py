"""
Apply user-approved person identity merges and contact links.

Reads approved changes from the CSV review and applies them to the database.
"""

import sqlite3
from pathlib import Path

from config import DB_PATH


def get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = OFF")
    return conn


def merge_person(conn, source_name: str, target_name: str, label: str):
    """Merge source person_identity into target. Adds source name as alias of target,
    moves aliases, deletes source."""
    target = conn.execute(
        "SELECT id, contact_id FROM person_identities WHERE canonical_name = ?",
        (target_name,),
    ).fetchone()
    source = conn.execute(
        "SELECT id, contact_id FROM person_identities WHERE canonical_name = ?",
        (source_name,),
    ).fetchone()

    if not target:
        print(f"  SKIP {label}: target '{target_name}' not found")
        return False
    if not source:
        print(f"  SKIP {label}: source '{source_name}' not found (may already be merged)")
        return False

    target_id = target["id"]
    source_id = source["id"]
    target_contact = target["contact_id"]

    existing_aliases = set()
    for row in conn.execute(
        "SELECT alias FROM person_aliases WHERE person_identity_id = ?", (target_id,)
    ):
        existing_aliases.add(row["alias"])

    if source_name not in existing_aliases:
        try:
            conn.execute(
                "INSERT INTO person_aliases (person_identity_id, alias, context) VALUES (?, ?, NULL)",
                (target_id, source_name),
            )
        except sqlite3.IntegrityError:
            pass

    source_aliases = conn.execute(
        "SELECT id, alias, context FROM person_aliases WHERE person_identity_id = ?",
        (source_id,),
    ).fetchall()

    for sa in source_aliases:
        if sa["alias"] not in existing_aliases:
            try:
                conn.execute(
                    "UPDATE person_aliases SET person_identity_id = ? WHERE id = ?",
                    (target_id, sa["id"]),
                )
                existing_aliases.add(sa["alias"])
            except sqlite3.IntegrityError:
                conn.execute("DELETE FROM person_aliases WHERE id = ?", (sa["id"],))
        else:
            conn.execute("DELETE FROM person_aliases WHERE id = ?", (sa["id"],))

    if target_contact:
        conn.execute(
            "UPDATE extraction_people SET contact_id = ? WHERE canonical_name = ? AND contact_id IS NULL",
            (target_contact, source_name),
        )

    conn.execute("DELETE FROM person_identities WHERE id = ?", (source_id,))
    print(f"  OK {label}: '{source_name}' → '{target_name}'")
    return True


def link_contact(conn, person_name: str, contact_id: int, label: str):
    """Link a person_identity to a contact."""
    person = conn.execute(
        "SELECT id FROM person_identities WHERE canonical_name = ?",
        (person_name,),
    ).fetchone()

    if not person:
        print(f"  SKIP {label}: '{person_name}' not found")
        return False

    conn.execute(
        "UPDATE person_identities SET contact_id = ? WHERE id = ?",
        (contact_id, person["id"]),
    )
    conn.execute(
        "UPDATE extraction_people SET contact_id = ? WHERE canonical_name = ? AND contact_id IS NULL",
        (contact_id, person_name),
    )

    aliases = [r["alias"] for r in conn.execute(
        "SELECT alias FROM person_aliases WHERE person_identity_id = ?", (person["id"],)
    )]
    for alias in aliases:
        conn.execute(
            "UPDATE extraction_people SET contact_id = ? WHERE canonical_name = ? AND contact_id IS NULL",
            (contact_id, alias),
        )

    print(f"  OK {label}: '{person_name}' → contact {contact_id}")
    return True


def main():
    conn = get_conn()

    before = conn.execute("SELECT COUNT(*) FROM person_identities").fetchone()[0]
    before_linked = conn.execute(
        "SELECT COUNT(*) FROM person_identities WHERE contact_id IS NOT NULL"
    ).fetchone()[0]

    print("=" * 60)
    print("  Applying Approved Merges")
    print("=" * 60)
    print(f"\n  Before: {before} person_identities ({before_linked} linked)\n")

    # GROUP A: Merge unresolved into existing resolved identity
    print("--- Group A: Merge into resolved identity ---")
    merges_a = [
        ("A1",  "Ilan Gould",              "Ilan"),
        ("A2",  "Steven Fruhman",           "Fruhman Stevan"),
        ("A4",  "Daniel Seal",              "Danny Seal"),
        ("A5",  "Davidi Neumann",           "Davidi"),
        ("A6",  "Tony Bill's Mate Minter",  "Tony"),
        ("A7",  "Les White",                "Les"),
        ("A8",  "Leslie White",             "Les"),
        ("A9",  "Bilal Qureshi",            "Bilal"),
        ("A10", "Benjamin Prevezer",        "Ben P"),
        ("A11", "Nevo Segal",               "Nevo"),
        ("A12", "Bria Selhorst",            "Bria"),
        ("A13", "Bria Cecilia",             "Bria"),
        ("A17", "Mike Le Roux",             "Michael Le Roux"),
        ("A18", "Dougal Johnston-Stewart",  "Dougal"),
        ("A26", "Sheryl Elias",             "Aunt Sheryl"),
        ("A27", "Reuven Leigh",             "Reuven"),
        ("A28", "Hil-La",                   "Hilla"),
        ("A29", "Tiburcio Sanz",            "Tibo"),
        ("A30", "Dr. Shadi Gholizadeh",     "Dr. Shadi"),
        ("A31", "Tim Shriver",              "Timothy Shriver"),
        ("A32", "Carrie Filipetti",         "Carrie"),
        ("A33", "Zoe Nightingale Wiseman",  "Zoe Nightingale"),
    ]
    for label, source, target in merges_a:
        merge_person(conn, source, target, label)

    # GROUP B: Merge two unresolved (same person)
    print("\n--- Group B: Merge unresolved duplicates ---")
    merge_person(conn, "Sam Winokur", "Samuel Winokur", "B1")
    # B2 (Mike Le Roux → Michael Le Roux) already handled in A17
    merge_person(conn, "Zac Newman", "Zac", "B3")

    conn.commit()

    # GROUP C: Link to contact
    print("\n--- Group C: Link to contact ---")
    links = [
        ("C1",  "Emily Vitar",     2423),
        ("C2",  "Tayfun",          2067),
        ("C3",  "Omer Solaki",     2058),
        ("C4",  "Josiah",          1754),
        ("C5",  "Romil",           2200),
        ("C6",  "David Minc",      1354),
        ("C7",  "Jesse Fron",      1940),
        ("C8",  "Jordan Winkler",  2566),
        ("C10", "Ruby",            1797),
    ]
    for label, name, cid in links:
        link_contact(conn, name, cid, label)

    # GROUP D: Approved links
    print("\n--- Group D: Approved links ---")
    link_contact(conn, "Bilal", 2222, "D3")

    conn.commit()

    # Report
    after = conn.execute("SELECT COUNT(*) FROM person_identities").fetchone()[0]
    after_linked = conn.execute(
        "SELECT COUNT(*) FROM person_identities WHERE contact_id IS NOT NULL"
    ).fetchone()[0]

    print(f"\n{'=' * 60}")
    print(f"  After: {after} person_identities ({after_linked} linked)")
    print(f"  Removed: {before - after} duplicates")
    print(f"  Newly linked: {after_linked - before_linked}")
    print(f"{'=' * 60}")

    conn.close()


if __name__ == "__main__":
    main()
