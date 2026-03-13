---
description: Design doc for refactoring the extraction output format from per-month to per-batch-period granularity. Reference this when working on the extraction pipeline output format, prompt, ingestion, or DB schema for extraction data.
---

# Extraction Output Format Redesign: Month → Batch-Period

## Status: Not Started (Design Only)

This document describes a future refactor. It should be read by any agent working on changes to the extraction pipeline output format, the `extraction_months` DB table, the extraction prompt, or the ingestion layer.

## Background

The extraction pipeline has two legacy assumptions baked in:

1. **Batching was originally per-month.** Each calendar month was its own batch sent to Claude. This was refactored to token-sized batches (packing multiple months or splitting large months), but the extraction *output* format was never updated to match.

2. **Extraction output is still per-month.** The system prompt in `extraction/prompt.py` instructs Claude to produce a `months` array with one extraction entry per calendar month. This made sense when batch = month, but now:
   - A batch of 53 sparse months produces 53 mostly-empty month entries (wasted output tokens)
   - A batch of 2 dense weeks forces Claude to split naturally cohesive analysis at the month boundary
   - When a batch boundary falls mid-month, the overlapping month gets partially extracted in two separate batches (the later one overwrites via `INSERT OR REPLACE`)

## The Problem In Detail

### Sparse periods waste output tokens

For the main profile, batch 1 covers 2013-05 to 2018-01 (53 months). Claude must produce 53 separate month entries, most with thin data. The extraction prompt says "If a month has very little data, produce a brief extraction for it" — but even brief entries have structural overhead (episodes array, relationships array, themes array, etc.) multiplied by 53.

### Dense periods lose cohesion

For the main profile, batch 48 covers just 2024-09 (one month, ~1M tokens of messages). Claude produces one month entry. But nearby batches 47 and 49 also produce entries for August and October respectively. An episode that spans August 25 to September 5 is artificially split across two extractions with no cross-reference.

### Month overlap creates data quality issues

After the message-level batching refactor, batch boundaries fall mid-month. A batch ending on 2024-10-10 and the next starting on 2024-10-10 both produce an extraction for October 2024. The second overwrites the first via `INSERT OR REPLACE`. The first batch's October extraction (based on Oct 1-10 data) is lost, replaced by the second batch's (based on Oct 10-31 data plus a prior summary). Neither extraction sees the full month.

## Proposed Design

### Batch = Extraction Unit

Each batch produces **one extraction** covering its exact date range. No subdivision by month.

### New output format

```json
{
  "period": "2024-09-15 to 2024-10-10",
  "summary": "2-3 sentence overview of this period",
  "people": [
    {
      "canonical_name": "...",
      "aliases": ["..."],
      "sample_msg_ids": ["#m12345"]
    }
  ],
  "episodes": [
    {
      "name": "...",
      "description": "...",
      "date_range": "2024-09-20 to 2024-10-05",
      "status": "new | ongoing | escalating | resolving | concluded",
      "people": ["..."],
      "emotional_tone": "...",
      "key_evidence": ["... [#m12345]"],
      "sources": ["imessage", "chatgpt"]
    }
  ],
  "relationships": [
    {
      "person": "...",
      "role": "...",
      "quality_this_period": "...",
      "notable_exchanges": ["... [#m12345]"],
      "sources": ["..."]
    }
  ],
  "themes": [
    {
      "name": "...",
      "description": "...",
      "intensity": "low | moderate | high | consuming",
      "sources": ["..."],
      "cross_source_note": "..."
    }
  ],
  "decisions": [
    {
      "description": "...",
      "status": "contemplating | deciding | decided | deferred | avoided",
      "stakes": "...",
      "evidence": "..."
    }
  ],
  "emotional_state": {
    "overall": "...",
    "indicators": ["..."],
    "energy_level": "low | moderate | high | manic",
    "stress_signals": ["..."],
    "joy_signals": ["..."]
  },
  "tensions": [
    {
      "description": "...",
      "evidence": ["..."]
    }
  ],
  "absences": [
    {
      "description": "..."
    }
  ],
  "raw_observations": ["..."]
}
```

