"""
Gmail ingestion pipeline for thyself.

Filtering strategy (cheapest to most expensive):
1. Gmail query pre-filter — exclude promotions/social via query operators
2. Heuristic filters — no-reply addresses, List-Unsubscribe, bulk sender domains,
   Precedence headers, mailing list headers
3. Content filter — skip emails with no meaningful text body
4. (Future) LLM classification pass for borderline cases

Contact matching is used as a signal boost (not a gate) since iMessage/WhatsApp
contacts rarely have email addresses stored.
"""

import base64
import json
import re
import sqlite3
import time
from datetime import datetime, timezone
from email.utils import parseaddr
from pathlib import Path
from typing import Optional

from gmail_auth import get_gmail_service

from config import DATA_DIR, DB_PATH, MY_EMAIL

NOREPLY_PATTERNS = re.compile(
    r"(^no-?reply|^noreply|^do-?not-?reply|^mailer-daemon|^postmaster"
    r"|^notifications?$|^alerts?$|^info$|^hello$|^team$"
    r"|^news$|^updates?$|^newsletter$|^digest$|^feedback$"
    r"|^orders?$|^billing$|^receipts?$|^invoices?$"
    r"|^account-?updates?$|^account-?security$|^account-?alerts?$"
    r"|^shipment-?tracking$|^order-?update$|^shipping$|^tracking$"
    r"|^esign$|^e-sign$|^docusign$|^sign$"
    r"|^help$|^service$|^confirm$|^verify$"
    r"|^player$|^zmail$|^vip$"
    r"|^upcoming-invoice$|^callmeback$|^powerautomate$"
    r"|^idfraud.*$|^onlinestatements$|^onlineservices$"
    r"|.*_trustee$|.*_admin$|.*_change_name$"
    r"|.*support$|.*noreply$|.*no-reply$|.*no_reply$|.*no\.reply$)",
    re.IGNORECASE,
)

BULK_SENDER_DOMAINS = {
    "accounts.google.com",
    "notifications.google.com",
    "calendar.google.com",
    "github.com",
    "facebookmail.com",
    "linkedin.com",
    "twitter.com",
    "x.com",
    "amazonses.com",
    "amazon.com",
    "sendgrid.net",
    "mailchimp.com",
    "mandrillapp.com",
    "postmarkapp.com",
    "mailgun.org",
    "constantcontact.com",
    "hubspot.com",
    "intercom-mail.com",
    "stripe.com",
    "paypal.com",
    "venmo.com",
    "uber.com",
    "lyft.com",
    "doordash.com",
    "grubhub.com",
    "yelp.com",
    "glassdoor.com",
    "indeed.com",
    "slack.com",
    "notion.so",
    "atlassian.net",
    "zoom.us",
    "calendly.com",
    "shopify.com",
    "squarespace.com",
    "wix.com",
    "medium.com",
    "substack.com",
    "quora.com",
    "reddit.com",
    "pinterest.com",
    "spotify.com",
    "apple.com",
    "id.apple.com",
    "netflix.com",
    "hulu.com",
    "airbnb.com",
    "booking.com",
    "expedia.com",
    "chase.com",
    "bankofamerica.com",
    "capitalone.com",
    "citi.com",
    "mint.com",
    "robinhood.com",
    "etrade.com",
    "fidelity.com",
    "schwab.com",
    "vanguard.com",
    "docusign.net",
    "dropbox.com",
    "evernote.com",
    "grammarly.com",
    "trello.com",
    "figma.com",
    "canva.com",
    "eventbrite.com",
    "meetup.com",
    "anthropic.com",
    "openai.com",
    "tavily.com",
    "united.com",
    "delta.com",
    "aa.com",
    "southwest.com",
    "jetblue.com",
    "britishairways.com",
    "virginatlantic.com",
    "google.com",
    "googleusercontent.com",
    "wayfair.com",
    "resy.com",
    "vectorizer.ai",
    "instacart.com",
    "seamless.com",
    "postmates.com",
    "taskrabbit.com",
    "thumbtack.com",
    "yelp.com",
    "opentable.com",
    "toast-restaurant.com",
    "amazon.co.uk",
    "amazon.de",
    "amazon.fr",
    "amazon.co.jp",
    "sevenrooms.com",
    "jpmorgan.com",
    "chaseonline.com",
    "aexp.com",
    "americanexpress.com",
    "atlassian.com",
    "citi.com",
    "citibank.com",
    "discover.com",
    "barclays.com",
    "barclaycard.co.uk",
    "hsbc.com",
    "hsbc.co.uk",
    "natwest.com",
    "lloydsbank.co.uk",
    "shazam.com",
    "axa.com",
    "national-lottery.co.uk",
    "zocdoc.com",
    "mail.zillow.com",
    "zillow.com",
    "runwayml.com",
    "renewhome.com",
    "wework.com",
    "danielpatrick.net",
    "audible.com",
    "jpmchase.com",
    "cantab.net",
    "email-currencyfair.com",
    "arkmedia.org",
    "lahsa.org",
    "gdx.net",
    "quilter.com",
}

