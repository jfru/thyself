# Security Policy

## The Stakes

Thyself processes the most personal data a person has — years of private messages, emails, and conversations. A security vulnerability in this project isn't an abstract risk; it's a direct threat to someone's privacy and emotional safety. We take this seriously.

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Instead, please report them privately:

- **Email:** security@thyself.fyi
- **Subject line:** `[SECURITY] Brief description`

Include:
- A description of the vulnerability
- Steps to reproduce (if applicable)
- The potential impact
- Any suggested fix (if you have one)

## Response Timeline

- **Acknowledgment** within 48 hours
- **Initial assessment** within 1 week
- **Fix or mitigation** as quickly as possible, prioritized by severity

We will credit you in the release notes (unless you prefer to remain anonymous).

## Scope

The following are in scope:

- The Thyself desktop application (`app/`)
- The data pipeline scripts (`sync/`, `ingest/`, `extraction/`)
- The splash website (`splash/`)
- Any configuration or code that could lead to unintended data exposure

The following are out of scope:

- Vulnerabilities in third-party dependencies (report those upstream, but let us know so we can update)
- Issues requiring physical access to the user's machine (the local-first architecture assumes the user's machine is trusted)
- Social engineering attacks

## Architecture and Privacy Guarantees

Thyself's security model is built on these principles:

1. **Local-first** — all user data (database, sessions, extraction results) is stored on the user's own machine. The application never transmits user data to Thyself servers.
2. **Zero data retention** — AI API calls are made through providers operating under zero data retention agreements. User data is processed and immediately deleted by the provider.
3. **No telemetry on personal data** — only anonymized usage metrics (feature usage, session counts) may be collected. Never message content, database contents, or personal information.

Any change that weakens these guarantees is a security issue and should be reported.

## Supported Versions

We currently support only the latest release. Security fixes will not be backported to older versions.
