"""
Resolve extraction names to canonical person identities.

Links extraction_people names to contacts via exact match, alias matching,
and deduplication, then creates person_identity rows for each unique person.

Usage:
    python -m corrections.resolve_persons          # run full resolution
    python -m corrections.resolve_persons --dry    # preview without writing
"""

import json
import re
import sqlite3
import sys
from collections import defaultdict
from pathlib import Path

from config import DB_PATH


def get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def _parse_aliases(aliases_json: str | None) -> list[str]:
    if not aliases_json:
        return []
    try:
        parsed = json.loads(aliases_json)
        return [a.strip() for a in parsed if isinstance(a, str) and a.strip()]
    except (json.JSONDecodeError, TypeError):
        return []


def _is_email(s: str) -> bool:
    return "@" in s and "." in s


def _is_phone(s: str) -> bool:
    return bool(re.match(r"^\+?\d[\d\s\-()]{6,}$", s.strip()))


def pass1_exact_match(conn: sqlite3.Connection) -> dict[str, int]:
    """Match extraction names to contacts by exact display_name (case-insensitive).
    Returns {canonical_name: contact_id} for unambiguous matches."""

    rows = conn.execute("""
        SELECT ep.canonical_name, c.id as contact_id, c.display_name,
               COUNT(DISTINCT c.id) as match_count
        FROM extraction_people ep
        JOIN contacts c ON LOWER(c.display_name) = LOWER(ep.canonical_name)
        GROUP BY ep.canonical_name
    """).fetchall()

    resolved = {}
    ambiguous = []
    for row in rows:
        if row["match_count"] == 1:
            resolved[row["canonical_name"]] = row["contact_id"]
        else:
            ambiguous.append(row["canonical_name"])

    print(f"  Pass 1 (exact match): {len(resolved)} resolved, {len(ambiguous)} ambiguous")
    return resolved


def pass2_alias_match(conn: sqlite3.Connection, already_resolved: dict[str, int]) -> dict[str, int]:
    """For unmatched extraction names, try matching via their aliases.
    Returns {canonical_name: contact_id} for newly matched names."""

    unmatched = conn.execute("""
        SELECT DISTINCT canonical_name, aliases
        FROM extraction_people
        WHERE canonical_name NOT IN ({})
    """.format(",".join("?" for _ in already_resolved)),
        list(already_resolved.keys()) if already_resolved else []
    ).fetchall() if already_resolved else conn.execute(
        "SELECT DISTINCT canonical_name, aliases FROM extraction_people"
    ).fetchall()

    contact_name_idx: dict[str, int] = {}
    for row in conn.execute("SELECT id, display_name FROM contacts WHERE display_name IS NOT NULL"):
        key = row["display_name"].strip().lower()
        if key and key not in contact_name_idx:
            contact_name_idx[key] = row["id"]

    alias_email_idx: dict[str, int] = {}
    for row in conn.execute("SELECT contact_id, alias_value FROM contact_aliases WHERE alias_type = 'email'"):
        alias_email_idx[row["alias_value"].strip().lower()] = row["contact_id"]

    alias_phone_idx: dict[str, int] = {}
    for row in conn.execute("SELECT contact_id, alias_value FROM contact_aliases WHERE alias_type = 'phone'"):
        cleaned = re.sub(r"[\s\-()]", "", row["alias_value"])
        alias_phone_idx[cleaned] = row["contact_id"]

    resolved = {}
    for row in unmatched:
        name = row["canonical_name"]
        if name in already_resolved:
            continue
        aliases = _parse_aliases(row["aliases"])
        found_id = None

        for alias in aliases:
            alias_lower = alias.strip().lower()
            if _is_email(alias):
                cid = alias_email_idx.get(alias_lower)
                if cid:
                    found_id = cid
                    break
            elif _is_phone(alias):
                cleaned = re.sub(r"[\s\-()]", "", alias)
                cid = alias_phone_idx.get(cleaned)
                if cid:
                    found_id = cid
                    break
            else:
                cid = contact_name_idx.get(alias_lower)
                if cid:
                    found_id = cid
                    break

        if found_id:
            resolved[name] = found_id

    print(f"  Pass 2 (alias match): {len(resolved)} resolved")
    return resolved