TRANSACTIONAL_SUBJECT_PATTERNS = re.compile(
    r"(your (receipt|invoice|order|payment|subscription|statement|confirmation)"
    r"|receipt from|order confirm|payment confirm|billing statement"
    r"|password reset|verify your|confirm your (email|account)"
    r"|security alert|sign-?in|log-?in (attempt|notification)"
    r"|two-factor|2fa|verification code"
    r"|welcome to \w+|activate your|getting started with)",
    re.IGNORECASE,
)

# Gmail query that pre-filters at the API level to reduce fetches.
# Excludes promotions, social notifications, and common automated senders.
DEFAULT_QUERY = (
    "-{unsubscribe} "
    "-from:noreply -from:no-reply -from:donotreply "
    "-from:notifications@ -from:alerts@ -from:mailer-daemon "
    "-label:spam -label:trash "
)


def is_noreply(addr: str) -> bool:
    local_part = addr.split("@")[0] if "@" in addr else addr
    return bool(NOREPLY_PATTERNS.match(local_part))


def is_bulk_sender(addr: str) -> bool:
    if "@" not in addr:
        return False
    domain = addr.split("@")[1].lower()
    return any(domain == bulk or domain.endswith("." + bulk) for bulk in BULK_SENDER_DOMAINS)


def extract_email_addresses(header_value: str) -> list[str]:
    """Parse a header like 'Name <email>' or 'a@b.com, c@d.com' into addresses."""
    if not header_value:
        return []
    addresses = []
    for part in header_value.split(","):
        _, addr = parseaddr(part.strip())
        if addr:
            addresses.append(addr.lower().strip())
    return addresses


def extract_text_body(payload: dict) -> str:
    """Recursively extract plain text body from Gmail message payload."""
    mime = payload.get("mimeType", "")

    if mime == "text/plain":
        data = payload.get("body", {}).get("data", "")
        if data:
            return base64.urlsafe_b64decode(data).decode("utf-8", errors="replace")

    for part in payload.get("parts", []):
        if part.get("mimeType") == "text/plain":
            data = part.get("body", {}).get("data", "")
            if data:
                return base64.urlsafe_b64decode(data).decode("utf-8", errors="replace")

        if part.get("mimeType", "").startswith("multipart/"):
            text = extract_text_body(part)
            if text:
                return text

    return ""


def get_header(headers: list[dict], name: str) -> str:
    for h in headers:
        if h["name"].lower() == name.lower():
            return h.get("value", "")
    return ""


def has_mailing_list_headers(headers: list[dict]) -> bool:
    """Check for headers that indicate mailing lists or automated mail."""
    list_headers = [
        "list-unsubscribe",
        "list-id",
        "list-post",
        "list-archive",
        "x-mailer",
        "x-campaign",
        "x-mailgun-variables",
        "x-sg-eid",  # SendGrid
        "x-mc-user",  # Mailchimp
    ]
    header_names = {h["name"].lower() for h in headers}
    return any(lh in header_names for lh in list_headers)


def is_transactional_subject(subject: str) -> bool:
    return bool(TRANSACTIONAL_SUBJECT_PATTERNS.search(subject))


