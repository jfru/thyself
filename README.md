# thyself — Personal Life Intelligence System

A system that ingests your personal communications (iMessage, WhatsApp, ChatGPT, Gmail), runs structured life extraction via Claude, and produces a longitudinal synthesis of your life patterns, relationships, and turning points — then uses all of that as context for an AI that actually knows you.

## What It Does

1. **Ingests** your raw data from four sources into a single SQLite database
2. **Extracts** structured observations (episodes, relationships, themes, decisions, tensions, absences) from each time period using Claude Opus
3. **Synthesizes** those observations into a longitudinal life history — life chapters, relationship arcs, recurring patterns, turning points, and a character portrait
4. **Corrects** errors via a human-in-the-loop correction layer and person identity resolution
5. **Serves as context** for an AI that can query your full life corpus and structured analysis to have deeply informed conversations about your life

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    DATA SOURCES                         │
│  iMessage  ·  WhatsApp  ·  ChatGPT  ·  Gmail           │
└──────────────┬──────────────────────────────────────────┘
               │  Ingestion scripts (ingest/)
               ▼
┌─────────────────────────────────────────────────────────┐
│                  thyself.db (SQLite)                     │
│  messages · chatgpt_messages · gmail_messages · contacts │
└──────────────┬──────────────────────────────────────────┘
               │  extraction/prepare.py → extraction/run.py
               ▼
┌─────────────────────────────────────────────────────────┐
│              Pass 1: Life Extraction                     │
│  extraction_months · extraction_episodes · themes ·      │
│  relationships · decisions · tensions · absences         │
└──────────────┬──────────────────────────────────────────┘
               │  extraction/synthesize.py
               ▼
┌─────────────────────────────────────────────────────────┐
│            Pass 2: Longitudinal Synthesis                │
│  life_chapters · relationship_arcs · theme_evolution ·   │
│  turning_points · recurring_patterns · person_portrait   │
└──────────────┬──────────────────────────────────────────┘
               │  corrections/
               ▼
┌─────────────────────────────────────────────────────────┐
│              Corrections & Person Resolution             │
│  person_identities · person_aliases · corrections        │
└──────────────┬──────────────────────────────────────────┘
               │  .cursor/rules/thyself.mdc (AI context)
               ▼
┌─────────────────────────────────────────────────────────┐
│                AI Therapist / Coach                      │
│  Cursor agent with full database + session history       │
└─────────────────────────────────────────────────────────┘
```

All personal data (database, sessions, extraction results) is stored **outside the project directory** in `~/Library/Application Support/Thyself/` by default. The code never touches your data unless you point it there via environment variables. This means the project directory is safe to version-control and share.

## Prerequisites

- **Python 3.10+**
- **macOS** (for iMessage and Contacts ingestion; WhatsApp/ChatGPT/Gmail work cross-platform)
- **Anthropic API key** with access to Claude Opus (for extraction and synthesis)
- **Google Cloud project** with Gmail API enabled (for Gmail ingestion)
- **Cursor IDE** (for the AI therapist interface)

## Quick Start

### 1. Clone and set up the environment

```bash
git clone <this-repo>
cd thyself
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

### 2. Configure

```bash
cp .env.example .env
```

Edit `.env` with your settings:

```bash
ANTHROPIC_API_KEY=sk-ant-...
THYSELF_SUBJECT_NAME=YourName
THYSELF_EMAIL=you@gmail.com
```

All configuration is via environment variables — no need to edit source code. See `.env.example` for the full list. Key variables:

| Variable | Purpose | Default |
|----------|---------|---------|
| `THYSELF_DATA_DIR` | Where your data lives | `~/Library/Application Support/Thyself` |
| `THYSELF_SUBJECT_NAME` | Your name (used in extraction prompts) | `User` |
| `THYSELF_EMAIL` | Your email (for Gmail is_from_me detection) | |
| `ANTHROPIC_API_KEY` | Claude API key | |
| `THYSELF_IPHONE_BACKUP` | Path to iPhone backup (for WhatsApp) | |
| `THYSELF_CONTACTS_DB` | Path to macOS AddressBook database | |
| `THYSELF_GCP_PROJECT` | Google Cloud project ID (for Gmail) | |

### 3. Create the database

```bash
python -m extraction.schema
```

This creates `thyself.db` in your data directory with all the required tables.

---

## Data Ingestion

Run whichever sources you have available. Each is independent — you don't need all four.

### iMessage (macOS only)

iMessage data lives in `~/Library/Messages/chat.db`. You'll need to write a script to read from this SQLite database and insert into the `messages` table. The schema expects:

| Column | Type | Description |
|--------|------|-------------|
| `conversation_id` | INTEGER | FK to conversations table |
| `contact_id` | INTEGER | FK to contacts table |
| `source` | TEXT | `'imessage'` |
| `source_id` | TEXT | Unique message ID |
| `is_from_me` | BOOLEAN | 1 if you sent it |
| `content` | TEXT | Message text |
| `content_type` | TEXT | `'text'`, `'image'`, etc. |
| `sent_at` | DATETIME | ISO 8601 timestamp |
| `word_count` | INTEGER | Word count of content |
| `has_attachment` | BOOLEAN | Whether message has media |

### WhatsApp (from iPhone backup)

```bash
# Step 1: Extract WhatsApp databases from encrypted iPhone backup
export WA_BACKUP_PW="your-backup-password"
python extract_whatsapp.py

# Step 2: Import into thyself.db
python import_whatsapp.py
```

**Requires:** `iphone-backup-decrypt` (`pip install iphone-backup-decrypt`)

### ChatGPT

Export your data from [chat.openai.com/settings](https://chat.openai.com/settings) → Data controls → Export data. You'll receive a zip with `conversations-*.json` files.

```bash
# Unzip the export, then:
python -m ingest.chatgpt /path/to/chatgpt-export-dir
```

### Gmail

```bash
# Step 1: Set up Google Cloud credentials
# Create a project at console.cloud.google.com
# Enable the Gmail API
# Run:
gcloud auth application-default login \
  --scopes="openid,https://www.googleapis.com/auth/userinfo.email,https://www.googleapis.com/auth/gmail.readonly"

# Step 2: Ingest
cd ingest
python gmail.py

# Optional: dry run first to see how many messages match
python gmail.py --dry-run
python gmail.py --max 100  # limit to 100 messages for testing
```

The Gmail ingester has multi-layer filtering to skip automated/transactional emails and only ingest personal correspondence.

### Contacts

```bash
python -m ingest.import_contacts
```

This matches phone/email aliases in the database against your macOS Contacts to populate display names.

---

## Life Extraction (Pass 1)

Once you have data in the database, run the extraction pipeline:

```bash
# Preview what batches will be created
python -m extraction.prepare

# See detailed batch plan
python -m extraction.prepare --batches

# Run extraction for all batches
python -m extraction.run

# Or run specific batches
python -m extraction.run --batch 3         # single batch
python -m extraction.run --from 3 --to 5   # batch range
```

**How it works:**
- Groups your messages into batches sized to fill Claude's ~1M token context window
- Each batch gets a structured extraction: episodes, relationships, themes, decisions, tensions, absences
- Results are saved as JSON in your data directory and can be ingested into the database

```bash
# Ingest extraction results into database tables
python -m extraction.ingest_results
```

## Longitudinal Synthesis (Pass 2)

After extraction, run the synthesis to find patterns across your full timeline:

```bash
# Run full synthesis pipeline
python -m extraction.synthesize

# Or step by step:
python -m extraction.synthesize --batch 1   # synthesis batch 1
python -m extraction.synthesize --batch 2   # synthesis batch 2
python -m extraction.synthesize --merge     # merge into unified output
```

```bash
# Ingest synthesis results into database
python -m extraction.ingest_synthesis
```

**Output:** Life chapters, relationship arcs, theme evolution, recurring patterns, contradictions, turning points, and a character portrait.

## Corrections & Person Resolution

The extraction makes mistakes — especially around person identity (common first names get conflated). The corrections system lets you fix these.

```bash
# Run person resolution (matches extraction names to contacts)
python -m corrections persons resolve
python -m corrections persons resolve --dry  # preview first

# Audit for ambiguous names
python -m corrections persons audit

# Add person identities manually
python -m corrections persons add "Jane Smith" --desc "College friend"
python -m corrections persons alias "Jane Smith" "Jane S"

# View a person's profile
python -m corrections persons show "Jane Smith"

# Generate LLM relationship summaries
python -m corrections persons summarize
python -m corrections persons summarize --person "Jane Smith"
python -m corrections persons summarize --dry  # preview cost

# List corrections
python -m corrections list

# Add a correction
python -m corrections add factual_error extraction \
  --target "extraction_relationships.2024-03" \
  --original "Jane is described as a sister" \
  --corrected "Jane is actually a cousin"

# Full report
python -m corrections report
```

## Using the AI (Cursor)

Open this project in Cursor IDE. The file `.cursor/rules/thyself.mdc` provides the AI with:

- Full database schema and query patterns
- Instructions for how to act as a therapist/coach
- How to read session history and corrections
- When and how to insert new corrections

**Before your first session:** Edit `.cursor/rules/thyself.mdc` to replace `{NAME}` with your name and update any details.

**Session flow:**
1. Open Cursor and start a conversation
2. The AI reads session history to pick up context from prior conversations
3. It queries the database to answer questions about your life
4. At the end, it writes a session file capturing key exchanges, corrections, and open questions

Session files are stored in your data directory and serve as the AI's long-term memory across conversations.

---

## Project Structure

```
thyself/                         (this repo — safe to share)
├── .cursor/rules/
│   └── thyself.mdc              # Cursor AI context and instructions
├── .env.example                 # Environment variable template
├── config.py                    # Centralized configuration (reads env vars)
├── requirements.txt             # Python dependencies
│
├── ingest/                      # Data ingestion scripts
│   ├── chatgpt.py               # ChatGPT export → thyself.db
│   ├── gmail.py                 # Gmail API → thyself.db
│   ├── gmail_auth.py            # Gmail API authentication
│   └── import_contacts.py       # macOS Contacts → thyself.db
│
├── extract_whatsapp.py          # WhatsApp databases from iPhone backup
├── import_whatsapp.py           # WhatsApp databases → thyself.db
│
├── extraction/                  # Life extraction pipeline
│   ├── prepare.py               # Assemble token-sized batches from corpus
│   ├── run.py                   # Run extraction via Claude API
│   ├── prompt.py                # System prompts for extraction & synthesis
│   ├── schema.py                # Database schema (all tables)
│   ├── synthesize.py            # Longitudinal synthesis pipeline
│   ├── ingest_results.py        # Extraction JSON → database tables
│   └── ingest_synthesis.py      # Synthesis JSON → database tables
│
├── corrections/                 # Corrections & person resolution
│   ├── manage.py                # CLI for corrections and person identities
│   ├── resolve_persons.py       # Match extraction names to contacts
│   ├── apply_approved_merges.py # Apply reviewed person merges
│   └── summarize_relationships.py # Generate LLM relationship summaries
│
├── generate_meditation.py       # Generate guided meditation audio
└── make_session_pdf.py          # Convert session markdown to PDF

~/Library/Application Support/Thyself/   (your data — never committed)
├── thyself.db                   # Main SQLite database
├── sessions/                    # Session markdown files
├── extraction_results/          # Extraction JSON outputs
├── synthesis_results/           # Synthesis JSON outputs
└── meditations/                 # Generated meditation audio
```

## Database Schema

The database has three layers:

### Raw Data
- `messages` — iMessage + WhatsApp messages
- `chatgpt_messages` / `chatgpt_conversations` — ChatGPT conversations
- `gmail_messages` — Gmail emails
- `contacts` / `contact_aliases` — Contact registry
- `conversations` / `conversation_participants` — Conversation metadata

### Extraction (Pass 1)
- `extraction_months` — Monthly summaries with emotional state
- `extraction_episodes` — Life events and situations
- `extraction_relationships` — Relationship observations per period
- `extraction_themes` — Recurring preoccupations
- `extraction_decisions` — Decisions and inflection points
- `extraction_tensions` — Contradictions within a period
- `extraction_absences` — Conspicuous silences
- `extraction_observations` — Raw observations
- `extraction_people` — People roster per period

### Synthesis (Pass 2)
- `life_chapters` — Major life periods
- `relationship_arcs` — Relationship trajectories
- `theme_evolution` — Theme tracking across time
- `turning_points` — Significant inflection moments
- `recurring_patterns` — Behavioral/emotional patterns
- `synthesis_contradictions` — Persistent contradictions
- `person_portrait` — Character portrait

### Corrections
- `person_identities` — Canonical person registry
- `person_aliases` — Name variant mappings
- `corrections` — Manual corrections to extraction/synthesis

## Full Pipeline (end-to-end)

```bash
# 1. Set up
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env  # add your keys and name

# 2. Create database schema
python -m extraction.schema

# 3. Ingest your data (run whichever sources you have)
python -m ingest.chatgpt /path/to/chatgpt-export
python -m ingest.import_contacts
cd ingest && python gmail.py && cd ..
export WA_BACKUP_PW="..." && python extract_whatsapp.py && python import_whatsapp.py

# 4. Preview and run extraction
python -m extraction.prepare --batches
python -m extraction.run

# 5. Ingest extraction results
python -m extraction.ingest_results

# 6. Run synthesis
python -m extraction.synthesize

# 7. Ingest synthesis results
python -m extraction.ingest_synthesis

# 8. Resolve persons
python -m corrections persons resolve

# 9. Generate relationship summaries
python -m corrections persons summarize --dry   # preview cost
python -m corrections persons summarize

# 10. Open in Cursor and start talking to your AI
```

## Important Notes

- **Privacy:** All personal data is stored in your data directory (`~/Library/Application Support/Thyself/` by default), completely separate from this code repository. Never commit your `.env` file.
- **Dataset limitations:** The corpus only covers text-based communication. Spoken conversations, in-person interactions, phone/video calls, and inner experience are invisible. Absence from the dataset does not mean absence from your life.
- **Extraction errors:** The AI will make mistakes — especially conflating people with similar names. The corrections system exists for this. Review the output and correct as you go.
- **Not therapy:** This is a self-reflection tool, not a substitute for professional mental health care. If you are in crisis, contact your local crisis line.