def pass3_dedup_and_create(
    conn: sqlite3.Connection,
    all_resolved: dict[str, int],
    dry_run: bool = False,
) -> dict[int, int]:
    """Group extraction names by contact_id, create person_identities, return {contact_id: person_identity_id}."""

    existing_persons = {}
    for row in conn.execute("SELECT id, canonical_name, contact_id FROM person_identities"):
        existing_persons[row["canonical_name"]] = row["id"]

    existing_aliases = set()
    for row in conn.execute("SELECT alias, context FROM person_aliases"):
        existing_aliases.add((row["alias"], row["context"]))

    by_contact: dict[int, list[str]] = defaultdict(list)
    for name, contact_id in all_resolved.items():
        by_contact[contact_id].append(name)

    name_freq: dict[str, int] = {}
    for row in conn.execute("""
        SELECT canonical_name, COUNT(DISTINCT month_id) as months
        FROM extraction_people GROUP BY canonical_name
    """):
        name_freq[row["canonical_name"]] = row["months"]

    contact_id_to_pid: dict[int, int] = {}
    created = 0
    merged = 0

    for contact_id, names in by_contact.items():
        best_name = max(names, key=lambda n: name_freq.get(n, 0))

        contact_row = conn.execute(
            "SELECT display_name, first_name, last_name FROM contacts WHERE id = ?",
            (contact_id,),
        ).fetchone()
        display = contact_row["display_name"] if contact_row else best_name

        if best_name in existing_persons:
            pid = existing_persons[best_name]
            if not dry_run:
                conn.execute(
                    "UPDATE person_identities SET contact_id = ? WHERE id = ? AND contact_id IS NULL",
                    (contact_id, pid),
                )
            contact_id_to_pid[contact_id] = pid
            merged += 1
        elif display and display in existing_persons:
            pid = existing_persons[display]
            if not dry_run:
                conn.execute(
                    "UPDATE person_identities SET contact_id = ? WHERE id = ? AND contact_id IS NULL",
                    (contact_id, pid),
                )
            contact_id_to_pid[contact_id] = pid
            merged += 1
        else:
            if dry_run:
                contact_id_to_pid[contact_id] = -1
                created += 1
                continue

            try:
                conn.execute(
                    "INSERT INTO person_identities (canonical_name, contact_id) VALUES (?, ?)",
                    (best_name, contact_id),
                )
            except sqlite3.IntegrityError:
                conn.execute(
                    "INSERT INTO person_identities (canonical_name, contact_id) VALUES (?, ?)",
                    (f"{best_name} (contact {contact_id})", contact_id),
                )
            pid = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
            existing_persons[best_name] = pid
            contact_id_to_pid[contact_id] = pid
            created += 1

        if not dry_run:
            pid = contact_id_to_pid[contact_id]
            all_aliases_for_person = set(names)
            for n in names:
                for a in _get_extraction_aliases(conn, n):
                    if not _is_email(a) and not _is_phone(a):
                        all_aliases_for_person.add(a)

            for alias in all_aliases_for_person:
                if (alias, None) not in existing_aliases:
                    try:
                        conn.execute(
                            "INSERT INTO person_aliases (person_identity_id, alias, context) VALUES (?, ?, NULL)",
                            (pid, alias),
                        )
                        existing_aliases.add((alias, None))
                    except sqlite3.IntegrityError:
                        pass

    if not dry_run:
        for name, contact_id in all_resolved.items():
            conn.execute(
                "UPDATE extraction_people SET contact_id = ? WHERE canonical_name = ? AND contact_id IS NULL",
                (contact_id, name),
            )

    print(f"  Pass 3 (dedup): {created} person_identities created, {merged} merged with existing")
    return contact_id_to_pid


