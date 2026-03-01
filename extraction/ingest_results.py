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


def ingest_extraction(result: dict, db_path: str | Path | None = None) -> int:
    """Ingest a single extraction result into the database.
    
    Handles both old month-based results ("month": "YYYY-MM") and
    new token-batched results ("period": "YYYY-MM-DD to YYYY-MM-DD").
    Returns the extraction_months.id for the inserted row.
    """
    db = Path(db_path) if db_path else DB_PATH
    conn = sqlite3.connect(db)
    try:
        month = result.get("period") or result.get("month")
        emotional = result.get("emotional_state", {})

        conn.execute(
            """INSERT OR REPLACE INTO extraction_months 
               (month, summary, emotional_overall, energy_level,
                emotional_indicators, stress_signals, joy_signals, raw_json)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                month,
                result.get("summary"),
                emotional.get("overall"),
                emotional.get("energy_level"),
                _json_dumps(emotional.get("indicators")),
                _json_dumps(emotional.get("stress_signals")),
                _json_dumps(emotional.get("joy_signals")),
                json.dumps(result, ensure_ascii=False),
            ),
        )

        month_id = conn.execute(
            "SELECT id FROM extraction_months WHERE month = ?", (month,)
        ).fetchone()[0]

        # Clear previous data for this month (in case of re-run)
        for table in [
            "extraction_people", "extraction_episodes", "extraction_relationships",
            "extraction_themes", "extraction_decisions", "extraction_tensions",
            "extraction_absences", "extraction_observations",
        ]:
            conn.execute(f"DELETE FROM {table} WHERE month_id = ?", (month_id,))

        for person in result.get("people", []):
            conn.execute(
                """INSERT OR IGNORE INTO extraction_people (month_id, canonical_name, aliases)
                   VALUES (?, ?, ?)""",
                (month_id, person["canonical_name"], _json_dumps(person.get("aliases"))),
            )

        for ep in result.get("episodes", []):
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

        for rel in result.get("relationships", []):
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

        for theme in result.get("themes", []):
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

        for dec in result.get("decisions", []):
            conn.execute(
                """INSERT INTO extraction_decisions 
                   (month_id, description, status, stakes, evidence)
                   VALUES (?, ?, ?, ?, ?)""",
                (month_id, dec["description"], dec.get("status"), dec.get("stakes"), dec.get("evidence")),
            )

        for tension in result.get("tensions", []):
            conn.execute(
                """INSERT INTO extraction_tensions (month_id, description, evidence)
                   VALUES (?, ?, ?)""",
                (month_id, tension["description"], _json_dumps(tension.get("evidence"))),
            )

        for absence in result.get("absences", []):
            conn.execute(
                """INSERT INTO extraction_absences (month_id, description) VALUES (?, ?)""",
                (month_id, absence["description"]),
            )

        for obs in result.get("raw_observations", []):
            conn.execute(
                """INSERT INTO extraction_observations (month_id, observation) VALUES (?, ?)""",
                (month_id, obs),
            )

        conn.commit()
        return month_id
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

    ids = []
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
        month_id = ingest_extraction(result, db)
        period = result.get("period") or result.get("month", f.stem)
        n_episodes = len(result.get("episodes", []))
        n_people = len(result.get("people", []))
        print(f"  Ingested {period}: {n_people} people, {n_episodes} episodes → id={month_id}")
        ids.append(month_id)

    return ids


if __name__ == "__main__":
    import sys

    filenames = sys.argv[1:] if len(sys.argv) > 1 else None
    ids = ingest_from_files(filenames)
    print(f"\nIngested {len(ids)} extractions into database")
