"""
Ingest life extraction JSON results into the database tables.

Reads either from a dict (in-memory) or from saved JSON files,
and populates the extraction_* tables. After ingestion, verifies
message ID citations against source data to catch attribution errors.
"""

import json
import re
import sqlite3
from pathlib import Path

from config import DB_PATH, EXTRACTION_RESULTS_DIR
from .schema import create_tables

RESULTS_DIR = EXTRACTION_RESULTS_DIR

MSG_ID_PATTERN = re.compile(r"#([mcg])(\d+)")


def _json_dumps(obj) -> str | None:
    if obj is None:
        return None
    return json.dumps(obj, ensure_ascii=False)


def _extract_msg_ids(text: str | None) -> list[str]:
    """Parse all message ID citations (#m123, #c456, #g789) from a string."""
    if not text:
        return []
    return [f"#{m.group(1)}{m.group(2)}" for m in MSG_ID_PATTERN.finditer(text)]


def _extract_msg_ids_from_json_array(items: list | None) -> list[str]:
    """Parse message IDs from a JSON array of strings."""
    if not items:
        return []
    ids = []
    for item in items:
        if isinstance(item, str):
            ids.extend(_extract_msg_ids(item))
    return ids


def _ingest_single_month(conn: sqlite3.Connection, month: str, month_data: dict,
                         people: list[dict], raw_json: str) -> int:
    """Ingest one month's extraction into the database. Returns month_id."""
    emotional = month_data.get("emotional_state", {})

    conn.execute(
        """INSERT OR REPLACE INTO extraction_months 
           (month, summary, emotional_overall, energy_level,
            emotional_indicators, stress_signals, joy_signals, raw_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            month,
            month_data.get("summary"),
            emotional.get("overall"),
            emotional.get("energy_level"),
            _json_dumps(emotional.get("indicators")),
            _json_dumps(emotional.get("stress_signals")),
            _json_dumps(emotional.get("joy_signals")),
            raw_json,
        ),
    )

    month_id = conn.execute(
        "SELECT id FROM extraction_months WHERE month = ?", (month,)
    ).fetchone()[0]

    for table in [
        "extraction_people", "extraction_episodes", "extraction_relationships",
        "extraction_themes", "extraction_decisions", "extraction_tensions",
        "extraction_absences", "extraction_observations",
    ]:
        conn.execute(f"DELETE FROM {table} WHERE month_id = ?", (month_id,))

    for person in people:
        sample_ids = person.get("sample_msg_ids")
        conn.execute(
            """INSERT OR IGNORE INTO extraction_people (month_id, canonical_name, aliases, sample_msg_ids)
               VALUES (?, ?, ?, ?)""",
            (month_id, person["canonical_name"], _json_dumps(person.get("aliases")),
             _json_dumps(sample_ids)),
        )

    for ep in month_data.get("episodes", []):
        cited_ids = _extract_msg_ids_from_json_array(ep.get("key_evidence"))
        conn.execute(
            """INSERT INTO extraction_episodes 
               (month_id, name, description, status, people, emotional_tone, key_evidence, sources, source_msg_ids)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                month_id, ep["name"], ep.get("description"), ep.get("status"),
                _json_dumps(ep.get("people")), ep.get("emotional_tone"),
                _json_dumps(ep.get("key_evidence")), _json_dumps(ep.get("sources")),
                _json_dumps(cited_ids) if cited_ids else None,
            ),
        )

    for rel in month_data.get("relationships", []):
        cited_ids = _extract_msg_ids_from_json_array(rel.get("notable_exchanges"))
        conn.execute(
            """INSERT INTO extraction_relationships 
               (month_id, person, role, quality_this_month, notable_exchanges, sources, source_msg_ids)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (
                month_id, rel["person"], rel.get("role"),
                rel.get("quality_this_month"),
                _json_dumps(rel.get("notable_exchanges")),
                _json_dumps(rel.get("sources")),
                _json_dumps(cited_ids) if cited_ids else None,
            ),
        )

    for theme in month_data.get("themes", []):
        conn.execute(
            """INSERT INTO extraction_themes 
               (month_id, name, description, intensity, sources, cross_source_note)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (
                month_id, theme["name"], theme.get("description"),
                theme.get("intensity"), _json_dumps(theme.get("sources")),
                theme.get("cross_source_note"),
            ),
        )

    for dec in month_data.get("decisions", []):
        conn.execute(
            """INSERT INTO extraction_decisions 
               (month_id, description, status, stakes, evidence)
               VALUES (?, ?, ?, ?, ?)""",
            (month_id, dec["description"], dec.get("status"), dec.get("stakes"), dec.get("evidence")),
        )

    for tension in month_data.get("tensions", []):
        conn.execute(
            """INSERT INTO extraction_tensions (month_id, description, evidence)
               VALUES (?, ?, ?)""",
            (month_id, tension["description"], _json_dumps(tension.get("evidence"))),
        )

    for absence in month_data.get("absences", []):
        conn.execute(
            """INSERT INTO extraction_absences (month_id, description) VALUES (?, ?)""",
            (month_id, absence["description"]),
        )

    for obs in month_data.get("raw_observations", []):
        conn.execute(
            """INSERT INTO extraction_observations (month_id, observation) VALUES (?, ?)""",
            (month_id, obs),
        )

    return month_id