def _get_extraction_aliases(conn: sqlite3.Connection, canonical_name: str) -> list[str]:
    """Get all unique aliases for a canonical_name across all months."""
    all_aliases = set()
    for row in conn.execute(
        "SELECT aliases FROM extraction_people WHERE canonical_name = ?",
        (canonical_name,),
    ):
        for a in _parse_aliases(row["aliases"]):
            all_aliases.add(a)
    return list(all_aliases)


def pass4_unresolved(
    conn: sqlite3.Connection,
    all_resolved: dict[str, int],
    min_months: int = 2,
    dry_run: bool = False,
) -> int:
    """Create person_identities for unresolved names appearing in min_months+ months."""

    existing_persons = set()
    for row in conn.execute("SELECT canonical_name FROM person_identities"):
        existing_persons.add(row["canonical_name"])

    existing_aliases_set = set()
    for row in conn.execute("SELECT alias, context FROM person_aliases"):
        existing_aliases_set.add((row["alias"], row["context"]))

    unresolved = conn.execute("""
        SELECT canonical_name, COUNT(DISTINCT month_id) as months
        FROM extraction_people
        WHERE canonical_name NOT IN ({})
        GROUP BY canonical_name
        HAVING months >= ?
        ORDER BY months DESC
    """.format(",".join("?" for _ in all_resolved)),
        list(all_resolved.keys()) + [min_months] if all_resolved else [min_months]
    ).fetchall() if all_resolved else conn.execute("""
        SELECT canonical_name, COUNT(DISTINCT month_id) as months
        FROM extraction_people
        GROUP BY canonical_name
        HAVING months >= ?
        ORDER BY months DESC
    """, (min_months,)).fetchall()

    created = 0
    for row in unresolved:
        name = row["canonical_name"]
        if name in existing_persons or name in all_resolved:
            continue

        if dry_run:
            created += 1
            continue

        try:
            conn.execute(
                "INSERT INTO person_identities (canonical_name) VALUES (?)",
                (name,),
            )
        except sqlite3.IntegrityError:
            continue

        pid = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
        existing_persons.add(name)
        created += 1

        if (name, None) not in existing_aliases_set:
            try:
                conn.execute(
                    "INSERT INTO person_aliases (person_identity_id, alias, context) VALUES (?, ?, NULL)",
                    (pid, name),
                )
                existing_aliases_set.add((name, None))
            except sqlite3.IntegrityError:
                pass

        for a in _get_extraction_aliases(conn, name):
            if not _is_email(a) and not _is_phone(a) and (a, None) not in existing_aliases_set:
                try:
                    conn.execute(
                        "INSERT INTO person_aliases (person_identity_id, alias, context) VALUES (?, ?, NULL)",
                        (pid, a),
                    )
                    existing_aliases_set.add((a, None))
                except sqlite3.IntegrityError:
                    pass

    print(f"  Pass 4 (unresolved, {min_months}+ months): {created} person_identities created")
    return created


def aggregate_structured(conn: sqlite3.Connection) -> int:
    """Compute first_seen, last_seen, months_seen, roles, sources for each person_identity."""

    persons = conn.execute("SELECT id, canonical_name FROM person_identities").fetchall()
    updated = 0

    for person in persons:
        pid = person["id"]
        aliases = [r["alias"] for r in conn.execute(
            "SELECT alias FROM person_aliases WHERE person_identity_id = ?", (pid,)
        )]

        if not aliases:
            aliases = [person["canonical_name"]]

        placeholders = ",".join("?" for _ in aliases)
        rows = conn.execute(f"""
            SELECT em.month, er.role, er.sources
            FROM extraction_relationships er
            JOIN extraction_months em ON em.id = er.month_id
            WHERE er.person IN ({placeholders})
            ORDER BY em.month
        """, aliases).fetchall()

        if not rows:
            ep_rows = conn.execute(f"""
                SELECT DISTINCT em.month
                FROM extraction_people ep
                JOIN extraction_months em ON em.id = ep.month_id
                WHERE ep.canonical_name IN ({placeholders})
                ORDER BY em.month
            """, aliases).fetchall()
            if ep_rows:
                months = [r["month"] for r in ep_rows]
                conn.execute("""
                    UPDATE person_identities 
                    SET first_seen = ?, last_seen = ?, months_seen = ?
                    WHERE id = ?
                """, (months[0], months[-1], len(set(months)), pid))
                updated += 1
            continue

        months = sorted(set(r["month"] for r in rows))
        all_roles = set()
        all_sources = set()
        for r in rows:
            if r["role"]:
                all_roles.add(r["role"])
            if r["sources"]:
                try:
                    for s in json.loads(r["sources"]):
                        all_sources.add(s)
                except (json.JSONDecodeError, TypeError):
                    all_sources.add(r["sources"])

        conn.execute("""
            UPDATE person_identities 
            SET first_seen = ?, last_seen = ?, months_seen = ?,
                roles = ?, sources = ?
            WHERE id = ?
        """, (
            months[0], months[-1], len(months),
            json.dumps(sorted(all_roles), ensure_ascii=False) if all_roles else None,
            json.dumps(sorted(all_sources), ensure_ascii=False) if all_sources else None,
            pid,
        ))
        updated += 1

    print(f"  Aggregation: {updated} person_identities updated with structured data")
    return updated


