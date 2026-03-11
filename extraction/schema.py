"""
Database schema for life extraction output.

Two sets of tables:
  Pass 1 (monthly) — structured observations extracted from each month's messages
  Pass 2 (synthesis) — longitudinal patterns synthesized across the full timeline

Array/list fields are stored as JSON strings in SQLite. These are analytical outputs
where the primary access pattern is read-whole-extraction, not query-individual-items.
"""

import sqlite3
from pathlib import Path

from config import DB_PATH

# ---------------------------------------------------------------------------
# Pass 1: Monthly extraction tables
# ---------------------------------------------------------------------------

MONTHLY_TABLES = """
-- One row per month processed. Stores the summary, emotional state, and raw JSON.
CREATE TABLE IF NOT EXISTS extraction_months (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    month TEXT NOT NULL UNIQUE,          -- 'YYYY-MM'
    summary TEXT,                        -- 2-3 sentence overview
    emotional_overall TEXT,              -- emotional weather description
    energy_level TEXT,                   -- low | moderate | high | manic
    emotional_indicators TEXT,           -- JSON array of specific observations
    stress_signals TEXT,                 -- JSON array
    joy_signals TEXT,                    -- JSON array
    raw_json TEXT,                       -- full LLM output for this month
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_extraction_months_month ON extraction_months(month);

-- People roster for each month. Tracks canonical names and aliases.
-- contact_id links to the existing contacts table once resolved.
CREATE TABLE IF NOT EXISTS extraction_people (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    month_id INTEGER NOT NULL REFERENCES extraction_months(id),
    canonical_name TEXT NOT NULL,
    aliases TEXT,                        -- JSON array of other names/handles
    contact_id INTEGER REFERENCES contacts(id),  -- NULL until resolved
    UNIQUE(month_id, canonical_name)
);

CREATE INDEX IF NOT EXISTS idx_extraction_people_month ON extraction_people(month_id);
CREATE INDEX IF NOT EXISTS idx_extraction_people_name ON extraction_people(canonical_name);
CREATE INDEX IF NOT EXISTS idx_extraction_people_contact ON extraction_people(contact_id);

-- Episodes: distinct life events, situations, or periods visible in a month.
CREATE TABLE IF NOT EXISTS extraction_episodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    month_id INTEGER NOT NULL REFERENCES extraction_months(id),
    name TEXT NOT NULL,
    description TEXT,
    status TEXT,                         -- new | ongoing | escalating | resolving | concluded
    people TEXT,                         -- JSON array of names
    emotional_tone TEXT,
    key_evidence TEXT,                   -- JSON array of quotes/observations
    sources TEXT                         -- JSON array of source names
);

CREATE INDEX IF NOT EXISTS idx_extraction_episodes_month ON extraction_episodes(month_id);
CREATE INDEX IF NOT EXISTS idx_extraction_episodes_status ON extraction_episodes(status);

-- Relationship observations per month.
CREATE TABLE IF NOT EXISTS extraction_relationships (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    month_id INTEGER NOT NULL REFERENCES extraction_months(id),
    person TEXT NOT NULL,
    role TEXT,                           -- brother, friend, partner, colleague, etc.
    quality_this_month TEXT,             -- description of dynamics
    notable_exchanges TEXT,              -- JSON array of brief descriptions
    sources TEXT                         -- JSON array
);

CREATE INDEX IF NOT EXISTS idx_extraction_rels_month ON extraction_relationships(month_id);
CREATE INDEX IF NOT EXISTS idx_extraction_rels_person ON extraction_relationships(person);

-- Themes: recurring preoccupations, interests, or concerns.
CREATE TABLE IF NOT EXISTS extraction_themes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    month_id INTEGER NOT NULL REFERENCES extraction_months(id),
    name TEXT NOT NULL,
    description TEXT,
    intensity TEXT,                      -- low | moderate | high | consuming
    sources TEXT,                        -- JSON array
    cross_source_note TEXT
);

CREATE INDEX IF NOT EXISTS idx_extraction_themes_month ON extraction_themes(month_id);
CREATE INDEX IF NOT EXISTS idx_extraction_themes_name ON extraction_themes(name);

-- Decisions and inflection points.
CREATE TABLE IF NOT EXISTS extraction_decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    month_id INTEGER NOT NULL REFERENCES extraction_months(id),
    description TEXT NOT NULL,
    status TEXT,                         -- contemplating | deciding | decided | deferred | avoided
    stakes TEXT,
    evidence TEXT
);

CREATE INDEX IF NOT EXISTS idx_extraction_decisions_month ON extraction_decisions(month_id);

-- Tensions and contradictions within a month.
CREATE TABLE IF NOT EXISTS extraction_tensions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    month_id INTEGER NOT NULL REFERENCES extraction_months(id),
    description TEXT NOT NULL,
    evidence TEXT                        -- JSON array
);

CREATE INDEX IF NOT EXISTS idx_extraction_tensions_month ON extraction_tensions(month_id);

-- Conspicuous absences and silences.
CREATE TABLE IF NOT EXISTS extraction_absences (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    month_id INTEGER NOT NULL REFERENCES extraction_months(id),
    description TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_extraction_absences_month ON extraction_absences(month_id);

-- Raw observations that didn't fit other categories.
CREATE TABLE IF NOT EXISTS extraction_observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    month_id INTEGER NOT NULL REFERENCES extraction_months(id),
    observation TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_extraction_observations_month ON extraction_observations(month_id);
"""

