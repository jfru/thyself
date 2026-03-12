"""
Run life extraction over token-sized batches via the Claude API.

Batches are sized to fill the ~1M context window rather than being
bucketed by calendar month. Use `python -m extraction.prepare --batches`
to preview the batch plan before running.

If a batch is rejected for exceeding the token limit, it is automatically
split in half and the remaining months are requeued. No content is trimmed.
Batches always run in order so each receives context from the previous one.
"""

import json
import os
import re
import sys
import time
from collections import deque
from pathlib import Path

from dotenv import load_dotenv
load_dotenv()

import anthropic

from config import EXTRACTION_RESULTS_DIR, SUBJECT_NAME, CLAUDE_MODEL, CLAUDE_BETA_FLAGS, DB_PATH
from .prepare import BatchSpec, build_batch_chunk, plan_batches
from .prompt import SYSTEM_PROMPT
from .schema import create_tables

RESULTS_DIR = EXTRACTION_RESULTS_DIR
MODEL = CLAUDE_MODEL
BETA_FLAGS = CLAUDE_BETA_FLAGS


def _split_chunk_by_date(chunk: str, batch: BatchSpec) -> tuple[str | None, str | None]:
    """Split a formatted chunk roughly in half at a message boundary.

    Finds message headers (lines starting with '[') and splits at the
    midpoint, creating two valid chunks with updated headers.
    """
    lines = chunk.split("\n")

    # Find all message header line indices
    msg_indices = [i for i, line in enumerate(lines) if line.startswith("[") and " | " in line]

    if len(msg_indices) < 4:
        return None, None

    mid_msg = len(msg_indices) // 2
    split_line = msg_indices[mid_msg]

    # Extract the date from the split point for labelling
    split_header = lines[split_line]
    split_date = split_header[1:17].strip() if len(split_header) > 17 else "mid"

    # Find the header section (everything before the first message)
    first_msg = msg_indices[0]
    header_lines = lines[:first_msg]

    first_chunk_lines = header_lines + [
        f"(Part 1 of 2 — messages up to {split_date})\n",
        "---\n",
    ] + lines[first_msg:split_line]

    second_chunk_lines = header_lines + [
        f"(Part 2 of 2 — messages from {split_date} onward)\n",
        "---\n",
    ] + lines[split_line:]

    return "\n".join(first_chunk_lines), "\n".join(second_chunk_lines)


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


def _split_batch(batch: BatchSpec) -> tuple[BatchSpec, BatchSpec]:
    """Split a batch's months in half, returning two new BatchSpecs."""
    from .prepare import _month_end, _estimate_tokens, _fetch_all_for_month
    from .prepare import _load_contact_cache, _load_conversation_labels, DB_PATH
    import sqlite3

    months = batch.months
    mid = len(months) // 2
    if mid == 0:
        mid = 1  # at least one month in the first half

    first_months = months[:mid]
    second_months = months[mid:]

    conn = sqlite3.connect(DB_PATH)
    contact_cache = _load_contact_cache(conn)
    conv_cache = _load_conversation_labels(conn)
    first_tokens = sum(
        _estimate_tokens(_fetch_all_for_month(conn, m, contact_cache, conv_cache))
        for m in first_months
    )
    second_tokens = sum(
        _estimate_tokens(_fetch_all_for_month(conn, m, contact_cache, conv_cache))
        for m in second_months
    )
    conn.close()

    first = BatchSpec(
        batch_num=batch.batch_num,
        total_batches=0,
        months=first_months,
        start_date=f"{first_months[0]}-01",
        end_date=_month_end(first_months[-1]),
        approx_tokens=first_tokens,
    )
    second = BatchSpec(
        batch_num=0,
        total_batches=0,
        months=second_months,
        start_date=f"{second_months[0]}-01",
        end_date=_month_end(second_months[-1]),
        approx_tokens=second_tokens,
    )
    return first, second


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

        # Handle both new per-month format and old single-period format
        if "months" in data and isinstance(data["months"], list) and data["months"]:
            last_month_data = data["months"][-1]
            summary = last_month_data.get("summary")
            last_month = last_month_data.get("month")
            period = data.get("batch_period", "")
        else:
            period = data.get("period", data.get("batch_period", ""))
            summary = data.get("summary", data.get("batch_summary"))
            last_month = None
            if " to " in period:
                end_date = period.split(" to ")[1]
                last_month = end_date[:7]

        print(f"  Found {len(existing)} existing batches (through {period})")
        return last_num + 1, summary, last_month
    except (json.JSONDecodeError, KeyError, IndexError):
        return last_num + 1, None, None


