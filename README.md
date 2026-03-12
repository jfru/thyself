# Thyself (Mac App)

Thyself is a Tauri v2 + React desktop app for deeply contextual AI conversations grounded in your own life data (iMessage, WhatsApp, Gmail, ChatGPT exports, and session history).

The app has the full user flow: onboarding, profile management, source setup, sync visibility, chat sessions, and long-term memory files.

## What It Does

- Runs as a native macOS desktop app with a React UI and Rust backend.
- Stores data per profile (database, sessions, extraction artifacts) under `~/Library/Application Support/Thyself/`.
- Streams Claude responses in-app with tool-use loops against local data.
- Guides setup in a dedicated `Setup` session when no message history exists yet.
- Tracks source connection/sync health and supports adding/removing sources from the UI.

## Current Architecture

```
app/
├── src/                          # React frontend (TypeScript + Vite + Tailwind)
│   ├── App.tsx                   # App shell, onboarding phases, session orchestration
│   ├── components/               # Chat, sidebar, onboarding, source status UI
│   ├── hooks/useStreamChat.ts    # Streaming chat state machine and event handling
│   └── lib/tauriBridge.ts        # Tauri IPC in-app, HTTP bridge in browser
│
├── src-tauri/                    # Rust backend
│   ├── src/lib.rs                # Tauri startup, env loading, command wiring
│   ├── src/commands.rs           # IPC command handlers and chat loop entrypoint
│   ├── src/tools.rs              # Tool definitions + execution
│   ├── src/profiles.rs           # Multi-profile storage and migration
│   ├── src/sessions.rs           # Session manifest + summary file handling
│   └── src/dev_server.rs         # Debug HTTP bridge for browser-based testing
│
└── package.json                  # Frontend + Tauri scripts
```

## Quick Start (Local Development)

### 1) Prerequisites

- macOS
- Node.js 20+
- Rust (stable toolchain)
- `npm`
- Anthropic API key
- Python 3.10+ (required for sync/ingestion scripts in `sync/`, `ingest/`, `extraction/`)

### 2) Install dependencies

```bash
git clone <this-repo>
cd thyself
cd app && npm install
cd ..
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

### 3) Configure environment (optional for app onboarding)

```bash
cp .env.example .env
```

For the Mac app flow, API key and name are collected in onboarding and saved per profile.

Use `.env` values mainly as defaults/fallbacks (and for Python scripts). Most useful:

```bash
ANTHROPIC_API_KEY=sk-ant-...
THYSELF_SUBJECT_NAME=YourName
THYSELF_EMAIL=you@gmail.com
```

- `ANTHROPIC_API_KEY`: fallback key used by legacy migration and Python pipelines.
- `THYSELF_SUBJECT_NAME`: fallback display/subject name for legacy migration.
- `THYSELF_EMAIL`: used by Gmail ingestion/sync scripts to detect `is_from_me`.

### 4) Run the app

```bash
cd app
npm run tauri dev
```

This starts:
- Vite frontend on `http://localhost:1420`
- Tauri desktop shell
- Debug-only HTTP bridge on `http://localhost:3001` (spawned by the Rust backend)

## Browser Testing Mode (No Native Shell)

For automation and UI debugging, open `http://localhost:1420` in a regular browser while `npm run tauri dev` is running.

The frontend detects non-Tauri runtime and routes commands to the debug server (`http://localhost:3001/api/*`) via `tauriBridge`.

Useful endpoints:
- `GET /api/health`
- `POST /api/query_db`
- `POST /api/stream_chat` (SSE)
- `GET /api/tool_defs`

## Build and Release

Build a local production app:

```bash
cd app
npm run tauri build
```

CI release packaging is handled by `.github/workflows/release.yml` on pushes to `main`.

## Data Layout and Privacy

User data is stored outside this repo (default: `~/Library/Application Support/Thyself`):

```
~/Library/Application Support/Thyself/
├── profiles.json                 # Profile registry
├── active_profile                # Active profile id
└── profiles/
    └── <profile-id>/
        ├── thyself.db
        ├── sessions/
        │   ├── sessions.json
        │   └── session_*.md
        ├── extraction_results/
        └── synthesis_results/
```

Never commit `.env` or any files from your application support directory.

## Repo Layout (Top-Level)

- `app/`: Mac app (Tauri + React) and primary user experience.
- `sync/`: Source sync orchestrators and launchd install helper.
- `ingest/`: Source-specific ingestion scripts.
- `extraction/`: Pass 1 extraction + Pass 2 synthesis pipelines.
- `corrections/`: Person resolution and correction tooling.

## Sync + Data Pipelines (Advanced / Internal)

These scripts still power the data layer and can be run independently:

```bash
# Weekly sync orchestrator
python sync/run.py

# Run one source only
python sync/run.py --source gmail

# Install scheduled weekly sync (launchd)
python sync/install.py install
python sync/install.py status
```

Other commonly used scripts:

- `python -m ingest.chatgpt /path/to/export`
- `python -m ingest.import_contacts`
- `python extraction/run.py`
- `python extraction/synthesize.py`
- `python -m corrections`

## Notes

- Thyself is a self-reflection tool, not a replacement for professional mental health care.
- Dataset coverage is partial (mostly text-based communications), so absence in data is not absence in real life.
