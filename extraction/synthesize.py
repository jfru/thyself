"""
Run longitudinal synthesis over extraction results.

Loads all extraction JSON outputs and batches them by token volume
to fit within the ~1M context window. If more than one synthesis
batch is needed, merges them into a unified output.

Usage:
    python -m extraction.synthesize              # run full pipeline
    python -m extraction.synthesize --batch 1    # run synthesis batch 1 only
    python -m extraction.synthesize --merge      # merge existing batch outputs
"""

import json
import os
import sys
import time
from pathlib import Path

from dotenv import load_dotenv
load_dotenv()

import anthropic

from config import (
    SUBJECT_NAME, DB_PATH, EXTRACTION_RESULTS_DIR,
    SYNTHESIS_RESULTS_DIR, CLAUDE_MODEL, CLAUDE_BETA_FLAGS,
)
from .prompt import SYNTHESIS_SYSTEM_PROMPT, MERGE_SYSTEM_PROMPT
from .schema import create_tables

RESULTS_DIR = EXTRACTION_RESULTS_DIR
SYNTHESIS_DIR = SYNTHESIS_RESULTS_DIR
MODEL = CLAUDE_MODEL
BETA_FLAGS = CLAUDE_BETA_FLAGS

MAX_SYNTHESIS_TOKENS = 900_000


def _load_all_extractions() -> list[tuple[str, dict, int]]:
    """Load all extraction results, returning (filename, data, approx_tokens) tuples."""
    files = sorted(RESULTS_DIR.glob("batch_*.json"))
    if not files:
        files = sorted(RESULTS_DIR.glob("*.json"))

    results = []
    for f in files:
        raw = f.read_text().strip()
        if raw.startswith("```"):
            raw = raw[raw.index("\n") + 1:]
        if raw.endswith("```"):
            raw = raw[:-3].rstrip()
        brace = raw.find("{")
        if brace > 0:
            raw = raw[brace:]
        data = json.loads(raw)
        approx_tokens = len(raw) // 4
        results.append((f.stem, data, approx_tokens))
    return results


def _plan_synthesis_batches(
    extractions: list[tuple[str, dict, int]],
) -> list[list[tuple[str, dict, int]]]:
    """Group extraction results into synthesis batches by token volume."""
    batches: list[list[tuple[str, dict, int]]] = []
    current: list[tuple[str, dict, int]] = []
    current_tokens = 0

    for item in extractions:
        _, _, tokens = item
        if current and current_tokens + tokens > MAX_SYNTHESIS_TOKENS:
            batches.append(current)
            current = []
            current_tokens = 0
        current.append(item)
        current_tokens += tokens

    if current:
        batches.append(current)

    return batches


def _build_user_message(extractions: list[tuple[str, dict, int]]) -> str:
    parts = []
    for name, ext, _ in extractions:
        period = ext.get("period", ext.get("month", name))
        parts.append(f"=== {period} ===")
        parts.append(json.dumps(ext, ensure_ascii=False))
    return "\n\n".join(parts)


def _call_api(client: anthropic.Anthropic, system: str, user_content: str, label: str) -> str:
    print(f"\n{'='*60}")
    print(f"Synthesis: {label}")
    est_tokens = len(user_content) // 4
    print(f"  ~{est_tokens:,} estimated input tokens")
    print(f"  Sending to {MODEL} (streaming)...")

    t0 = time.time()
    raw_text = ""

    with client.beta.messages.stream(
        model=MODEL,
        max_tokens=32768,
        system=system,
        messages=[{"role": "user", "content": user_content}],
        betas=BETA_FLAGS,
    ) as stream:
        for text in stream.text_stream:
            raw_text += text
        response = stream.get_final_message()

    elapsed = time.time() - t0
    print(f"  Response received in {elapsed:.1f}s")
    print(f"  Input tokens: {response.usage.input_tokens:,}")
    print(f"  Output tokens: {response.usage.output_tokens:,}")

    return raw_text


def _clean_and_save(raw_text: str, filename: str) -> dict:
    SYNTHESIS_DIR.mkdir(parents=True, exist_ok=True)
    out_path = SYNTHESIS_DIR / filename

    cleaned = raw_text.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned[cleaned.index("\n") + 1:]
    if cleaned.endswith("```"):
        cleaned = cleaned[:-3].rstrip()
    brace = cleaned.find("{")
    if brace > 0:
        cleaned = cleaned[brace:]

    out_path.write_text(cleaned + "\n")
    print(f"  Saved to {out_path}")

    try:
        return json.loads(cleaned)
    except json.JSONDecodeError as e:
        print(f"  WARNING: JSON parse error: {e}")
        return {"_parse_error": str(e), "_raw": raw_text}


