"""
Ingest synthesis JSON output into the database tables.

Reads the merged synthesis JSON and populates:
  synthesis_runs, life_chapters, relationship_arcs, theme_evolution,
  recurring_patterns, synthesis_contradictions, turning_points, person_portrait
"""

import json
import re
import sqlite3
from pathlib import Path

from config import DB_PATH, SYNTHESIS_RESULTS_DIR
from .schema import create_tables

SYNTHESIS_DIR = SYNTHESIS_RESULTS_DIR


def _json_dumps(obj) -> str | None:
    if obj is None:
        return None
    return json.dumps(obj, ensure_ascii=False)


def _parse_date_range(date_range: str) -> tuple[str | None, str | None]:
    """Extract start and end months from 'YYYY-MM to YYYY-MM'."""
    m = re.match(r"(\d{4}-\d{2})\s+to\s+(\d{4}-\d{2})", date_range or "")
    if m:
        return m.group(1), m.group(2)
    return None, None


def ingest_synthesis(result: dict, db_path: str | Path | None = None) -> int:
    """Ingest a synthesis result into the database. Returns the run_id."""
    db = Path(db_path) if db_path else DB_PATH
    create_tables(db)
    conn = sqlite3.connect(db)

    try:
        period = result.get("period", "unknown")

        cur = conn.execute(
            "INSERT INTO synthesis_runs (months_covered, raw_json) VALUES (?, ?)",
            (period, json.dumps(result, ensure_ascii=False)),
        )
        run_id = cur.lastrowid

        for i, ch in enumerate(result.get("life_chapters", [])):
            start, end = _parse_date_range(ch.get("date_range"))
            conn.execute(
                """INSERT INTO life_chapters
                   (run_id, name, start_month, end_month, description,
                    defining_relationships, defining_themes, how_it_ended,
                    source_evidence, position)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    run_id, ch["name"], start, end, ch.get("description"),
                    _json_dumps(ch.get("defining_relationships")),
                    _json_dumps(ch.get("defining_themes")),
                    ch.get("how_it_ended"),
                    _json_dumps(ch.get("source_evidence")),
                    i,
                ),
            )

        for arc in result.get("relationship_arcs", []):
            conn.execute(
                """INSERT INTO relationship_arcs
                   (run_id, person, role, arc_summary, peak_period,
                    current_status, defining_moments)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (
                    run_id, arc["person"], arc.get("role"),
                    arc.get("arc_summary"), arc.get("peak_period"),
                    arc.get("current_status"),
                    _json_dumps(arc.get("defining_moments")),
                ),
            )

        for te in result.get("theme_evolution", []):
            conn.execute(
                """INSERT INTO theme_evolution
                   (run_id, theme, trajectory, key_moments, source_evidence)
                   VALUES (?, ?, ?, ?, ?)""",
                (
                    run_id, te["theme"], te.get("trajectory"),
                    _json_dumps(te.get("key_moments")),
                    _json_dumps(te.get("source_evidence")),
                ),
            )

        for rp in result.get("recurring_patterns", []):
            conn.execute(
                """INSERT INTO recurring_patterns
                   (run_id, pattern, instances, source_evidence)
                   VALUES (?, ?, ?, ?)""",
                (
                    run_id, rp["pattern"],
                    _json_dumps(rp.get("instances")),
                    _json_dumps(rp.get("source_evidence")),
                ),
            )

        for c in result.get("contradictions", []):
            conn.execute(
                """INSERT INTO synthesis_contradictions
                   (run_id, description, evidence, source_evidence)
                   VALUES (?, ?, ?, ?)""",
                (
                    run_id, c["description"], c.get("evidence"),
                    _json_dumps(c.get("source_evidence")),
                ),
            )

        for tp in result.get("turning_points", []):
            conn.execute(
                """INSERT INTO turning_points
                   (run_id, month, description, before_after, source_evidence)
                   VALUES (?, ?, ?, ?, ?)""",
                (
                    run_id, tp.get("date"), tp["description"],
                    tp.get("before_after"),
                    _json_dumps(tp.get("source_evidence")),
                ),
            )

        person = result.get("the_person", {})
        if person:
            conn.execute(
                """INSERT INTO person_portrait
                   (run_id, drives, fears, unnamed_wants, character_summary, source_evidence)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                (
                    run_id, person.get("drives"), person.get("fears"),
                    person.get("unnamed_wants"), person.get("character_summary"),
                    _json_dumps(person.get("source_evidence")),
                ),
            )

        conn.commit()
        return run_id
    finally:
        conn.close()


def ingest_from_file(filename: str = "synthesis_merged.json", db_path: str | Path | None = None) -> int:
    """Load a synthesis JSON file and ingest it."""
    path = SYNTHESIS_DIR / filename
    raw = path.read_text().strip()
    if raw.startswith("```"):
        raw = raw[raw.index("\n") + 1:]
    if raw.endswith("```"):
        raw = raw[:-3].rstrip()
    result = json.loads(raw)
    run_id = ingest_synthesis(result, db_path)

    chapters = len(result.get("life_chapters", []))
    arcs = len(result.get("relationship_arcs", []))
    themes = len(result.get("theme_evolution", []))
    patterns = len(result.get("recurring_patterns", []))
    contradictions = len(result.get("contradictions", []))
    turning = len(result.get("turning_points", []))

    print(f"Ingested synthesis run_id={run_id}")
    print(f"  {chapters} life chapters")
    print(f"  {arcs} relationship arcs")
    print(f"  {themes} theme evolutions")
    print(f"  {patterns} recurring patterns")
    print(f"  {contradictions} contradictions")
    print(f"  {turning} turning points")
    print(f"  1 person portrait")

    return run_id


if __name__ == "__main__":
    import sys
    filename = sys.argv[1] if len(sys.argv) > 1 else "synthesis_merged.json"
    ingest_from_file(filename)