Key changes from current format:
- No `months` array wrapper — the extraction IS the top-level object
- Episodes get a `date_range` field instead of being bucketed into a specific month
- `quality_this_month` → `quality_this_period` in relationships
- `batch_period` / `batch_summary` → `period` / `summary` (no "batch_" prefix needed)

### DB schema changes

Rename `extraction_months` → `extraction_periods`:

```sql
CREATE TABLE extraction_periods (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_num INTEGER,           -- which batch produced this
    period_start TEXT NOT NULL,   -- first message timestamp
    period_end TEXT NOT NULL,     -- last message timestamp  
    summary TEXT,
    emotional_overall TEXT,
    energy_level TEXT,
    emotional_indicators TEXT,
    stress_signals TEXT,
    joy_signals TEXT,
    raw_json TEXT
);
```

All child tables (`extraction_episodes`, `extraction_relationships`, etc.) keep their `month_id` FK column but rename it to `period_id`. The column type and semantics are unchanged — it's just an integer FK.

Add `date_range` column to `extraction_episodes`:

```sql
ALTER TABLE extraction_episodes ADD COLUMN date_range TEXT;
```

### Downstream query changes

The chat AI's system prompt references `extraction_months` in its schema documentation and example queries. These would change:

- `extraction_months` → `extraction_periods`
- `WHERE month = '2024-10'` → `WHERE period_start <= '2024-10-31' AND period_end >= '2024-10-01'`
- `month_id` FK references in example queries → `period_id`

Affected file: `app/src/lib/systemPrompt.ts` (the schema documentation section and query strategy guidance).

### Ingestion changes

`extraction/ingest_results.py`:
- `_ingest_single_month()` → `_ingest_single_period()`
- No longer iterates `result["months"]` — the result IS the extraction
- One extraction per batch result file
- `ingest_extraction()` handles both old format (with `months` array) and new format (flat) for backward compatibility during transition

### Prompt changes

`extraction/prompt.py`:
- Remove the "Critical: monthly granularity" section from `SYSTEM_PROMPT`
- Remove "produce a separate extraction for EACH month" instruction
- Instead: "Produce a single extraction covering the entire batch period"
- Episodes should include `date_range` for temporal anchoring
- Remove `BATCH_HEADER_TEMPLATE`'s `{months_list}` placeholder

### Synthesis impact

`extraction/synthesize.py` loads batch JSON files directly and passes them to Claude. The synthesis prompt references `period` fields from the extraction output. With the new format, each extraction has a `period` field (already present as `batch_period` in current format). Synthesis should work with minimal changes — just update the field name references.

### Benefits

- **Fewer output tokens**: No structural overhead for 53 sparse month entries
- **Better extraction quality**: Claude analyzes the natural structure of the data instead of forcing month boundaries
- **No overlap problem**: Each message appears in exactly one extraction
- **Simpler ingestion**: One extraction per batch, no iteration over months array
- **Temporal resolution matches data density**: Dense periods get fine-grained extraction, sparse periods get cohesive high-level extraction

### Migration

Since extraction results are stored as JSON files (`batch_*.json`) and can be re-ingested:
1. Update the prompt, output format, and ingestion code
2. Drop and recreate the extraction tables (or add new tables alongside old ones)
3. Re-run extraction (necessary anyway to get the new format)
4. Old `batch_*.json` files in the old format can be kept — `ingest_extraction()` should handle both formats

### Files to change

- `extraction/prompt.py` — System prompt and batch header template
- `extraction/prepare.py` — BatchSpec (remove `months` field entirely)
- `extraction/ingest_results.py` — Ingestion logic
- `extraction/schema.py` — DB table definitions
- `app/src/lib/systemPrompt.ts` — Schema docs, query examples, query strategy
- `app/src-tauri/src/tools.rs` — If tool definitions reference extraction table names
