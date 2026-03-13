"""
Run life extraction over token-sized batches via the Claude API.

Batches are packed at the message level to fill the ~1M context window.
Use `python -m extraction.prepare --batches` to preview the batch plan.

Batches run in order so each receives context from the previous one.
"""

import json
import os
import sys
import time
from pathlib import Path

from dotenv import load_dotenv
load_dotenv()

import anthropic

from config import EXTRACTION_RESULTS_DIR, SUBJECT_NAME, CLAUDE_MODEL, CLAUDE_BETA_FLAGS, DB_PATH
from .prepare import BatchSpec, build_batch_chunk, plan_batches, fetch_all_messages
from .prompt import SYSTEM_PROMPT
from .schema import create_tables

RESULTS_DIR = EXTRACTION_RESULTS_DIR
MODEL = CLAUDE_MODEL
BETA_FLAGS = CLAUDE_BETA_FLAGS


def _send_to_api(client, system, chunk):
    """Send a chunk to the API and return (raw_text, input_tokens, output_tokens)."""
    raw_text = ""
    with client.beta.messages.stream(
        model=MODEL,
        max_tokens=65536,
        system=system,
        messages=[{"role": "user", "content": chunk}],
        betas=BETA_FLAGS,
    ) as stream:
        for text in stream.text_stream:
            raw_text += text
        response = stream.get_final_message()
    return raw_text, response.usage.input_tokens, response.usage.output_tokens


def _auto_resume() -> tuple[int, str | None]:
    """Detect already-completed batches and return (next_batch_num, prev_summary).

    Scans existing batch_XX.json files to find the highest completed batch
    and loads its summary for context threading.
    """
    existing = sorted(RESULTS_DIR.glob("batch_*.json"))
    if not existing:
        return 1, None

    last_file = existing[-1]
    last_num = int(last_file.stem.split("_")[1])
    try:
        raw = last_file.read_text().strip()
        if raw.startswith("```"):
            raw = raw[raw.index("\n") + 1:]
        if raw.endswith("```"):
            raw = raw[:-3].rstrip()
        data = json.loads(raw)

        if "months" in data and isinstance(data["months"], list) and data["months"]:
            summary = data["months"][-1].get("summary")
            period = data.get("batch_period", "")
        else:
            period = data.get("period", data.get("batch_period", ""))
            summary = data.get("summary", data.get("batch_summary"))

        print(f"  Found {len(existing)} existing batches (through {period})")
        return last_num + 1, summary
    except (json.JSONDecodeError, KeyError, IndexError):
        return last_num + 1, None


def run_all(
    start_batch: int | None = None,
    end_batch: int | None = None,
    db_path: str | Path | None = None,
    on_batch_complete: "Callable[[int, int], None] | None" = None,
) -> list[dict]:
    """Run extraction across token-sized batches, threading summaries.

    on_batch_complete(completed_count, total_planned) is called after each batch.
    """
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        print("ERROR: ANTHROPIC_API_KEY environment variable not set")
        sys.exit(1)

    client = anthropic.Anthropic(api_key=api_key)
    db = Path(db_path) if db_path else DB_PATH

    create_tables(db)

    print("Loading messages...", end=" ", flush=True)
    all_messages = fetch_all_messages(db)
    print(f"{len(all_messages):,} messages loaded.")

    planned = plan_batches(all_messages)
    total_planned = len(planned)
    print(f"Planned {total_planned} batches across full timeline")

    if start_batch:
        planned = [b for b in planned if b.batch_num >= start_batch]
    if end_batch:
        planned = [b for b in planned if b.batch_num <= end_batch]

    if not planned:
        print("No batches to run.")
        return []

    # Determine prior context for resume
    prev_summary = None
    if start_batch and start_batch > 1:
        prior_path = RESULTS_DIR / f"batch_{start_batch - 1:02d}.json"
        if prior_path.exists():
            try:
                raw = prior_path.read_text().strip()
                if raw.startswith("```"):
                    raw = raw[raw.index("\n") + 1:]
                if raw.endswith("```"):
                    raw = raw[:-3].rstrip()
                prior = json.loads(raw)
                if "months" in prior and isinstance(prior["months"], list) and prior["months"]:
                    prev_summary = prior["months"][-1].get("summary")
                else:
                    prev_summary = prior.get("summary") or prior.get("batch_summary")
                print(f"  Loaded prior context from batch {start_batch - 1}")
            except (json.JSONDecodeError, KeyError):
                pass

    print(f"Running {len(planned)} batches starting from #{planned[0].batch_num}")

    results = []
    system = SYSTEM_PROMPT.replace("{name}", SUBJECT_NAME)

    for batch in planned:
        print(f"\n{'='*60}")
        print(f"Batch {batch.batch_num}/{batch.total_batches}: {batch.start_date} to {batch.end_date}")
        print(f"  {len(batch.months)} months, ~{batch.approx_tokens:,} est. tokens")

        chunk = build_batch_chunk(all_messages, batch, prev_summary=prev_summary)

        print(f"  Sending to {MODEL} (streaming)...")
        t0 = time.time()

        try:
            raw_text, input_tokens, output_tokens = _send_to_api(client, system, chunk)

            elapsed = time.time() - t0
            print(f"  Response received in {elapsed:.1f}s")
            print(f"  Input tokens: {input_tokens:,}")
            print(f"  Output tokens: {output_tokens:,}")

        except Exception as e:
            if "timed out" in str(e).lower() or "timeout" in str(e).lower():
                print(f"\n  TIMEOUT on batch {batch.batch_num}: {e}")
                print(f"  Resume with: python -m extraction.run --from {batch.batch_num}")
                sys.exit(1)
            else:
                print(f"\n  FATAL ERROR: {e}")
                print(f"  Resume with: python -m extraction.run --from {batch.batch_num}")
                sys.exit(1)

        RESULTS_DIR.mkdir(parents=True, exist_ok=True)
        result_path = RESULTS_DIR / f"batch_{batch.batch_num:02d}.json"
        result_path.write_text(raw_text)
        print(f"  Saved to {result_path}")

        cleaned = raw_text.strip()
        if cleaned.startswith("```"):
            cleaned = cleaned[cleaned.index("\n") + 1:]
        if cleaned.endswith("```"):
            cleaned = cleaned[:-3].rstrip()

        try:
            result = json.loads(cleaned)
        except json.JSONDecodeError as e:
            print(f"  WARNING: Failed to parse JSON: {e}")
            result = {"period": f"{batch.start_date} to {batch.end_date}", "_parse_error": str(e), "_raw": raw_text}

        results.append(result)
        if "months" in result and isinstance(result["months"], list) and result["months"]:
            prev_summary = result["months"][-1].get("summary")
        else:
            prev_summary = result.get("summary") or result.get("batch_summary")

        if on_batch_complete:
            on_batch_complete(len(results), total_planned)

    print(f"\n{'='*60}")
    print(f"Completed {len(results)} batches")

    return results


if __name__ == "__main__":
    start = None
    end = None
    args = sys.argv[1:]

    if "--from" in args:
        idx = args.index("--from")
        start = int(args[idx + 1])
    if "--to" in args:
        idx = args.index("--to")
        end = int(args[idx + 1])
    if "--batch" in args:
        idx = args.index("--batch")
        start = end = int(args[idx + 1])
    if "--resume" in args:
        next_num, _ = _auto_resume()
        start = next_num
        print(f"Auto-resuming from batch {start}")

    results = run_all(start_batch=start, end_batch=end)
    for r in results:
        p = r.get("period", "?")
        s = r.get("summary", "(no summary)")
        print(f"\n{p}: {s}")