def _resolve_people_contacts(conn: sqlite3.Connection, month_id: int) -> None:
    """Auto-resolve extraction_people.contact_id using sample_msg_ids.

    For each person with sample_msg_ids, look up the cited messages and
    derive the contact_id from the source message's contact_id.
    """
    rows = conn.execute(
        "SELECT id, canonical_name, sample_msg_ids FROM extraction_people WHERE month_id = ? AND sample_msg_ids IS NOT NULL",
        (month_id,),
    ).fetchall()

    for person_id, canonical_name, sample_ids_json in rows:
        try:
            sample_ids = json.loads(sample_ids_json) if sample_ids_json else []
        except (json.JSONDecodeError, TypeError):
            continue

        contact_ids = set()
        for msg_id in sample_ids:
            m = MSG_ID_PATTERN.match(msg_id)
            if not m:
                continue
            source_type, rowid = m.group(1), int(m.group(2))
            if source_type == "m":
                row = conn.execute("SELECT contact_id FROM messages WHERE rowid = ?", (rowid,)).fetchone()
                if row and row[0]:
                    contact_ids.add(row[0])

        if len(contact_ids) == 1:
            contact_id = contact_ids.pop()
            conn.execute(
                "UPDATE extraction_people SET contact_id = ? WHERE id = ?",
                (contact_id, person_id),
            )


def verify_attributions(conn: sqlite3.Connection, month_id: int) -> list[dict]:
    """Verify that cited message IDs match the attributed person.

    Returns a list of mismatches found, each with details about the error.
    """
    contact_name_cache: dict[int, str] = {}

    def _get_contact_name(contact_id: int) -> str:
        if contact_id not in contact_name_cache:
            row = conn.execute(
                "SELECT display_name FROM contacts WHERE id = ?", (contact_id,)
            ).fetchone()
            contact_name_cache[contact_id] = row[0] if row else f"contact-{contact_id}"
        return contact_name_cache[contact_id]

    mismatches = []

    # Check extraction_relationships
    rels = conn.execute(
        "SELECT id, person, notable_exchanges, source_msg_ids FROM extraction_relationships WHERE month_id = ?",
        (month_id,),
    ).fetchall()

    for rel_id, person, notable_exchanges, source_msg_ids_json in rels:
        try:
            cited_ids = json.loads(source_msg_ids_json) if source_msg_ids_json else []
        except (json.JSONDecodeError, TypeError):
            continue

        for msg_id in cited_ids:
            m = MSG_ID_PATTERN.match(msg_id)
            if not m:
                continue
            source_type, rowid = m.group(1), int(m.group(2))
            if source_type != "m":
                continue

            row = conn.execute("SELECT contact_id, is_from_me FROM messages WHERE rowid = ?", (rowid,)).fetchone()
            if not row:
                continue
            contact_id, is_from_me = row
            if is_from_me or not contact_id:
                continue

            actual_name = _get_contact_name(contact_id)
            if person.lower() not in actual_name.lower() and actual_name.lower() not in person.lower():
                mismatches.append({
                    "type": "relationship_attribution",
                    "month_id": month_id,
                    "table": "extraction_relationships",
                    "row_id": rel_id,
                    "attributed_person": person,
                    "actual_contact": actual_name,
                    "actual_contact_id": contact_id,
                    "msg_id": msg_id,
                })

    # Check extraction_episodes
    eps = conn.execute(
        "SELECT id, name, people, source_msg_ids FROM extraction_episodes WHERE month_id = ?",
        (month_id,),
    ).fetchall()

    for ep_id, ep_name, people_json, source_msg_ids_json in eps:
        try:
            cited_ids = json.loads(source_msg_ids_json) if source_msg_ids_json else []
            people_list = json.loads(people_json) if people_json else []
        except (json.JSONDecodeError, TypeError):
            continue

        for msg_id in cited_ids:
            m = MSG_ID_PATTERN.match(msg_id)
            if not m:
                continue
            source_type, rowid = m.group(1), int(m.group(2))
            if source_type != "m":
                continue

            row = conn.execute("SELECT contact_id, is_from_me FROM messages WHERE rowid = ?", (rowid,)).fetchone()
            if not row:
                continue
            contact_id, is_from_me = row
            if is_from_me or not contact_id:
                continue

            actual_name = _get_contact_name(contact_id)
            name_matched = any(
                p.lower() in actual_name.lower() or actual_name.lower() in p.lower()
                for p in people_list
            )
            if not name_matched:
                mismatches.append({
                    "type": "episode_attribution",
                    "month_id": month_id,
                    "table": "extraction_episodes",
                    "row_id": ep_id,
                    "episode": ep_name,
                    "listed_people": people_list,
                    "actual_contact": actual_name,
                    "actual_contact_id": contact_id,
                    "msg_id": msg_id,
                })

    return mismatches


