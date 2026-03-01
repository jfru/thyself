"""
Ingest life extraction JSON results into the database tables.

Reads either from a dict (in-memory) or from saved JSON files,
and populates the extraction_* tables.
"""

import json
import sqlite3
from pathlib import Path

from config import DB_PATH, EXTRACTION_RESULTS_DIR
from .schema import create_tables

RESULTS_DIR = EXTRACTION_RESULTS_DIR


def _json_dumps(obj) -> str | None:
    if obj is None:
        return None
    return json.dumps(obj, ensure_ascii=False)


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
        conn.execute(
            """INSERT OR IGNORE INTO extraction_people (month_id, canonical_name, aliases)
               VALUES (?, ?, ?)""",
            (month_id, person["canonical_name"], _json_dumps(person.get("aliases"))),
        )

    for ep in month_data.get("episodes", []):
        conn.execute(
            """INSERT INTO extraction_episodes 
               (month_id, name, description, status, people, emotional_tone, key_evidence, sources)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                month_id, ep["name"], ep.get("description"), ep.get("status"),
                _json_dumps(ep.get("people")), ep.get("emotional_tone"),
                _json_dumps(ep.get("key_evidence")), _json_dumps(ep.get("sources")),
            ),
        )

    for rel in month_data.get("relationships", []):
        conn.execute(
            """INSERT INTO extraction_relationships 
               (month_id, person, role, quality_this_month, notable_exchanges, sources)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (
                month_id, rel["person"], rel.get("role"),
                rel.get("quality_this_month"),
                _json_dumps(rel.get("notable_exchanges")),
                _json_dumps(rel.get("sources")),
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
                ids.append(month_id)
            conn.commit()
            return ids
        else:
            month = result.get("month") or result.get("period")
            people = result.get("people", [])
            month_id = _ingest_single_month(conn, month, result, people, raw_json)
            conn.commit()
            return [month_id]
    finally:
        conn.close()


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
