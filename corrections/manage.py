"""
Manage corrections to life extraction and synthesis output.

Usage:
    python -m corrections.manage persons                      # list all person identities
    python -m corrections.manage persons add NAME [--desc D]  # register a person
    python -m corrections.manage persons alias NAME ALIAS     # add alias for a person
    python -m corrections.manage persons audit                # scan extractions for ambiguous names

    python -m corrections.manage list                         # list all corrections
    python -m corrections.manage add TYPE LAYER               # add a correction (interactive)
    python -m corrections.manage report                       # full corrections report

    python -m corrections.manage seed                         # seed known corrections
"""

import argparse
import json
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


# ---------------------------------------------------------------------------
# Person identity management
# ---------------------------------------------------------------------------

def person_add(name: str, description: str | None = None, contact_id: int | None = None) -> int:
    conn = get_conn()
    try:
        conn.execute(
            "INSERT INTO person_identities (canonical_name, description, contact_id) VALUES (?, ?, ?)",
            (name, description, contact_id),
        )
        pid = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
        existing = conn.execute(
            "SELECT id FROM person_aliases WHERE alias = ? AND (context IS NULL OR context = '')",
            (name,),
        ).fetchone()
        if not existing:
            conn.execute(
                "INSERT INTO person_aliases (person_identity_id, alias, context) VALUES (?, ?, NULL)",
                (pid, name),
            )
        conn.commit()
        return pid
    finally:
        conn.close()


def person_alias_add(canonical_name: str, alias: str, context: str | None = None) -> None:
    conn = get_conn()
    try:
        row = conn.execute(
            "SELECT id FROM person_identities WHERE canonical_name = ?", (canonical_name,)
        ).fetchone()
        if not row:
            print(f"ERROR: No person identity found for '{canonical_name}'")
            print("  Registered identities:")
            for r in conn.execute("SELECT canonical_name FROM person_identities ORDER BY canonical_name"):
                print(f"    - {r[0]}")
            sys.exit(1)
        if context is None:
            existing = conn.execute(
                "SELECT id FROM person_aliases WHERE alias = ? AND context IS NULL",
                (alias,),
            ).fetchone()
        else:
            existing = conn.execute(
                "SELECT id FROM person_aliases WHERE alias = ? AND context = ?",
                (alias, context),
            ).fetchone()
        if not existing:
            conn.execute(
                "INSERT INTO person_aliases (person_identity_id, alias, context) VALUES (?, ?, ?)",
                (row[0], alias, context),
            )
        conn.commit()
    finally:
        conn.close()


def person_list() -> None:
    conn = get_conn()
    rows = conn.execute("""
        SELECT pi.id, pi.canonical_name, pi.description,
               GROUP_CONCAT(pa.alias, ', ') as aliases
        FROM person_identities pi
        LEFT JOIN person_aliases pa ON pa.person_identity_id = pi.id
        GROUP BY pi.id
        ORDER BY pi.canonical_name
    """).fetchall()
    conn.close()

    if not rows:
        print("No person identities registered yet. Use 'persons add' or 'seed'.")
        return

    print(f"\n{'='*70}")
    print(f"  Person Identities ({len(rows)} registered)")
    print(f"{'='*70}")
    for row in rows:
        aliases = row["aliases"] or ""
        alias_list = [a.strip() for a in aliases.split(",") if a.strip() != row["canonical_name"]]
        desc = f"  — {row['description']}" if row["description"] else ""
        print(f"\n  [{row['id']:3d}] {row['canonical_name']}{desc}")
        if alias_list:
            print(f"        aliases: {', '.join(alias_list)}")