def print_report(conn: sqlite3.Connection) -> None:
    total = conn.execute("SELECT COUNT(*) FROM person_identities").fetchone()[0]
    with_contact = conn.execute(
        "SELECT COUNT(*) FROM person_identities WHERE contact_id IS NOT NULL"
    ).fetchone()[0]
    without_contact = total - with_contact
    with_summary = conn.execute(
        "SELECT COUNT(*) FROM person_identities WHERE relationship_summary IS NOT NULL"
    ).fetchone()[0]

    print(f"\n{'='*60}")
    print(f"  Resolution Report")
    print(f"{'='*60}")
    print(f"  Total person identities: {total}")
    print(f"    Linked to contacts: {with_contact}")
    print(f"    Unlinked: {without_contact}")
    print(f"    With relationship summary: {with_summary}")

    print(f"\n  Top 20 by months seen:")
    for row in conn.execute("""
        SELECT canonical_name, months_seen, contact_id, roles, first_seen, last_seen
        FROM person_identities
        WHERE months_seen IS NOT NULL
        ORDER BY months_seen DESC
        LIMIT 20
    """):
        linked = f" [contact #{row['contact_id']}]" if row["contact_id"] else " [unlinked]"
        roles = row["roles"] or ""
        span = f"{row['first_seen']} → {row['last_seen']}" if row["first_seen"] else ""
        print(f"    {row['canonical_name']:30s} {row['months_seen']:3d} months  {span:20s}{linked}")

    print(f"\n  Top 20 unlinked by frequency:")
    for row in conn.execute("""
        SELECT canonical_name, months_seen, first_seen, last_seen
        FROM person_identities
        WHERE contact_id IS NULL AND months_seen IS NOT NULL
        ORDER BY months_seen DESC
        LIMIT 20
    """):
        span = f"{row['first_seen']} → {row['last_seen']}" if row["first_seen"] else ""
        print(f"    {row['canonical_name']:30s} {row['months_seen']:3d} months  {span}")


def run(dry_run: bool = False) -> None:
    conn = get_conn()
    try:
        print("Person Resolution Pipeline")
        print("=" * 60)

        resolved_p1 = pass1_exact_match(conn)
        resolved_p2 = pass2_alias_match(conn, resolved_p1)

        all_resolved = {**resolved_p1, **resolved_p2}
        print(f"  Total resolved: {len(all_resolved)} of 2,133 extraction names")

        pass3_dedup_and_create(conn, all_resolved, dry_run=dry_run)
        pass4_unresolved(conn, all_resolved, min_months=2, dry_run=dry_run)

        if not dry_run:
            conn.commit()
            print("\n  Computing structured aggregation...")
            aggregate_structured(conn)
            conn.commit()

        print_report(conn)
    finally:
        conn.close()


def main():
    dry_run = "--dry" in sys.argv
    if dry_run:
        print("DRY RUN — no changes will be written\n")
    run(dry_run=dry_run)


if __name__ == "__main__":
    main()
