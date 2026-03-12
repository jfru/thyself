"""
Standalone Gmail OAuth authentication script.

Called by the Tauri backend to run the OAuth flow or check auth status.

Usage:
  python3 sync/gmail_authenticate.py --check            # check if authenticated
  python3 sync/gmail_authenticate.py --auth              # run interactive OAuth flow
  python3 sync/gmail_authenticate.py --setup-gcloud      # set up via gcloud CLI
  python3 sync/gmail_authenticate.py --find-downloaded   # find client_secret in ~/Downloads

Outputs JSON to stdout.
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "ingest"))

from gmail_auth import (
    authenticate,
    check_auth_status,
    check_gcloud_available,
    find_downloaded_client_secret,
    setup_via_gcloud,
)


def main():
    import argparse

    parser = argparse.ArgumentParser()
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--check", action="store_true", help="Check auth status")
    group.add_argument("--auth", action="store_true", help="Run OAuth flow")
    group.add_argument("--setup-gcloud", action="store_true",
                       help="Set up Gmail via gcloud CLI")
    group.add_argument("--find-downloaded", action="store_true",
                       help="Find client_secret*.json in ~/Downloads and install it")
    args = parser.parse_args()

    try:
        if args.check:
            result = check_auth_status()
            result["gcloud"] = check_gcloud_available()
            print(json.dumps(result))

        elif args.setup_gcloud:
            result = setup_via_gcloud()
            print(json.dumps(result))

        elif args.find_downloaded:
            result = find_downloaded_client_secret()
            print(json.dumps(result))

        else:
            status = check_auth_status()
            if status["status"] == "authenticated":
                print(json.dumps(status))
                return

            if status["status"] == "needs_client_secret":
                print(json.dumps(status))
                sys.exit(1)

            creds = authenticate(interactive=True)
            result = check_auth_status()
            print(json.dumps(result))

    except FileNotFoundError as e:
        print(json.dumps({"status": "needs_client_secret", "message": str(e)}))
        sys.exit(1)
    except Exception as e:
        print(json.dumps({"status": "error", "message": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
