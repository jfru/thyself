"""
Gmail API authentication via OAuth2 installed-app flow.

Token lifecycle:
  1. Look for saved token at $THYSELF_DATA_DIR/gmail_token.json
  2. If valid → use it.  If expired → refresh it.
  3. If no token → run InstalledAppFlow (opens browser for Google sign-in).
  4. Save the new/refreshed token back to gmail_token.json.

Client credentials (checked in order):
  1. gmail_client_secret.json in project root or $THYSELF_DATA_DIR
  2. Embedded client credentials (_EMBEDDED_CLIENT_ID / _EMBEDDED_CLIENT_SECRET)

Falls back to Application Default Credentials (gcloud CLI) when no
OAuth token or client credentials are available.
"""

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build

SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"]

_HERE = Path(__file__).resolve().parent
_PROJECT_ROOT = _HERE.parent

# Developer-embedded OAuth Desktop credentials.
# Once created in Google Cloud Console, paste the client_id and client_secret
# here so users never need to touch the GCP console.
_EMBEDDED_CLIENT_ID = ""
_EMBEDDED_CLIENT_SECRET = ""


def _data_dir() -> Path:
    d = os.environ.get("THYSELF_DATA_DIR")
    if d:
        return Path(d)
    return Path.home() / "Library" / "Application Support" / "Thyself"


def _find_client_secret() -> Path | None:
    """Search project root then data dir for gmail_client_secret.json."""
    for parent in [_PROJECT_ROOT, _data_dir()]:
        p = parent / "gmail_client_secret.json"
        if p.exists():
            return p
    return None


def _embedded_client_config() -> dict | None:
    """Return an InstalledAppFlow-compatible config dict from embedded creds."""
    if not _EMBEDDED_CLIENT_ID or not _EMBEDDED_CLIENT_SECRET:
        return None
    return {
        "installed": {
            "client_id": _EMBEDDED_CLIENT_ID,
            "client_secret": _EMBEDDED_CLIENT_SECRET,
            "auth_uri": "https://accounts.google.com/o/oauth2/auth",
            "token_uri": "https://oauth2.googleapis.com/token",
            "redirect_uris": ["http://localhost"],
        }
    }


def _token_path() -> Path:
    return _data_dir() / "gmail_token.json"


def _load_saved_token() -> Credentials | None:
    tp = _token_path()
    if not tp.exists():
        return None
    try:
        return Credentials.from_authorized_user_file(str(tp), SCOPES)
    except Exception:
        return None


def _save_token(creds: Credentials) -> None:
    tp = _token_path()
    tp.parent.mkdir(parents=True, exist_ok=True)
    tp.write_text(creds.to_json())


def _try_adc():
    """Try Application Default Credentials (gcloud CLI) as a fallback."""
    try:
        import google.auth
        credentials, _project = google.auth.default(scopes=SCOPES)
        if credentials.expired and credentials.refresh_token:
            credentials.refresh(Request())
        return credentials
    except Exception:
        return None


def _has_client_credentials() -> bool:
    """Check whether any form of client credentials is available."""
    return _find_client_secret() is not None or _embedded_client_config() is not None


def _create_oauth_flow() -> InstalledAppFlow | None:
    """Build an InstalledAppFlow from file-based or embedded credentials."""
    path = _find_client_secret()
    if path is not None:
        return InstalledAppFlow.from_client_secrets_file(str(path), SCOPES)
    cfg = _embedded_client_config()
    if cfg is not None:
        return InstalledAppFlow.from_client_config(cfg, SCOPES)
    return None


def authenticate(interactive: bool = True) -> Credentials:
    """Get valid Gmail credentials, running OAuth if needed.

    Priority: saved OAuth token → ADC (gcloud) → interactive OAuth flow.

    Args:
        interactive: If True, will open browser for OAuth when no saved
                     token exists. If False, raises when auth is needed.
    """
    creds = _load_saved_token()

    if creds and creds.valid:
        return creds

    if creds and creds.expired and creds.refresh_token:
        try:
            creds.refresh(Request())
            _save_token(creds)
            return creds
        except Exception:
            pass  # token revoked or refresh failed — need re-auth

    adc = _try_adc()
    if adc is not None:
        return adc

    if not interactive:
        raise RuntimeError("no_valid_credentials")

    flow = _create_oauth_flow()
    if flow is None:
        raise FileNotFoundError("no_client_secret")

    creds = flow.run_local_server(
        port=0,
        prompt="consent",
        access_type="offline",
    )
    _save_token(creds)
    return creds