def person_show(name: str) -> None:
    """Show full profile for a person identity."""
    conn = get_conn()
    row = conn.execute("""
        SELECT pi.*, GROUP_CONCAT(pa.alias, ', ') as aliases
        FROM person_identities pi
        LEFT JOIN person_aliases pa ON pa.person_identity_id = pi.id
        WHERE pi.canonical_name = ? OR pi.id IN (
            SELECT person_identity_id FROM person_aliases WHERE alias = ?
        )
        GROUP BY pi.id
    """, (name, name)).fetchone()
    conn.close()

    if not row:
        print(f"No person found for '{name}'")
        return

    aliases = row["aliases"] or ""
    alias_list = [a.strip() for a in aliases.split(",") if a.strip() != row["canonical_name"]]

    print(f"\n{'='*70}")
    print(f"  {row['canonical_name']}")
    print(f"{'='*70}")
    if row["description"]:
        print(f"  Description: {row['description']}")
    if row["contact_id"]:
        print(f"  Contact ID: {row['contact_id']}")
    if alias_list:
        print(f"  Aliases: {', '.join(alias_list)}")
    if row["first_seen"]:
        print(f"  Span: {row['first_seen']} → {row['last_seen']} ({row['months_seen']} months)")
    if row["roles"]:
        print(f"  Roles: {row['roles']}")
    if row["sources"]:
        print(f"  Sources: {row['sources']}")
    if row["relationship_summary"]:
        print(f"\n  Relationship Summary:")
        for line in row["relationship_summary"].split("\n"):
            print(f"  {line}")


def person_audit() -> None:
    """Scan extraction_people for names that appear with different roles or
    might be confused across months."""
    conn = get_conn()

    names = conn.execute("""
        SELECT ep.canonical_name, COUNT(DISTINCT ep.month_id) as months,
               GROUP_CONCAT(DISTINCT em.month) as month_list
        FROM extraction_people ep
        JOIN extraction_months em ON em.id = ep.month_id
        GROUP BY ep.canonical_name
        HAVING months > 1
        ORDER BY ep.canonical_name
    """).fetchall()

    first_names: dict[str, list[str]] = defaultdict(list)
    for row in names:
        first = row["canonical_name"].split()[0]
        first_names[first].append(row["canonical_name"])

    ambiguous = {k: v for k, v in first_names.items() if len(v) > 1}

    registered_aliases = set()
    for row in conn.execute("SELECT alias FROM person_aliases"):
        registered_aliases.add(row[0])

    conn.close()

    print(f"\n{'='*70}")
    print(f"  Person Audit — Potential Confusions")
    print(f"{'='*70}")

    if ambiguous:
        print(f"\n  Shared first names ({len(ambiguous)} groups):")
        for first, full_names in sorted(ambiguous.items()):
            resolved = all(n in registered_aliases for n in full_names)
            status = " ✓ resolved" if resolved else " ← needs resolution"
            print(f"\n    {first}:{status}")
            for n in full_names:
                in_registry = "✓" if n in registered_aliases else "?"
                print(f"      [{in_registry}] {n}")
    else:
        print("\n  No shared first names found.")

    conn2 = get_conn()
    unregistered = []
    for row in conn2.execute("SELECT DISTINCT canonical_name FROM extraction_people ORDER BY canonical_name"):
        if row["canonical_name"] not in registered_aliases:
            unregistered.append(row["canonical_name"])
    conn2.close()

    if unregistered:
        print(f"\n  Unregistered names ({len(unregistered)} total — showing first 20):")
        for name in unregistered[:20]:
            print(f"    - {name}")
        if len(unregistered) > 20:
            print(f"    ... and {len(unregistered) - 20} more")


# ---------------------------------------------------------------------------
# Corrections management
# ---------------------------------------------------------------------------

VALID_TYPES = ["person_confusion", "attribution_error", "factual_error", "dataset_caveat", "framing_error"]
VALID_LAYERS = ["extraction", "synthesis"]