def run_synthesis_batch(
    client: anthropic.Anthropic,
    batch_num: int,
    extractions: list[tuple[str, dict, int]],
    total_batches: int,
) -> dict:
    """Run synthesis for a single batch of extractions."""
    first_period = extractions[0][1].get("period", extractions[0][0])
    last_period = extractions[-1][1].get("period", extractions[-1][0])
    total_tokens = sum(t for _, _, t in extractions)

    label = f"Batch {batch_num}/{total_batches} ({first_period} ... {last_period}, {len(extractions)} extractions, ~{total_tokens:,} tokens)"
    print(f"\n  {label}")

    system = SYNTHESIS_SYSTEM_PROMPT.replace("{name}", SUBJECT_NAME)
    user_msg = _build_user_message(extractions)
    raw = _call_api(client, system, user_msg, label)
    return _clean_and_save(raw, f"synthesis_batch_{batch_num}.json")


def run_merge(client: anthropic.Anthropic, num_batches: int) -> dict:
    """Merge all synthesis batch outputs into a unified synthesis."""
    parts = []
    for i in range(1, num_batches + 1):
        path = SYNTHESIS_DIR / f"synthesis_batch_{i}.json"
        if not path.exists():
            print(f"ERROR: Missing {path}")
            sys.exit(1)
        parts.append((i, path.read_text()))

    system = MERGE_SYSTEM_PROMPT.replace("{name}", SUBJECT_NAME)

    if len(parts) == 2:
        user_msg = f"## Synthesis — First Half\n\n{parts[0][1]}\n\n## Synthesis — Second Half\n\n{parts[1][1]}"
    else:
        sections = []
        for i, content in parts:
            sections.append(f"## Synthesis — Part {i}\n\n{content}")
        user_msg = "\n\n".join(sections)

    raw = _call_api(client, system, user_msg, f"Merge ({len(parts)} parts)")
    return _clean_and_save(raw, "synthesis_merged.json")


def main():
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        print("ERROR: ANTHROPIC_API_KEY not set")
        sys.exit(1)

    client = anthropic.Anthropic(api_key=api_key)
    args = sys.argv[1:]

    if "--merge" in args:
        batch_files = sorted(SYNTHESIS_DIR.glob("synthesis_batch_*.json"))
        result = run_merge(client, len(batch_files))
        print(f"\nMerge complete. Chapters: {len(result.get('life_chapters', []))}")
        return

    extractions = _load_all_extractions()
    print(f"Loaded {len(extractions)} extraction results")
    total_tokens = sum(t for _, _, t in extractions)
    print(f"Total extraction tokens: ~{total_tokens:,}")

    synthesis_batches = _plan_synthesis_batches(extractions)
    print(f"Planned {len(synthesis_batches)} synthesis batches")

    if "--batch" in args:
        idx = args.index("--batch")
        batch_num = int(args[idx + 1])
        if batch_num < 1 or batch_num > len(synthesis_batches):
            print(f"ERROR: batch must be 1-{len(synthesis_batches)}")
            sys.exit(1)
        result = run_synthesis_batch(
            client, batch_num, synthesis_batches[batch_num - 1], len(synthesis_batches)
        )
        print(f"\nBatch {batch_num} complete. Chapters: {len(result.get('life_chapters', []))}")
        return

    # Full run: all synthesis batches, then merge if needed
    for i, batch_extractions in enumerate(synthesis_batches, 1):
        result = run_synthesis_batch(client, i, batch_extractions, len(synthesis_batches))
        print(f"\nBatch {i} complete. Chapters: {len(result.get('life_chapters', []))}")

    if len(synthesis_batches) > 1:
        print(f"\nRunning merge across {len(synthesis_batches)} synthesis batches...")
        result = run_merge(client, len(synthesis_batches))
        print(f"\nMerge complete. Chapters: {len(result.get('life_chapters', []))}")
    else:
        # Single batch — copy as merged
        src = SYNTHESIS_DIR / "synthesis_batch_1.json"
        dst = SYNTHESIS_DIR / "synthesis_merged.json"
        if src.exists():
            dst.write_text(src.read_text())
            print(f"\nSingle batch — copied to {dst}")


if __name__ == "__main__":
    main()
