"""
Orchestrate the full portrait-build pipeline from the Tauri app.

Runs extraction -> ingest -> synthesis -> ingest_synthesis in sequence,
writing progress to the portrait_runs table so the frontend can poll
for status updates.

Usage (invoked by the Tauri backend):
    python3 -u -m extraction.portrait_build --run-id 1 --db-path /path/to/thyself.db
"""

import json
import os
import signal
import sqlite3
import sys
import time
from pathlib import Path

from dotenv import load_dotenv
load_dotenv()

import anthropic

from config import (
    EXTRACTION_RESULTS_DIR, SYNTHESIS_RESULTS_DIR,
    SUBJECT_NAME, CLAUDE_MODEL, CLAUDE_BETA_FLAGS, DB_PATH as DEFAULT_DB_PATH,
)

_cancelled = False
_run_id: int | None = None
_db_path: Path | None = None


def _update_run(db: Path, run_id: int, **fields):
    """Update a portrait_runs row with the given fields."""
    conn = sqlite3.connect(db)
    try:
        sets = ", ".join(f"{k} = ?" for k in fields)
        vals = list(fields.values()) + [run_id]
        conn.execute(
            f"UPDATE portrait_runs SET updated_at = datetime('now'), {sets} WHERE id = ?",
            vals,
        )
        conn.commit()
    finally:
        conn.close()


def _handle_sigterm(signum, frame):
    """Handle SIGTERM for graceful cancellation."""
    global _cancelled
    _cancelled = True
    if _run_id and _db_path:
        try:
            _update_run(_db_path, _run_id,
                        status="cancelled",
                        finished_at=time.strftime("%Y-%m-%d %H:%M:%S"))
        except Exception:
            pass
    sys.exit(0)


signal.signal(signal.SIGTERM, _handle_sigterm)


def _check_cancelled():
    if _cancelled:
        raise SystemExit("Cancelled")


def run_portrait_build(run_id: int, db_path: Path):
    global _run_id, _db_path
    _run_id = run_id
    _db_path = db_path

    os.environ.setdefault("THYSELF_DATA_DIR", str(db_path.parent))

    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        _update_run(db_path, run_id, status="failed",
                     error_message="ANTHROPIC_API_KEY not set",
                     finished_at=time.strftime("%Y-%m-%d %H:%M:%S"))
        sys.exit(1)

    try:
        _run_pipeline(run_id, db_path, api_key)
    except SystemExit:
        raise
    except Exception as e:
        _update_run(db_path, run_id, status="failed",
                     error_message=str(e)[:2000],
                     finished_at=time.strftime("%Y-%m-%d %H:%M:%S"))
        print(f"FATAL: {e}", file=sys.stderr)
        sys.exit(1)


def _run_pipeline(run_id: int, db_path: Path, api_key: str):
    from .prepare import plan_batches
    from .run import run_all, RESULTS_DIR
    from .ingest_results import ingest_from_files
    from .synthesize import (
        _load_all_extractions, _plan_synthesis_batches,
        run_synthesis_batch, run_merge,
        SYNTHESIS_DIR,
    )
    from .ingest_synthesis import ingest_from_file
    from .schema import create_tables

    create_tables(db_path)

    # --- Phase 1: Prepare ---
    _update_run(db_path, run_id, phase="preparing")
    print("Phase: preparing")
    _check_cancelled()

    planned = plan_batches(db_path)
    total = len(planned)
    if total == 0:
        _update_run(db_path, run_id, status="failed",
                     error_message="No message data found to extract",
                     finished_at=time.strftime("%Y-%m-%d %H:%M:%S"))
        return

    months_covered = f"{planned[0].months[0]} to {planned[-1].months[-1]}"
    _update_run(db_path, run_id, phase="extracting",
                total_batches=total, completed_batches=0,
                extraction_months_covered=months_covered)
    print(f"Planned {total} extraction batches ({months_covered})")

    # --- Phase 2: Extract ---
    _check_cancelled()
    print("Phase: extracting")

    def _on_batch_done(completed: int, total_planned: int):
        _update_run(db_path, run_id, completed_batches=completed)
        _check_cancelled()

    results = run_all(db_path=db_path, on_batch_complete=_on_batch_done)
    _update_run(db_path, run_id, completed_batches=len(results))
    print(f"Extraction complete: {len(results)} batches")

    # --- Phase 3: Ingest extraction ---
    _check_cancelled()
    _update_run(db_path, run_id, phase="ingesting_extraction")
    print("Phase: ingesting_extraction")
    ingest_from_files(db_path=db_path)
    print("Extraction ingested")

    # --- Phase 4: Synthesize ---
    _check_cancelled()
    _update_run(db_path, run_id, phase="synthesizing")
    print("Phase: synthesizing")

    client = anthropic.Anthropic(api_key=api_key)
    extractions = _load_all_extractions()
    synthesis_batches = _plan_synthesis_batches(extractions)
    num_synth = len(synthesis_batches)
    _update_run(db_path, run_id, synthesis_batches=num_synth, synthesis_completed=0)
    print(f"Planned {num_synth} synthesis batches")

    for i, batch_extractions in enumerate(synthesis_batches, 1):
        _check_cancelled()
        run_synthesis_batch(client, i, batch_extractions, num_synth)
        _update_run(db_path, run_id, synthesis_completed=i)
        print(f"Synthesis batch {i}/{num_synth} complete")

    if num_synth > 1:
        _check_cancelled()
        run_merge(client, num_synth)
        print("Synthesis merge complete")
    else:
        src = SYNTHESIS_DIR / "synthesis_batch_1.json"
        dst = SYNTHESIS_DIR / "synthesis_merged.json"
        if src.exists():
            dst.write_text(src.read_text())

    # --- Phase 5: Ingest synthesis ---
    _check_cancelled()
    _update_run(db_path, run_id, phase="ingesting_synthesis")
    print("Phase: ingesting_synthesis")
    ingest_from_file(db_path=db_path)
    print("Synthesis ingested")

    # --- Build results summary ---
    conn = sqlite3.connect(db_path)
    try:
        summary = {}
        for table, key in [
            ("life_chapters", "life_chapters"),
            ("relationship_arcs", "relationship_arcs"),
            ("theme_evolution", "theme_evolution"),
            ("recurring_patterns", "recurring_patterns"),
            ("synthesis_contradictions", "contradictions"),
            ("turning_points", "turning_points"),
            ("person_portrait", "person_portrait"),
            ("extraction_months", "extraction_months"),
        ]:
            row = conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()
            summary[key] = row[0] if row else 0
        results_json = json.dumps(summary)
    finally:
        conn.close()

    _update_run(db_path, run_id, phase="completed", status="completed",
                results_summary=results_json,
                finished_at=time.strftime("%Y-%m-%d %H:%M:%S"))
    print(f"Portrait build complete: {results_json}")


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-id", type=int, required=True)
    parser.add_argument("--db-path", type=str, required=True)
    args = parser.parse_args()

    run_portrait_build(args.run_id, Path(args.db_path))
