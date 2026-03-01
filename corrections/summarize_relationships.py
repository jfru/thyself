"""
Generate LLM relationship summaries for person identities.

For each person_identity with sufficient extraction data, assembles their
chronological relationship observations and sends them to Claude Opus
for a narrative summary.

Usage:
    python -m corrections.summarize_relationships              # summarize all eligible
    python -m corrections.summarize_relationships --min 5      # only 5+ months
    python -m corrections.summarize_relationships --limit 10   # only first 10
    python -m corrections.summarize_relationships --person Joel # specific person
    python -m corrections.summarize_relationships --dry        # preview without calling API
"""

import json
import os
import sys
import time
import sqlite3
from pathlib import Path

from dotenv import load_dotenv
load_dotenv()

import anthropic

from config import DB_PATH, SUBJECT_NAME, CLAUDE_MODEL, CLAUDE_BETA_FLAGS

MODEL = CLAUDE_MODEL
BETA_FLAGS = CLAUDE_BETA_FLAGS

SYSTEM_PROMPT = """\
You are summarizing a relationship between {subject} and one person, based on \
monthly observations extracted from {subject}'s personal communications (iMessage, WhatsApp, \
Gmail, ChatGPT) spanning {first_seen} to {last_seen}.

Each monthly observation includes:
- The person's role relative to {subject} that month
- A description of relationship quality/dynamics that month
- Notable exchanges or interactions

Write a concise relationship summary covering:
1. Who this person is and how they relate to {subject}
2. How the relationship evolved over time — what changed, what stayed constant
3. Key moments or exchanges that reveal the relationship's character
4. Where the relationship stands at the end of the observed period

For people who appear in many months (10+), write 1-2 substantial paragraphs.
For people who appear in fewer months (3-9), write 2-4 sentences.

Be specific — cite actual quotes or exchanges from the observations where they \
illustrate a pattern or turning point. Do not moralize or prescribe; describe.

{corrections_context}\
Return ONLY the summary text. No preamble, no JSON wrapping.\
"""


def get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def get_relationship_data(conn: sqlite3.Connection, pid: int) -> list[dict]:
    """Get chronological relationship observations for a person identity."""
    aliases = [r["alias"] for r in conn.execute(
        "SELECT alias FROM person_aliases WHERE person_identity_id = ?", (pid,)
    )]
    canonical = conn.execute(
        "SELECT canonical_name FROM person_identities WHERE id = ?", (pid,)
    ).fetchone()["canonical_name"]

    all_names = list(set(aliases + [canonical]))
    placeholders = ",".join("?" for _ in all_names)

    rows = conn.execute(f"""
        SELECT em.month, er.person, er.role, er.quality_this_month, er.notable_exchanges, er.sources
        FROM extraction_relationships er
        JOIN extraction_months em ON em.id = er.month_id
        WHERE er.person IN ({placeholders})
        ORDER BY em.month
    """, all_names).fetchall()

    return [dict(r) for r in rows]


def get_corrections_for_person(conn: sqlite3.Connection, canonical_name: str, aliases: list[str]) -> list[dict]:
    """Find corrections that reference this person."""
    all_names = set(aliases + [canonical_name])
    corrections = []
    for row in conn.execute("SELECT * FROM corrections"):
        target = (row["target"] or "").lower()
        original = (row["original_claim"] or "").lower()
        corrected = (row["corrected_claim"] or "").lower()
        for name in all_names:
            if name.lower() in target or name.lower() in original or name.lower() in corrected:
                corrections.append(dict(row))
                break
    return corrections


def build_user_message(canonical_name: str, observations: list[dict]) -> str:
    parts = [f"# Relationship: {SUBJECT_NAME} and {canonical_name}\n"]
    parts.append(f"{len(observations)} monthly observations:\n")

    for obs in observations:
        month = obs["month"]
        role = obs["role"] or "unknown"
        quality = obs["quality_this_month"] or "no description"
        exchanges = obs["notable_exchanges"]

        parts.append(f"## {month} — role: {role}")
        parts.append(quality)

        if exchanges:
            try:
                parsed = json.loads(exchanges)
                if parsed:
                    parts.append("Notable exchanges:")
                    for ex in parsed:
                        parts.append(f"  - {ex}")
            except (json.JSONDecodeError, TypeError):
                pass
        parts.append("")

    return "\n".join(parts)