def run_all(
    start_batch: int | None = None,
    end_batch: int | None = None,
    after_month: str | None = None,
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

    planned = plan_batches(db)
    print(f"Planned {len(planned)} batches across full timeline")

    # Filter to only include batches with months after after_month
    if after_month:
        planned = [b for b in planned if b.months[-1] > after_month]
        # Trim leading months from the first batch if it straddles the boundary
        if planned and planned[0].months[0] <= after_month:
            first = planned[0]
            first.months = [m for m in first.months if m > after_month]
            if not first.months:
                planned = planned[1:]

    if start_batch:
        planned = [b for b in planned if b.batch_num >= start_batch]
    if end_batch:
        planned = [b for b in planned if b.batch_num <= end_batch]

    if not planned:
        print("No batches to run.")
        return []

    queue = deque(planned)

    # Determine starting batch number
    if after_month:
        next_num, prev_summary, _ = _auto_resume()
        batch_counter = next_num
        print(f"  Resuming from batch {batch_counter} (after {after_month})")
    elif start_batch:
        batch_counter = start_batch
        prev_summary = None
        # Load prior context
        prior_path = RESULTS_DIR / f"batch_{start_batch - 1:02d}.json"
        if prior_path.exists():
            try:
                raw = prior_path.read_text().strip()
                if raw.startswith("```"):
                    raw = raw[raw.index("\n") + 1:]
                if raw.endswith("```"):
                    raw = raw[:-3].rstrip()
                prior = json.loads(raw)
                prev_summary = prior.get("summary")
                print(f"  Loaded prior context from batch {start_batch - 1}")
            except (json.JSONDecodeError, KeyError):
                pass
    else:
        batch_counter = 1
        prev_summary = None

    print(f"Running {len(queue)} batches starting from #{batch_counter}")

    results = []
    system = SYSTEM_PROMPT.replace("{name}", SUBJECT_NAME)

    while queue:
        item = queue.popleft()

        # Items can be BatchSpec objects or ("raw_chunk", chunk_text, original_batch) tuples
        if isinstance(item, tuple) and item[0] == "raw_chunk":
            _, chunk, batch = item
            batch.batch_num = batch_counter
            m_range = f"{batch.months[0]} (split)" if len(batch.months) == 1 else f"{batch.months[0]} to {batch.months[-1]}"
            est = len(chunk) // 3
            print(f"\n{'='*60}")
            print(f"Batch {batch_counter}: {m_range}")
            print(f"  ~{est:,} est. tokens (pre-split chunk)")
        else:
            batch = item
            batch.batch_num = batch_counter
            m_range = f"{batch.months[0]} to {batch.months[-1]}" if len(batch.months) > 1 else batch.months[0]
            print(f"\n{'='*60}")
            print(f"Batch {batch_counter}: {m_range}")
            print(f"  {len(batch.months)} months, ~{batch.approx_tokens:,} est. tokens")
            chunk = build_batch_chunk(batch, db, prev_summary=prev_summary)

        print(f"  Sending to {MODEL} (streaming)...")
        t0 = time.time()

        try:
            raw_text, input_tokens, output_tokens = _send_to_api(client, system, chunk)

            elapsed = time.time() - t0
            print(f"  Response received in {elapsed:.1f}s")
            print(f"  Input tokens: {input_tokens:,}")
            print(f"  Output tokens: {output_tokens:,}")

        except anthropic.BadRequestError as e:
            error_msg = str(e)
            token_match = re.search(r"(\d+) tokens > (\d+) maximum", error_msg)

            if token_match and len(batch.months) > 1:
                actual = int(token_match.group(1))
                limit = int(token_match.group(2))
                print(f"  Too long: {actual:,} tokens (limit {limit:,})")
                print(f"  Splitting {len(batch.months)} months in half and requeuing...")

                first_half, second_half = _split_batch(batch)
                queue.appendleft(second_half)
                queue.appendleft(first_half)
                continue  # retry with smaller batch, don't increment counter

            elif token_match and len(batch.months) == 1:
                actual = int(token_match.group(1))
                print(f"  Single month {batch.months[0]} is {actual:,} tokens — splitting by date...")

                first_half, second_half = _split_chunk_by_date(chunk, batch)
                if first_half and second_half:
                    queue.appendleft(("raw_chunk", second_half, batch))
                    queue.appendleft(("raw_chunk", first_half, batch))
                    continue
                else:
                    print(f"  Could not split further. Stopping.")
                    print(f"  Resume after fixing with: python -m extraction.run --from {batch_counter}")
                    sys.exit(1)
            else:
                raise

        except Exception as e:
            if "timed out" in str(e).lower() or "timeout" in str(e).lower():
                print(f"\n  TIMEOUT on batch {batch_counter}: {e}")
                print(f"  Retrying in 30 seconds...")
                time.sleep(30)
                queue.appendleft(batch)  # put it back at the front
                continue
            else:
                print(f"\n  FATAL ERROR: {e}")
                print(f"  Resume with: python -m extraction.run --from {batch_counter}")
                sys.exit(1)

        # Save result
        RESULTS_DIR.mkdir(parents=True, exist_ok=True)
        result_path = RESULTS_DIR / f"batch_{batch_counter:02d}.json"
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
        batch_counter += 1

        if on_batch_complete:
            on_batch_complete(len(results), len(planned))

    print(f"\n{'='*60}")
    print(f"Completed {len(results)} batches")

    return results


if __name__ == "__main__":
    start = None
    end = None
    after = None
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
    if "--after" in args:
        idx = args.index("--after")
        after = args[idx + 1]  # e.g. "2017-06"
    if "--resume" in args:
        _, _, last_month = _auto_resume()
        if last_month:
            after = last_month
            print(f"Auto-resuming after {after}")
        else:
            print("No existing batches found, starting from scratch")

    results = run_all(start_batch=start, end_batch=end, after_month=after)
    for r in results:
        p = r.get("period", "?")
        s = r.get("summary", "(no summary)")
        print(f"\n{p}: {s}")