# ---------------------------------------------------------------------------
# Pass 2: Longitudinal synthesis tables
# ---------------------------------------------------------------------------

SYNTHESIS_TABLES = """
-- One row per synthesis run.
CREATE TABLE IF NOT EXISTS synthesis_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    months_covered TEXT,                 -- e.g. '2010-03 to 2026-02'
    raw_json TEXT,                       -- full LLM output
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Major life chapters (periods spanning months or years).
CREATE TABLE IF NOT EXISTS life_chapters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL REFERENCES synthesis_runs(id),
    name TEXT NOT NULL,
    start_month TEXT,                    -- YYYY-MM
    end_month TEXT,                      -- YYYY-MM
    description TEXT,
    defining_relationships TEXT,         -- JSON array of names
    defining_themes TEXT,                -- JSON array of theme names
    how_it_ended TEXT,
    source_evidence TEXT,                -- JSON array of quotes/references
    position INTEGER                     -- ordering among chapters
);

CREATE INDEX IF NOT EXISTS idx_life_chapters_run ON life_chapters(run_id);

-- How key relationships evolved over the full timeline.
CREATE TABLE IF NOT EXISTS relationship_arcs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL REFERENCES synthesis_runs(id),
    person TEXT NOT NULL,
    role TEXT,
    arc_summary TEXT,
    peak_period TEXT,
    current_status TEXT,
    defining_moments TEXT,              -- JSON array
    contact_id INTEGER REFERENCES contacts(id)
);

CREATE INDEX IF NOT EXISTS idx_relationship_arcs_run ON relationship_arcs(run_id);
CREATE INDEX IF NOT EXISTS idx_relationship_arcs_person ON relationship_arcs(person);

-- How major themes evolved across the full timeline.
CREATE TABLE IF NOT EXISTS theme_evolution (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL REFERENCES synthesis_runs(id),
    theme TEXT NOT NULL,
    trajectory TEXT,
    key_moments TEXT,                   -- JSON array
    source_evidence TEXT                -- JSON array
);

CREATE INDEX IF NOT EXISTS idx_theme_evolution_run ON theme_evolution(run_id);

-- Recurring behavioral or emotional patterns.
CREATE TABLE IF NOT EXISTS recurring_patterns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL REFERENCES synthesis_runs(id),
    pattern TEXT NOT NULL,
    instances TEXT,                      -- JSON array
    source_evidence TEXT                 -- JSON array
);

CREATE INDEX IF NOT EXISTS idx_recurring_patterns_run ON recurring_patterns(run_id);

-- Persistent contradictions between stated values and behavior.
CREATE TABLE IF NOT EXISTS synthesis_contradictions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL REFERENCES synthesis_runs(id),
    description TEXT NOT NULL,
    evidence TEXT,
    source_evidence TEXT                 -- JSON array
);

CREATE INDEX IF NOT EXISTS idx_synth_contradictions_run ON synthesis_contradictions(run_id);

-- The most significant moments or decisions across the timeline.
CREATE TABLE IF NOT EXISTS turning_points (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL REFERENCES synthesis_runs(id),
    month TEXT,                          -- YYYY-MM
    description TEXT NOT NULL,
    before_after TEXT,
    source_evidence TEXT                 -- JSON array
);

CREATE INDEX IF NOT EXISTS idx_turning_points_run ON turning_points(run_id);

-- Synthesized character portrait.
CREATE TABLE IF NOT EXISTS person_portrait (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL REFERENCES synthesis_runs(id),
    drives TEXT,
    fears TEXT,
    unnamed_wants TEXT,
    character_summary TEXT,
    source_evidence TEXT                 -- JSON array
);

CREATE INDEX IF NOT EXISTS idx_person_portrait_run ON person_portrait(run_id);
"""