def correction_add(
    correction_type: str,
    layer: str,
    target: str,
    original_claim: str,
    corrected_claim: str,
    evidence: str | None = None,
    months_affected: list[str] | None = None,
) -> int:
    if correction_type not in VALID_TYPES:
        print(f"ERROR: Invalid correction_type '{correction_type}'. Must be one of: {', '.join(VALID_TYPES)}")
        sys.exit(1)
    if layer not in VALID_LAYERS:
        print(f"ERROR: Invalid layer '{layer}'. Must be one of: {', '.join(VALID_LAYERS)}")
        sys.exit(1)

    conn = get_conn()
    try:
        conn.execute(
            """INSERT INTO corrections 
               (correction_type, layer, target, original_claim, corrected_claim, evidence, months_affected)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (
                correction_type, layer, target, original_claim, corrected_claim,
                evidence, json.dumps(months_affected) if months_affected else None,
            ),
        )
        cid = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
        conn.commit()
        return cid
    finally:
        conn.close()


def correction_list() -> None:
    conn = get_conn()
    rows = conn.execute("""
        SELECT id, correction_type, layer, target, original_claim, corrected_claim, 
               evidence, months_affected, status, created_at
        FROM corrections ORDER BY created_at
    """).fetchall()
    conn.close()

    if not rows:
        print("No corrections recorded yet. Use 'add' or 'seed'.")
        return

    print(f"\n{'='*70}")
    print(f"  Corrections ({len(rows)} total)")
    print(f"{'='*70}")
    for row in rows:
        print(f"\n  [{row['id']:3d}] {row['correction_type']} @ {row['layer']}  [{row['status']}]")
        print(f"       target: {row['target']}")
        original = row["original_claim"]
        if len(original) > 100:
            original = original[:100] + "..."
        print(f"       was:    {original}")
        corrected = row["corrected_claim"]
        if len(corrected) > 100:
            corrected = corrected[:100] + "..."
        print(f"       now:    {corrected}")
        if row["months_affected"]:
            print(f"       months: {row['months_affected']}")


def correction_report() -> None:
    """Print a full corrections report suitable for feeding to a synthesis re-run."""
    conn = get_conn()

    corrections = conn.execute("""
        SELECT * FROM corrections ORDER BY correction_type, created_at
    """).fetchall()

    persons = conn.execute("""
        SELECT pi.canonical_name, pi.description,
               GROUP_CONCAT(pa.alias, '|') as aliases
        FROM person_identities pi
        LEFT JOIN person_aliases pa ON pa.person_identity_id = pi.id
        GROUP BY pi.id
        ORDER BY pi.canonical_name
    """).fetchall()

    conn.close()

    print(f"\n{'='*70}")
    print(f"  CORRECTIONS REPORT")
    print(f"  For use as context in synthesis re-runs or manual review")
    print(f"{'='*70}")

    # Person identities
    print(f"\n## Person Resolution Authority ({len(persons)} registered)")
    print("These are confirmed distinct individuals. Names that appear similar")
    print("in the extraction data must NOT be merged unless listed as aliases.\n")

    for p in persons:
        aliases = p["aliases"].split("|") if p["aliases"] else []
        other_aliases = [a for a in aliases if a != p["canonical_name"]]
        desc = f" — {p['description']}" if p["description"] else ""
        print(f"  {p['canonical_name']}{desc}")
        if other_aliases:
            print(f"    also known as: {', '.join(other_aliases)}")

    # Corrections by type
    by_type = defaultdict(list)
    for c in corrections:
        by_type[c["correction_type"]].append(c)

    for ctype in VALID_TYPES:
        items = by_type.get(ctype, [])
        if not items:
            continue

        label = ctype.replace("_", " ").title()
        print(f"\n## {label}s ({len(items)})\n")

        for c in items:
            print(f"  [{c['id']}] Layer: {c['layer']} | Target: {c['target']}")
            print(f"  Status: {c['status']}")
            print(f"  ORIGINAL: {c['original_claim']}")
            print(f"  CORRECTED: {c['corrected_claim']}")
            if c["evidence"]:
                print(f"  EVIDENCE: {c['evidence']}")
            if c["months_affected"]:
                print(f"  MONTHS: {c['months_affected']}")
            print()


# ---------------------------------------------------------------------------
# Seed known corrections
# ---------------------------------------------------------------------------

def seed() -> None:
    """Seed the database with the known corrections identified so far."""
    conn = get_conn()

    existing = conn.execute("SELECT COUNT(*) FROM corrections").fetchone()[0]
    existing_persons = conn.execute("SELECT COUNT(*) FROM person_identities").fetchone()[0]
    conn.close()

    if existing > 0 or existing_persons > 0:
        print(f"Database already has {existing_persons} person identities and {existing} corrections.")
        resp = input("Clear and re-seed? [y/N] ").strip().lower()
        if resp != "y":
            print("Aborted.")
            return
        conn = get_conn()
        conn.execute("DELETE FROM person_aliases")
        conn.execute("DELETE FROM person_identities")
        conn.execute("DELETE FROM corrections")
        conn.commit()
        conn.close()

    print("\nSeeding person identities...")

    persons = [
        ("Emily Gardt", "Woman Josh dated in LA, ~2022. Distinct from Emily Vitar.", None),
        ("Emily Vitar", "Emily Lloyd Wright Vitar. Most significant romantic relationship 2023-2024. Not Jewish. Mexico trip, March 2024 breakup.", None),
        ("Rabbi Robbie", "Rabbi at YP (Young People's) synagogue in LA. Praises Josh's Musaf leading. Spiritual mentor.", None),
        ("Robbie (Emily V's neighbor)", "Emily Vitar's gay Israeli artist neighbor in LA. She works for him part time. NOT a rabbi.", None),
    ]

    for name, desc, cid in persons:
        pid = person_add(name, desc, cid)
        print(f"  + {name} (id={pid})")

    aliases = [
        ("Emily Gardt", "Emily Gardt", None),
        ("Emily Vitar", "Emily Vitar", None),
        ("Emily Vitar", "Emily V", "extraction 2023-03"),
        ("Emily Vitar", "Emily Lloyd Wright Vitar", None),
        ("Emily Vitar", "Emily", "extraction 2024-03 onward"),
        ("Rabbi Robbie", "Rabbi Robbie", None),
        ("Robbie (Emily V's neighbor)", "Robbie", "Emily Vitar's neighbor, iMessage 2023-03"),
    ]

    print("\nSeeding person aliases...")
    for canonical, alias, ctx in aliases:
        person_alias_add(canonical, alias, ctx)
        print(f"  + '{alias}' → {canonical}" + (f" (context: {ctx})" if ctx else ""))

    print("\nSeeding corrections...")

    corrections_data = [
        {
            "correction_type": "person_confusion",
            "layer": "synthesis",
            "target": "relationship_arcs, life_chapters, theme_evolution, contradictions",
            "original_claim": (
                "The synthesis attributes the entire Emily romantic arc (2023-2024) to Emily Gardt, "
                "including the Rabbi Robbie conversation, the Mexico trip, and the March 2024 breakup. "
                "It lists 'Emily Gardt' as the most significant romantic relationship in the 2022-2024 period."
            ),
            "corrected_claim": (
                "Emily Gardt and Emily Vitar (Emily Lloyd Wright Vitar) are two different people. "
                "Emily Gardt is a woman Josh dated briefly around 2022. Emily Vitar is the significant "
                "romantic relationship from ~March 2023 to March 2024, including the Mexico trip, the "
                "'promiscuous era' conversation, and the March 2024 breakup. The extraction data correctly "
                "distinguishes them (Emily Gardt in 2022-04 to 2023-02, Emily V in 2023-03 onward). "
                "The synthesis incorrectly merged them because they share a first name."
            ),
            "evidence": (
                "Extraction 2023-03 correctly lists 'Emily V' with alias 'Emily Lloyd Wright Vitar'. "
                "Extraction 2022-09 through 2023-02 lists 'Emily Gardt' separately. "
                "The synthesis batch 2 attributes all Emily arc content to 'Emily Gardt'."
            ),
            "months_affected": [
                "2022-04", "2022-05", "2022-06", "2022-07", "2022-08", "2022-09",
                "2022-10", "2022-11", "2023-01", "2023-02",
                "2023-03", "2023-04", "2023-05", "2023-06", "2023-07", "2023-08",
                "2023-09", "2023-10", "2023-11", "2023-12",
                "2024-01", "2024-02", "2024-03", "2024-04", "2024-05",
            ],
        },
        {
            "correction_type": "person_confusion",
            "layer": "extraction",
            "target": "extraction_people, extraction_episodes, extraction_relationships (2023-03)",
            "original_claim": (
                "In extraction 2023-03, 'Robbie' (Emily Vitar's gay Israeli artist neighbor) is listed "
                "as 'Rabbi Robbie' and described as a spiritual mentor. The episode 'Romance with Emily V' "
                "says Josh 'explicitly tells her through Rabbi Robbie that he's looking for a Jewish girl long-term.'"
            ),
            "corrected_claim": (
                "There are two Robbies: (1) Rabbi Robbie, the actual rabbi at YP synagogue who Josh leads "
                "Musaf for, and (2) Robbie, Emily Vitar's gay Israeli artist neighbor who she works for "
                "part time. The conversation where Josh says he's looking for a Jewish girl long-term "
                "happened with Emily V's neighbor Robbie — not Rabbi Robbie. Emily V's neighbor asked "
                "about Josh's intentions, and Josh was upfront. This is candor in response to a direct "
                "question from a protective neighbor, not rabbinical guidance."
            ),
            "evidence": (
                "Original iMessage: Emily tells Josh that Robbie 'said don't worry about it' and she'd "
                "have to 'learn how to translate no Robby, we're in our promiscuous eras.' This is clearly "
                "a casual/humorous exchange with a neighbor, not a rabbinical consultation. "
                "The real Rabbi Robbie appears separately in 2022-09 praising Josh's Musaf leading at YP."
            ),
            "months_affected": ["2023-03"],
        },
        {
            "correction_type": "attribution_error",
            "layer": "synthesis",
            "target": "contradictions, the_person, recurring_patterns",
            "original_claim": (
                "The synthesis attributes therapeutic mantras to Josh as his own insights, e.g. "
                "'I am allowed to be here as I am, regardless of what happens' is listed as Josh's "
                "self-generated mantra/affirmation."
            ),
            "corrected_claim": (
                "This and similar therapeutic lines were generated by ChatGPT as grounding mantras "
                "for Josh to use in challenging moments. Josh internalized and repeated them, but "
                "they are ChatGPT's therapeutic output, not Josh's original formulations. The attribution "
                "inversion likely occurred because: (1) ChatGPT export conversations were truncated to fit "
                "token limits, losing the original assistant message; (2) Josh repeated the lines back, "
                "making them appear as his own in the surviving context."
            ),
            "evidence": (
                "User reports: 'This was a line that ChatGPT gave me to stay grounded in challenging "
                "moments that I had shared. It's possible that I repeated it back to it and that some "
                "of its messages were truncated to stay under the token limit during life extraction.'"
            ),
            "months_affected": None,
        },
        {
            "correction_type": "dataset_caveat",
            "layer": "synthesis",
            "target": "recurring_patterns, the_person.character_summary, relationship_arcs.ChatGPT",
            "original_claim": (
                "The synthesis states: 'Uses ChatGPT for emotional processing he never shares with humans,' "
                "'spent more cumulative hours processing his emotional life with ChatGPT than with any "
                "human being alive,' and characterizes Josh as someone who processes emotions primarily "
                "through AI rather than human connection."
            ),
            "corrected_claim": (
                "This conclusion is a valid inference from the text-based dataset but is factually incorrect "
                "about Josh's actual life. The dataset only captures text-based interactions (iMessage, "
                "WhatsApp, ChatGPT, Gmail). Much of Josh's deeper and more vulnerable emotional processing "
                "happened in spoken conversation — real-life, phone calls, video calls — with friends, "
                "family, and therapists. These conversations are invisible to the system. The synthesis "
                "should carry an explicit epistemic caveat: the apparent centrality of ChatGPT for emotional "
                "processing is an artifact of the dataset's medium bias, not a reflection of reality."
            ),
            "evidence": (
                "User reports: 'The view of me as processing my emotions more with ChatGPT than humans "
                "is incorrect because it's based on a dataset that only covers my text-based interactions "
                "while much of the deeper and more vulnerable emotional processing happened in conversation: "
                "real life, phone call, video call etc.'"
            ),
            "months_affected": None,
        },
        {
            "correction_type": "framing_error",
            "layer": "synthesis",
            "target": "relationship_arcs.Emily Gardt (should be Emily Vitar)",
            "original_claim": (
                "The synthesis says Josh 'explicitly caps the relationship by telling Rabbi Robbie "
                "he's looking for a Jewish girl long-term' — framing this as Josh going to his rabbi "
                "to set a religiously-guided boundary on a romantic relationship."
            ),
            "corrected_claim": (
                "Emily Vitar's protective neighbor Robbie (a gay Israeli artist, not a rabbi) checked "
                "in on Josh's intentions with Emily. Josh was candidly honest: 'I think Emily's wonderful "
                "and hope that we can be friends and in each other's lives but long term I'm looking for "
                "a Jewish girl and that I've been up front about it.' Emily responded with humor: she'd "
                "have to tell Robbie 'we're in our promiscuous eras.' This is straightforward candor in "
                "response to a direct question, not a rabbinical consultation about romantic boundaries."
            ),
            "evidence": (
                "Original iMessage exchange between Josh and Emily V, March 2023. The exchange is playful "
                "and casual — 'don't worry about it,' 'promiscuous eras' — not the register of a conversation "
                "with a rabbi."
            ),
            "months_affected": ["2023-03"],
        },
    ]

    for c in corrections_data:
        cid = correction_add(**c)
        print(f"  + [{cid}] {c['correction_type']}: {c['target'][:60]}...")

    print(f"\nSeed complete.")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Manage corrections to life extraction and synthesis output",
        prog="python -m corrections.manage",
    )
    sub = parser.add_subparsers(dest="command")

    # persons
    persons_parser = sub.add_parser("persons", help="Manage person identities")
    persons_sub = persons_parser.add_subparsers(dest="persons_action")

    add_person = persons_sub.add_parser("add", help="Register a new person identity")
    add_person.add_argument("name", help="Canonical name")
    add_person.add_argument("--desc", help="Description")

    alias_parser = persons_sub.add_parser("alias", help="Add alias for a person")
    alias_parser.add_argument("name", help="Canonical name of the person")
    alias_parser.add_argument("alias", help="Alias to add")
    alias_parser.add_argument("--context", help="Context where this alias appears")

    persons_sub.add_parser("audit", help="Scan for potential person confusions")

    resolve_parser = persons_sub.add_parser("resolve", help="Run person resolution pipeline")
    resolve_parser.add_argument("--dry", action="store_true", help="Dry run")

    summarize_parser = persons_sub.add_parser("summarize", help="Generate LLM relationship summaries")
    summarize_parser.add_argument("--min", type=int, default=3, help="Min months_seen threshold")
    summarize_parser.add_argument("--limit", type=int, help="Max people to summarize")
    summarize_parser.add_argument("--person", type=str, help="Summarize specific person")
    summarize_parser.add_argument("--dry", action="store_true", help="Dry run")

    persons_sub.add_parser("show", help="Show a person's full profile").add_argument("name", help="Person name")

    # corrections
    sub.add_parser("list", help="List all corrections")

    add_corr = sub.add_parser("add", help="Add a correction")
    add_corr.add_argument("type", choices=VALID_TYPES, help="Correction type")
    add_corr.add_argument("layer", choices=VALID_LAYERS, help="Where the error originated")
    add_corr.add_argument("--target", required=True, help="What's being corrected")
    add_corr.add_argument("--original", required=True, help="What the output says")
    add_corr.add_argument("--corrected", required=True, help="What it should say")
    add_corr.add_argument("--evidence", help="Supporting evidence")
    add_corr.add_argument("--months", nargs="*", help="Affected months (YYYY-MM)")

    sub.add_parser("report", help="Full corrections report")
    sub.add_parser("seed", help="Seed known corrections")

    args = parser.parse_args()

    if args.command == "persons":
        if args.persons_action == "add":
            pid = person_add(args.name, args.desc)
            print(f"Added person '{args.name}' (id={pid})")
        elif args.persons_action == "alias":
            person_alias_add(args.name, args.alias, args.context)
            print(f"Added alias '{args.alias}' → '{args.name}'")
        elif args.persons_action == "audit":
            person_audit()
        elif args.persons_action == "resolve":
            from .resolve_persons import run as resolve_run
            resolve_run(dry_run=args.dry)
        elif args.persons_action == "summarize":
            from .summarize_relationships import run as summarize_run
            summarize_run(min_months=args.min, limit=args.limit, person=args.person, dry_run=args.dry)
        elif args.persons_action == "show":
            person_show(args.name)
        else:
            person_list()

    elif args.command == "list":
        correction_list()

    elif args.command == "add":
        cid = correction_add(
            args.type, args.layer, args.target,
            args.original, args.corrected, args.evidence, args.months,
        )
        print(f"Added correction [{cid}]")

    elif args.command == "report":
        correction_report()

    elif args.command == "seed":
        seed()

    else:
        parser.print_help()


if __name__ == "__main__":
    main()