def check_auth_status() -> dict:
    """Return a status dict describing the current Gmail auth state.

    Possible statuses:
      - authenticated: valid token exists (includes email if available)
      - authenticated_adc: using gcloud Application Default Credentials
      - needs_auth: client credentials exist but user hasn't signed in
      - needs_client_secret: no credentials available at all
    """
    creds = _load_saved_token()

    if creds and creds.valid:
        return {"status": "authenticated", "email": _get_email(creds)}

    if creds and creds.expired and creds.refresh_token:
        try:
            creds.refresh(Request())
            _save_token(creds)
            return {"status": "authenticated", "email": _get_email(creds)}
        except Exception:
            pass

    adc = _try_adc()
    if adc is not None:
        return {"status": "authenticated_adc", "email": _get_email(adc)}

    if _has_client_credentials():
        return {"status": "needs_auth"}

    return {"status": "needs_client_secret"}


def check_gcloud_available() -> dict:
    """Check if gcloud CLI is installed and return its path."""
    gcloud_path = shutil.which("gcloud")
    if gcloud_path is None:
        return {"installed": False}
    try:
        result = subprocess.run(
            [gcloud_path, "config", "get-value", "project"],
            capture_output=True, text=True, timeout=10,
        )
        project = result.stdout.strip() if result.returncode == 0 else None
    except Exception:
        project = None
    return {"installed": True, "path": gcloud_path, "project": project}


def setup_via_gcloud() -> dict:
    """Try to set up Gmail access using gcloud CLI.

    Runs `gcloud auth application-default login` with gmail.readonly scope.
    This opens the user's browser for Google sign-in and saves ADC locally.
    """
    info = check_gcloud_available()
    if not info["installed"]:
        return {"status": "gcloud_not_found"}

    gcloud = info["path"]

    try:
        result = subprocess.run(
            [
                gcloud, "auth", "application-default", "login",
                "--scopes=https://www.googleapis.com/auth/gmail.readonly,"
                "https://www.googleapis.com/auth/userinfo.email",
                "--quiet",
            ],
            capture_output=True, text=True, timeout=300,
        )
        if result.returncode == 0:
            adc = _try_adc()
            if adc is not None:
                email = _get_email(adc)
                return {"status": "authenticated_adc", "email": email}
            return {"status": "adc_saved_but_untested"}
        return {
            "status": "gcloud_auth_failed",
            "error": result.stderr.strip() or result.stdout.strip(),
        }
    except subprocess.TimeoutExpired:
        return {"status": "timeout"}
    except Exception as e:
        return {"status": "error", "error": str(e)}


def find_downloaded_client_secret() -> dict:
    """Look in ~/Downloads for a recently downloaded client_secret*.json."""
    downloads = Path.home() / "Downloads"
    if not downloads.exists():
        return {"status": "not_found"}

    candidates = []
    for f in downloads.iterdir():
        if f.name.startswith("client_secret") and f.suffix == ".json":
            try:
                data = json.loads(f.read_text())
                if "installed" in data or "web" in data:
                    candidates.append((f, f.stat().st_mtime))
            except Exception:
                continue

    if not candidates:
        return {"status": "not_found"}

    candidates.sort(key=lambda x: x[1], reverse=True)
    best = candidates[0][0]

    dest = _data_dir() / "gmail_client_secret.json"
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(str(best), str(dest))

    return {
        "status": "found_and_installed",
        "source_path": str(best),
        "installed_path": str(dest),
    }


def _get_email(creds: Credentials) -> str | None:
    """Best-effort fetch of the authenticated email address."""
    try:
        svc = build("gmail", "v1", credentials=creds)
        profile = svc.users().getProfile(userId="me").execute()
        return profile.get("emailAddress")
    except Exception:
        return None


def get_gmail_service():
    """Build and return an authenticated Gmail API service."""
    creds = authenticate()
    return build("gmail", "v1", credentials=creds)


if __name__ == "__main__":
    status = check_auth_status()
    print(f"Auth status: {json.dumps(status)}")

    if status["status"] == "authenticated":
        print("Already authenticated.")
    elif status["status"] == "needs_client_secret":
        print("No gmail_client_secret.json found. See README for setup.")
        sys.exit(1)
    else:
        print("Running OAuth flow...")
        creds = authenticate()
        svc = build("gmail", "v1", credentials=creds)
        profile = svc.users().getProfile(userId="me").execute()
        print(f"Authenticated as: {profile['emailAddress']}")