def passes_heuristic_filters(headers: list[dict], from_addr: str) -> bool:
    """Return True if the email looks like personal correspondence."""
    if is_noreply(from_addr):
        return False
    if is_bulk_sender(from_addr):
        return False
    if has_mailing_list_headers(headers):
        return False
    precedence = get_header(headers, "Precedence")
    if precedence.lower() in ("bulk", "list", "junk"):
        return False
    auto_submitted = get_header(headers, "Auto-Submitted")
    if auto_submitted and auto_submitted.lower() != "no":
        return False
    subject = get_header(headers, "Subject")
    if is_transactional_subject(subject):
        return False
    return True


class GmailIngester:
    def __init__(self, db_path: Path = DB_PATH):
        self.service = get_gmail_service()
        self.db_path = db_path
        self.my_email = MY_EMAIL
        self.stats = {
            "fetched": 0,
            "passed_heuristic": 0,
            "passed_content": 0,
            "ingested": 0,
            "skipped_duplicate": 0,
            "errors": 0,
        }

    def _ensure_db(self):
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(self.db_path)
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS gmail_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                gmail_id TEXT UNIQUE NOT NULL,
                thread_id TEXT NOT NULL,
                subject TEXT,
                from_addr TEXT,
                from_name TEXT,
                to_addrs TEXT,       -- JSON array
                cc_addrs TEXT,       -- JSON array
                bcc_addrs TEXT,      -- JSON array
                sent_at DATETIME,
                received_at DATETIME,
                body_text TEXT,
                word_count INTEGER,
                is_from_me BOOLEAN,
                labels TEXT,         -- JSON array
                snippet TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );

            CREATE INDEX IF NOT EXISTS idx_gmail_thread ON gmail_messages(thread_id);
            CREATE INDEX IF NOT EXISTS idx_gmail_sent ON gmail_messages(sent_at);
            CREATE INDEX IF NOT EXISTS idx_gmail_from ON gmail_messages(from_addr);
        """)
        conn.close()

    def _already_ingested(self, conn: sqlite3.Connection, gmail_id: str) -> bool:
        row = conn.execute(
            "SELECT 1 FROM gmail_messages WHERE gmail_id = ?", (gmail_id,)
        ).fetchone()
        return row is not None

    def fetch_message_ids(
        self,
        query: str,
        max_results: Optional[int] = None,
    ) -> list[dict]:
        message_ids = []
        page_token = None

        while True:
            batch_size = min(500, max_results - len(message_ids)) if max_results else 500
            result = (
                self.service.users()
                .messages()
                .list(
                    userId="me",
                    q=query,
                    maxResults=batch_size,
                    pageToken=page_token,
                )
                .execute()
            )

            messages = result.get("messages", [])
            message_ids.extend(messages)

            if max_results and len(message_ids) >= max_results:
                message_ids = message_ids[:max_results]
                break

            page_token = result.get("nextPageToken")
            if not page_token:
                break

        return message_ids

    def fetch_and_filter_message(self, msg_stub: dict, conn: sqlite3.Connection) -> Optional[dict]:
        gmail_id = msg_stub["id"]
        self.stats["fetched"] += 1

        if self._already_ingested(conn, gmail_id):
            self.stats["skipped_duplicate"] += 1
            return None

        try:
            msg = (
                self.service.users()
                .messages()
                .get(userId="me", id=gmail_id, format="full")
                .execute()
            )
        except Exception as e:
            print(f"  Error fetching {gmail_id}: {e}")
            self.stats["errors"] += 1
            return None

        headers = msg.get("payload", {}).get("headers", [])
        from_raw = get_header(headers, "From")
        from_name, from_addr = parseaddr(from_raw)
        from_addr = from_addr.lower().strip()

        to_raw = get_header(headers, "To")
        cc_raw = get_header(headers, "Cc")
        bcc_raw = get_header(headers, "Bcc")

        to_addrs = extract_email_addresses(to_raw)
        cc_addrs = extract_email_addresses(cc_raw)
        bcc_addrs = extract_email_addresses(bcc_raw)

        if not passes_heuristic_filters(headers, from_addr):
            return None
        self.stats["passed_heuristic"] += 1

        body = extract_text_body(msg.get("payload", {}))
        if not body or len(body.strip()) < 20:
            return None
        self.stats["passed_content"] += 1

        subject = get_header(headers, "Subject")
        internal_date_ms = int(msg.get("internalDate", 0))
        sent_at = datetime.fromtimestamp(internal_date_ms / 1000, tz=timezone.utc)

        is_from_me = from_addr == self.my_email
        labels = msg.get("labelIds", [])
        snippet = msg.get("snippet", "")
        word_count = len(body.split())

        return {
            "gmail_id": gmail_id,
            "thread_id": msg.get("threadId", ""),
            "subject": subject,
            "from_addr": from_addr,
            "from_name": from_name,
            "to_addrs": json.dumps(to_addrs),
            "cc_addrs": json.dumps(cc_addrs),
            "bcc_addrs": json.dumps(bcc_addrs),
            "sent_at": sent_at.isoformat(),
            "received_at": sent_at.isoformat(),
            "body_text": body,
            "word_count": word_count,
            "is_from_me": is_from_me,
            "labels": json.dumps(labels),
            "snippet": snippet,
        }

    def ingest(
        self,
        query: str,
        max_results: Optional[int] = None,
        batch_log_interval: int = 50,
    ):
        self._ensure_db()
        conn = sqlite3.connect(self.db_path)

        print(f"Fetching message IDs with query: {query}")
        msg_stubs = self.fetch_message_ids(query=query, max_results=max_results)
        print(f"Found {len(msg_stubs)} messages to process")

        for i, stub in enumerate(msg_stubs):
            parsed = self.fetch_and_filter_message(stub, conn)

            if parsed:
                try:
                    conn.execute(
                        """INSERT OR IGNORE INTO gmail_messages
                           (gmail_id, thread_id, subject, from_addr, from_name,
                            to_addrs, cc_addrs, bcc_addrs, sent_at, received_at,
                            body_text, word_count, is_from_me, labels, snippet)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                        (
                            parsed["gmail_id"],
                            parsed["thread_id"],
                            parsed["subject"],
                            parsed["from_addr"],
                            parsed["from_name"],
                            parsed["to_addrs"],
                            parsed["cc_addrs"],
                            parsed["bcc_addrs"],
                            parsed["sent_at"],
                            parsed["received_at"],
                            parsed["body_text"],
                            parsed["word_count"],
                            parsed["is_from_me"],
                            parsed["labels"],
                            parsed["snippet"],
                        ),
                    )
                    self.stats["ingested"] += 1
                except Exception as e:
                    print(f"  DB error for {parsed['gmail_id']}: {e}")
                    self.stats["errors"] += 1

            if (i + 1) % batch_log_interval == 0:
                conn.commit()
                self._print_stats(i + 1, len(msg_stubs))

            if self.stats["fetched"] % 50 == 0:
                time.sleep(1)

        conn.commit()
        conn.close()
        self._print_stats(len(msg_stubs), len(msg_stubs), final=True)

    def _print_stats(self, processed: int, total: int, final: bool = False):
        label = "FINAL" if final else "Progress"
        s = self.stats
        print(
            f"[{label}] {processed}/{total} | "
            f"fetched={s['fetched']} heuristic_pass={s['passed_heuristic']} "
            f"content_pass={s['passed_content']} ingested={s['ingested']} "
            f"dup={s['skipped_duplicate']} err={s['errors']}"
        )


def main():
    import argparse

    parser = argparse.ArgumentParser(description="Gmail ingestion for thyself")
    parser.add_argument(
        "--query",
        default=DEFAULT_QUERY,
        help="Gmail search query (default: pre-filtered for personal mail)",
    )
    parser.add_argument(
        "--max",
        type=int,
        default=None,
        help="Max messages to process (default: all)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Only fetch IDs and show count, don't ingest",
    )
    args = parser.parse_args()

    ingester = GmailIngester()

    if args.dry_run:
        ids = ingester.fetch_message_ids(query=args.query, max_results=args.max)
        print(f"Dry run: {len(ids)} messages match query '{args.query}'")
        return

    ingester.ingest(query=args.query, max_results=args.max)


if __name__ == "__main__":
    main()