# ---------------------------------------------------------------------------
# Corrections layer
# ---------------------------------------------------------------------------

CORRECTIONS_TABLES = """
-- Canonical person registry. Each row is one real human being.
-- This is the authority for person resolution across extraction and synthesis.
CREATE TABLE IF NOT EXISTS person_identities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    canonical_name TEXT NOT NULL UNIQUE,
    description TEXT,                    -- brief note: who they are, how they relate to Josh
    contact_id INTEGER REFERENCES contacts(id),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Maps names as they appear in extraction/synthesis output to canonical person IDs.
-- Multiple names can point to the same person (aliases).
-- Different people who share a name get separate entries with disambiguating context.
CREATE TABLE IF NOT EXISTS person_aliases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    person_identity_id INTEGER NOT NULL REFERENCES person_identities(id),
    alias TEXT NOT NULL,
    context TEXT,                        -- optional: where this alias appears, for disambiguation
    UNIQUE(alias, context)
);

CREATE INDEX IF NOT EXISTS idx_person_aliases_identity ON person_aliases(person_identity_id);
CREATE INDEX IF NOT EXISTS idx_person_aliases_alias ON person_aliases(alias);

-- Manual corrections to extraction or synthesis output.
CREATE TABLE IF NOT EXISTS corrections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    correction_type TEXT NOT NULL,       -- person_confusion | attribution_error | factual_error | dataset_caveat | framing_error
    layer TEXT NOT NULL,                 -- extraction | synthesis
    target TEXT,                         -- what's being corrected, e.g. "relationship_arcs.Emily Gardt", "person_portrait.character_summary"
    original_claim TEXT NOT NULL,        -- what the output says (or a representative excerpt)
    corrected_claim TEXT NOT NULL,       -- what it should say
    evidence TEXT,                       -- supporting evidence for the correction
    months_affected TEXT,                -- JSON array of YYYY-MM months where this applies
    status TEXT NOT NULL DEFAULT 'pending',  -- pending | applied
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_corrections_type ON corrections(correction_type);
CREATE INDEX IF NOT EXISTS idx_corrections_status ON corrections(status);
"""

# ---------------------------------------------------------------------------
# Migrations — run after initial table creation
# ---------------------------------------------------------------------------

MIGRATIONS = [
    # Migration 1: Add relationship metadata columns to person_identities
    """
    ALTER TABLE person_identities ADD COLUMN first_seen TEXT;
    """,
    """
    ALTER TABLE person_identities ADD COLUMN last_seen TEXT;
    """,
    """
    ALTER TABLE person_identities ADD COLUMN months_seen INTEGER;
    """,
    """
    ALTER TABLE person_identities ADD COLUMN roles TEXT;
    """,
    """
    ALTER TABLE person_identities ADD COLUMN sources TEXT;
    """,
    """
    ALTER TABLE person_identities ADD COLUMN relationship_summary TEXT;
    """,
    # Migration 2: Add source message ID tracking for attribution verification
    """
    ALTER TABLE extraction_relationships ADD COLUMN source_msg_ids TEXT;
    """,
    """
    ALTER TABLE extraction_episodes ADD COLUMN source_msg_ids TEXT;
    """,
    """
    ALTER TABLE extraction_people ADD COLUMN sample_msg_ids TEXT;
    """,
]


def create_tables(db_path: str | Path | None = None) -> None:
    """Create all life extraction tables in the database."""
    db = Path(db_path) if db_path else DB_PATH
    conn = sqlite3.connect(db)
    try:
        conn.executescript(MONTHLY_TABLES)
        conn.executescript(SYNTHESIS_TABLES)
        conn.executescript(CORRECTIONS_TABLES)
        conn.commit()
    finally:
        conn.close()


def run_migrations(db_path: str | Path | None = None) -> None:
    """Run ALTER TABLE migrations. Safe to call repeatedly — skips already-applied ones."""
    db = Path(db_path) if db_path else DB_PATH
    conn = sqlite3.connect(db)
    applied = 0
    skipped = 0
    try:
        for sql in MIGRATIONS:
            try:
                conn.execute(sql.strip())
                applied += 1
            except sqlite3.OperationalError as e:
                if "duplicate column name" in str(e):
                    skipped += 1
                else:
                    raise
        conn.commit()
        print(f"Migrations: {applied} applied, {skipped} already present")
    finally:
        conn.close()


if __name__ == "__main__":
    create_tables()
    run_migrations()
    print(f"Life extraction tables created/updated in {DB_PATH}")