def ingest_extraction(result: dict, db_path: str | Path | None = None) -> list[int]:
    """Ingest an extraction result into the database.
    
    Handles three formats:
      - New per-month batched: {"months": [...], "people": [...]}
      - Old single-period batched: {"period": "...", "episodes": [...]}
      - Old monthly: {"month": "YYYY-MM", "episodes": [...]}
    
    Returns a list of extraction_months.id values for inserted rows.
    """
    db = Path(db_path) if db_path else DB_PATH
    conn = sqlite3.connect(db)
    try:
        raw_json = json.dumps(result, ensure_ascii=False)

        if "months" in result and isinstance(result["months"], list):
            people = result.get("people", [])
            ids = []
            for month_data in result["months"]:
                month = month_data["month"]
                month_id = _ingest_single_month(conn, month, month_data, people, raw_json)
                _resolve_people_contacts(conn, month_id)
                ids.append(month_id)
            conn.commit()

            all_mismatches = []
            for month_id in ids:
                all_mismatches.extend(verify_attributions(conn, month_id))
            if all_mismatches:
                _report_mismatches(all_mismatches)

            return ids
        else:
            month = result.get("month") or result.get("period")
            people = result.get("people", [])
            month_id = _ingest_single_month(conn, month, result, people, raw_json)
            _resolve_people_contacts(conn, month_id)
            conn.commit()

            mismatches = verify_attributions(conn, month_id)
            if mismatches:
                _report_mismatches(mismatches)

            return [month_id]
    finally:
        conn.close()


def _report_mismatches(mismatches: list[dict]) -> None:
    """Print attribution mismatches as warnings."""
    print(f"\n  ⚠ ATTRIBUTION MISMATCHES FOUND: {len(mismatches)}")
    for mm in mismatches:
        if mm["type"] == "relationship_attribution":
            print(
                f"    - extraction_relationships row {mm['row_id']}: "
                f"attributed to \"{mm['attributed_person']}\" but {mm['msg_id']} "
                f"is from \"{mm['actual_contact']}\" (contact_id={mm['actual_contact_id']})"
            )
        elif mm["type"] == "episode_attribution":
            print(
                f"    - extraction_episodes row {mm['row_id']} (\"{mm['episode']}\"): "
                f"{mm['msg_id']} is from \"{mm['actual_contact']}\" "
                f"but listed people are {mm['listed_people']}"
            )


def ingest_from_files(filenames: list[str] | None = None, db_path: str | Path | None = None) -> list[int]:
    """Ingest extraction results from saved JSON files.
    
    If filenames is None, ingest all batch_*.json files (or *.json if none exist).
    """
    db = Path(db_path) if db_path else DB_PATH
    create_tables(db)

    if filenames:
        files = [RESULTS_DIR / f for f in filenames]
    else:
        files = sorted(RESULTS_DIR.glob("batch_*.json"))
        if not files:
            files = sorted(RESULTS_DIR.glob("*.json"))

    all_ids = []
    for f in files:
        if not f.exists():
            print(f"  Skipping {f.name} — file not found")
            continue
        raw = f.read_text().strip()
        if raw.startswith("```"):
            raw = raw[raw.index("\n") + 1:]
        if raw.endswith("```"):
            raw = raw[:-3].rstrip()
        brace = raw.find("{")
        if brace > 0:
            raw = raw[brace:]
        result = json.loads(raw)
        ids = ingest_extraction(result, db)
        n_people = len(result.get("people", []))

        if "months" in result and isinstance(result["months"], list):
            months_list = [m["month"] for m in result["months"]]
            n_episodes = sum(len(m.get("episodes", [])) for m in result["months"])
            print(f"  Ingested {f.stem}: {n_people} people, {n_episodes} episodes across {len(months_list)} months → ids={ids}")
        else:
            period = result.get("period") or result.get("month", f.stem)
            n_episodes = len(result.get("episodes", []))
            print(f"  Ingested {period}: {n_people} people, {n_episodes} episodes → ids={ids}")

        all_ids.extend(ids)

    return all_ids


if __name__ == "__main__":
    import sys

    filenames = sys.argv[1:] if len(sys.argv) > 1 else None
    ids = ingest_from_files(filenames)
    print(f"\nIngested {len(ids)} extractions into database")
