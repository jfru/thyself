# Contributing to Thyself

Thyself is a source-available project. The code is public, contributions are welcome, and **contributors share in the revenue the product generates.**

This document covers how to contribute and the economic model behind it.

---

## The Model

Thyself is not traditional open source. It's a product that pays the people who build it.

- **Source is public** — anyone can read, audit, and study every line of code.
- **Usage requires a subscription** — Thyself is a paid product. The subscription covers AI API costs, product development, and contributor payouts.
- **Contributors get revenue share** — if your code, documentation, bug fix, or design improvement ships in the product, you earn a share of the revenue it generates.
- **Details evolve with the project** — we're a new product. The specific revenue-sharing mechanism (tracking, weighting, payout frequency) will be established transparently as the contributor community grows. Early contributors are building on trust, and that trust will be honored.

This is the commitment: **if you create value for Thyself, you share in the value Thyself creates.**

## What You Can Contribute

- **Code** — features, bug fixes, performance improvements, new data source connectors
- **Documentation** — guides, tutorials, architecture docs, inline documentation
- **Design** — UI/UX improvements, accessibility, user research
- **Testing** — bug reports with reproduction steps, test coverage
- **Ideas** — well-considered feature proposals, architectural suggestions

## Getting Started

### Prerequisites

- macOS (the app is a native Mac desktop application)
- Node.js 20+
- Rust (stable toolchain)
- Python 3.10+ (for data pipeline scripts)
- An Anthropic API key

### Setup

```bash
git clone https://github.com/jfru/thyself.git
cd thyself
cd app && npm install && cd ..
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
# Add your ANTHROPIC_API_KEY to .env
```

### Running the App

```bash
cd app
npm run tauri dev
```

This starts the Vite frontend on `http://localhost:1420` and the Tauri desktop shell. A debug HTTP bridge runs on `http://localhost:3001` for browser-based testing.

### Project Structure

- `app/` — Mac app (Tauri v2 + React). This is the primary user experience.
- `sync/` — Source sync orchestrators and scheduling.
- `ingest/` — Data ingestion scripts (iMessage, WhatsApp, ChatGPT, Gmail).
- `extraction/` — Life extraction (Pass 1) and longitudinal synthesis (Pass 2) pipelines.
- `corrections/` — Person resolution and human-in-the-loop correction tooling.
- `splash/` — Marketing website (thyself.fyi).

## How to Submit a Contribution

1. **Fork the repository** and create a branch from `main`.
2. **Make your changes** — keep commits focused and well-described.
3. **Test your changes** — run the app locally, verify nothing is broken.
4. **Open a pull request** against `main` with a clear description of what you changed and why.
5. **Code review** — a maintainer will review your PR. We aim to respond within a few days.

### Guidelines

- Keep PRs focused. One feature or fix per PR.
- Write clear commit messages that explain *why*, not just *what*.
- Don't introduce new dependencies without discussion.
- Respect the existing code style and patterns.
- Never commit `.env` files, API keys, database files, or user data.

## Contributor Agreement

By submitting a pull request, you agree to the following:

1. **You own the work** — your contribution is original or you have the right to submit it.
2. **License grant** — you grant Thyself the right to use, modify, and distribute your contribution as part of the product under the [Thyself Community License](LICENSE).
3. **Revenue sharing eligibility** — accepted contributions make you eligible for revenue sharing. The maintainers will track contributions transparently and establish the payout mechanism as the project grows.
4. **No guarantee of acceptance** — submitting a PR does not guarantee it will be merged.

## Data Privacy in Development

Thyself processes deeply personal data. When contributing:

- **Never include real user data** in PRs, issues, or test fixtures.
- **Use synthetic or anonymized data** for testing.
- **Never log, print, or expose** user data in debug output that could be committed.
- **Respect the local-first architecture** — user data stays on the user's machine.

## Reporting Issues

- Use the GitHub issue templates for bug reports and feature requests.
- For security vulnerabilities, see [SECURITY.md](SECURITY.md).
- For conduct issues, see [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Questions?

Open a discussion on GitHub or reach out at hello@thyself.fyi.