def build_system_prompt(first_seen: str, last_seen: str, corrections: list[dict]) -> str:
    corrections_context = ""
    if corrections:
        corrections_context = "\nIMPORTANT CORRECTIONS to incorporate:\n"
        for c in corrections:
            corrections_context += f"- {c['correction_type']}: {c['corrected_claim']}\n"
        corrections_context += "\n"

    return SYSTEM_PROMPT.format(
        subject=SUBJECT_NAME,
        first_seen=first_seen,
        last_seen=last_seen,
        corrections_context=corrections_context,
    )


def summarize_person(
    client: anthropic.Anthropic,
    conn: sqlite3.Connection,
    pid: int,
    canonical_name: str,
    first_seen: str,
    last_seen: str,
) -> str | None:
    observations = get_relationship_data(conn, pid)
    if not observations:
        return None

    aliases = [r["alias"] for r in conn.execute(
        "SELECT alias FROM person_aliases WHERE person_identity_id = ?", (pid,)
    )]
    corrections = get_corrections_for_person(conn, canonical_name, aliases)

    system = build_system_prompt(first_seen, last_seen, corrections)
    user_msg = build_user_message(canonical_name, observations)

    t0 = time.time()
    raw_text = ""

    with client.beta.messages.stream(
        model=MODEL,
        max_tokens=16384,
        system=system,
        messages=[{"role": "user", "content": user_msg}],
        betas=BETA_FLAGS,
    ) as stream:
        for text in stream.text_stream:
            raw_text += text
        response = stream.get_final_message()

    elapsed = time.time() - t0
    in_tok = response.usage.input_tokens
    out_tok = response.usage.output_tokens
    print(f"    {canonical_name:30s} {in_tok:6,} in / {out_tok:4,} out  ({elapsed:.1f}s)")

    return raw_text.strip()


def run(min_months: int = 3, limit: int | None = None, person: str | None = None, dry_run: bool = False):
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key and not dry_run:
        print("ERROR: ANTHROPIC_API_KEY not set")
        sys.exit(1)

    conn = get_conn()
    client = anthropic.Anthropic(api_key=api_key) if not dry_run else None

    if person:
        persons = conn.execute("""
            SELECT id, canonical_name, first_seen, last_seen, months_seen
            FROM person_identities
            WHERE canonical_name = ? OR id IN (
                SELECT person_identity_id FROM person_aliases WHERE alias = ?
            )
        """, (person, person)).fetchall()
    else:
        query = """
            SELECT id, canonical_name, first_seen, last_seen, months_seen
            FROM person_identities
            WHERE months_seen >= ? AND relationship_summary IS NULL
            ORDER BY months_seen DESC
        """
        params = [min_months]
        if limit:
            query += " LIMIT ?"
            params.append(limit)
        persons = conn.execute(query, params).fetchall()

    print(f"\nRelationship Summary Pipeline")
    print(f"{'='*60}")
    print(f"  Model: {MODEL}")
    print(f"  People to summarize: {len(persons)}")
    print(f"  Min months: {min_months}")
    if dry_run:
        print(f"  DRY RUN — previewing only\n")

    total_in = 0
    total_out = 0
    summarized = 0

    for p in persons:
        pid = p["id"]
        name = p["canonical_name"]
        first = p["first_seen"] or "?"
        last = p["last_seen"] or "?"
        months = p["months_seen"] or 0

        if dry_run:
            obs = get_relationship_data(conn, pid)
            user_msg = build_user_message(name, obs)
            est_tokens = len(user_msg) // 4
            print(f"    {name:30s} {months:3d} months  ~{est_tokens:,} est. tokens  {first} → {last}")
            total_in += est_tokens
            continue

        summary = summarize_person(client, conn, pid, name, first, last)
        if summary:
            conn.execute(
                "UPDATE person_identities SET relationship_summary = ? WHERE id = ?",
                (summary, pid),
            )
            conn.commit()
            summarized += 1

    if dry_run:
        print(f"\n  Total estimated input: ~{total_in:,} tokens")
        est_cost = (total_in * 15 + len(persons) * 300 * 75) / 1_000_000
        print(f"  Estimated cost: ~${est_cost:.2f}")
    else:
        print(f"\n  Summarized: {summarized} / {len(persons)}")


def main():
    import argparse
    parser = argparse.ArgumentParser(description="Generate LLM relationship summaries")
    parser.add_argument("--min", type=int, default=3, help="Minimum months_seen threshold")
    parser.add_argument("--limit", type=int, help="Max people to summarize")
    parser.add_argument("--person", type=str, help="Summarize a specific person by name")
    parser.add_argument("--dry", action="store_true", help="Dry run — preview without calling API")
    args = parser.parse_args()
    run(min_months=args.min, limit=args.limit, person=args.person, dry_run=args.dry)


if __name__ == "__main__":
    main()
